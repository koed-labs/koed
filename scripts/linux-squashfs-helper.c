/* Experimental standalone inspector. Not a production release gate. */
#include <sqfs/io.h>
#include <sqfs/super.h>
#include <sqfs/compressor.h>
#include <sqfs/dir_reader.h>
#include <sqfs/dir.h>
#include <sqfs/inode.h>
#include <sqfs/data_reader.h>
#include <sqfs/meta_reader.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#define MAX_ENTRIES 100000U
#define MAX_DEPTH 64U
#define MAX_OUTPUT (128U * 1024U * 1024U)
#define REF_SLOTS 262144U

typedef struct { sqfs_inode_generic_t *inode; unsigned depth; int resources; } pending;
typedef struct {
    sqfs_meta_reader_t *dirs, *inodes;
    const sqfs_super_t *super;
    sqfs_u64 dir_end;
    pending *queue;
    unsigned count, next, entries, inode_count;
    unsigned char *seen, *ref_used;
    sqfs_u64 *refs;
    sqfs_inode_generic_t *target;
} walk;

static int remember_ref(walk *w, sqfs_u64 ref) {
    unsigned slot = (unsigned)((ref * UINT64_C(11400714819323198485)) >> 46);
    while (w->ref_used[slot]) {
        if (w->refs[slot] == ref) return -1;
        slot = (slot + 1) & (REF_SLOTS - 1);
    }
    w->ref_used[slot] = 1;
    w->refs[slot] = ref;
    return 0;
}

static int read_inode(walk *w, sqfs_u64 ref, sqfs_inode_generic_t **inode) {
    sqfs_u64 block = ref >> 16;
    if (block >= w->super->directory_table_start - w->super->inode_table_start ||
        (ref & 0xffff) >= 8192) return -1;
    /* libsquashfs 1.2.0 adds inode_table_start internally, despite its header. */
    return sqfs_meta_reader_read_inode(w->inodes, w->super,
        block, (size_t)(ref & 0xffff), inode);
}

static int scan(walk *w, pending dir) {
    sqfs_dir_entry_t *entry = NULL;
    sqfs_readdir_state_t state;
    sqfs_u32 inum;
    sqfs_u64 ref;
    char previous[257] = "";
    if (sqfs_readdir_state_init(&state, w->super, dir.inode) ||
        state.init.block < w->super->directory_table_start ||
        state.init.block >= w->dir_end || state.init.size < 3) return -1;
    size_t remaining = state.init.size - 3;
    while (remaining) {
        size_t header = state.entries == 0 ? 12 : 0;
        if (remaining < header + 9 ||
            sqfs_meta_reader_readdir(w->dirs, &state, &entry, &inum, &ref) != 0) goto bad;
        size_t used = header + 8 + (size_t)entry->size + 1;
        if (used > remaining) goto bad;
        remaining -= used;
        sqfs_inode_generic_t *inode = NULL;
        size_t n = (size_t)entry->size + 1;
        if (++w->entries > MAX_ENTRIES || n > 256 || memchr(entry->name, 0, n) ||
            memchr(entry->name, '/', n)) goto bad;
        char name[257];
        memcpy(name, entry->name, n); name[n] = 0;
        if (!strcmp(name, ".") || !strcmp(name, "..") || strcmp(previous, name) >= 0) goto bad;
        memcpy(previous, name, n + 1);
        int64_t encoded = (int64_t)state.inum_base + entry->inode_diff;
        if (encoded < 1 || encoded > w->inode_count || (sqfs_u32)encoded != inum ||
            remember_ref(w, ref) || read_inode(w, ref, &inode)) goto bad;
        sqfs_u32 xattr;
        if (sqfs_inode_get_xattr_index(inode, &xattr) || xattr != UINT32_MAX) {
            sqfs_free(inode); goto bad;
        }
        unsigned id = inode->base.inode_number;
        unsigned type = inode->base.type;
        /* Directory entries encode the basic form even for extended inodes. */
        if (type >= SQFS_INODE_EXT_DIR && type <= SQFS_INODE_EXT_SOCKET) type -= 7;
        if (entry->type != type || id != inum || !id || id > w->inode_count || w->seen[id]) {
            sqfs_free(inode); goto bad;
        }
        w->seen[id] = 1;
        int isdir = inode->base.type == SQFS_INODE_DIR || inode->base.type == SQFS_INODE_EXT_DIR;
        int isfile = inode->base.type == SQFS_INODE_FILE || inode->base.type == SQFS_INODE_EXT_FILE;
        int resources = dir.depth == 0 && !strcmp(name, "resources");
        int target = dir.resources && !strcmp(name, "app.asar");
        if ((resources && !isdir) || (target && !isfile) ||
            (target && inode->base.type == SQFS_INODE_EXT_FILE && inode->data.file_ext.nlink != 1)) {
            sqfs_free(inode); goto bad;
        }
        if (target) w->target = inode;
        else if (isdir) {
            if (dir.depth >= MAX_DEPTH || w->count >= MAX_ENTRIES) { sqfs_free(inode); goto bad; }
            w->queue[w->count++] = (pending){inode, dir.depth + 1, resources};
        } else sqfs_free(inode);
        sqfs_free(entry); entry = NULL;
    }
    return state.entries == 0 ? 0 : -1;
bad:
    sqfs_free(entry);
    return -1;
}

static int validate_table_block(sqfs_file_t *file, sqfs_compressor_t *cmp,
                                sqfs_u64 ptr, sqfs_u64 next, size_t size) {
    unsigned char buffer[8192];
    sqfs_u64 block;
    size_t offset;
    sqfs_meta_reader_t *reader = sqfs_meta_reader_create(file, cmp, ptr, next);
    if (!reader) return -1;
    int rc = sqfs_meta_reader_seek(reader, ptr, 0) ||
             sqfs_meta_reader_read(reader, buffer, size);
    if (!rc) {
        sqfs_meta_reader_get_position(reader, &block, &offset);
        rc = block != next || offset != 0;
    }
    sqfs_destroy(reader);
    return rc ? -1 : 0;
}

/* Indexed tables store pointers to metadata blocks preceding their indexes. */
static int table_boundary(sqfs_file_t *file, sqfs_compressor_t *cmp, const sqfs_super_t *s,
                          sqfs_u64 index, sqfs_u64 bytes, sqfs_u64 *end,
                          sqfs_u64 *previous_end) {
    sqfs_u64 blocks = (bytes + 8191) / 8192;
    if (!blocks || blocks > 100000 || index < s->directory_table_start ||
        index > s->bytes_used || blocks > (s->bytes_used - index) / 8) return -1;
    sqfs_u64 next = 0;
    for (sqfs_u64 i = 0; i < blocks; i++) {
        unsigned char raw[8], header[2];
        sqfs_u64 ptr = 0;
        if (file->read_at(file, index + i * 8, raw, sizeof(raw))) return -1;
        for (int j = 7; j >= 0; j--) ptr = (ptr << 8) | raw[j];
        if (ptr <= s->directory_table_start || ptr >= index ||
            (i && ptr != next) || (!i && *previous_end && ptr != *previous_end) ||
            file->read_at(file, ptr, header, sizeof(header))) return -1;
        unsigned size = ((unsigned)header[0] | ((unsigned)header[1] << 8)) & 0x7fff;
        if (!size || size > 8192 || index - ptr < 2 || size > index - ptr - 2) return -1;
        next = ptr + 2 + size;
        sqfs_u64 left = bytes - i * 8192;
        size_t decoded = left > 8192 ? 8192 : (size_t)left;
        if (validate_table_block(file, cmp, ptr, next, decoded)) return -1;
        if (ptr < *end) *end = ptr;
    }
    if (next != index) return -1;
    *previous_end = index + blocks * 8;
    return 0;
}

static int directory_end(sqfs_file_t *file, sqfs_compressor_t *cmp,
                         const sqfs_super_t *s, sqfs_u64 *end) {
    sqfs_u64 previous_end = 0;
    *end = s->bytes_used;
    if (s->xattr_id_table_start != UINT64_MAX || !s->id_count) return -1;
    if (s->fragment_entry_count) {
        if (table_boundary(file, cmp, s, s->fragment_table_start,
                           (sqfs_u64)s->fragment_entry_count * 16, end, &previous_end)) return -1;
    } else if (s->fragment_table_start != UINT64_MAX) return -1;
    if (s->export_table_start != UINT64_MAX &&
        table_boundary(file, cmp, s, s->export_table_start,
                       (sqfs_u64)s->inode_count * 8, end, &previous_end)) return -1;
    if (table_boundary(file, cmp, s, s->id_table_start,
                       (sqfs_u64)s->id_count * 4, end, &previous_end)) return -1;
    return *end > s->directory_table_start ? 0 : -1;
}

static int inspect(const char *path, unsigned long limit) {
    int ok = -1;
    sqfs_file_t *file = NULL;
    sqfs_compressor_t *cmp = NULL;
    sqfs_meta_reader_t *dirs = NULL, *inodes = NULL;
    sqfs_data_reader_t *data = NULL;
    sqfs_super_t super;
    sqfs_compressor_config_t cfg;
    walk w = {0};
    unsigned char *output = NULL;
    sqfs_u64 size = 0;
    file = sqfs_open_file(path, SQFS_FILE_OPEN_READ_ONLY);
    if (!file || file->get_size(file) > UINT64_C(4294967296) ||
        sqfs_super_read(&super, file) || super.inode_count > MAX_ENTRIES ||
        super.bytes_used > file->get_size(file) ||
        super.inode_table_start >= super.directory_table_start ||
        super.directory_table_start >= super.bytes_used ||
        sqfs_compressor_config_init(&cfg, super.compression_id, super.block_size, SQFS_COMP_FLAG_UNCOMPRESS) ||
        sqfs_compressor_create(&cfg, &cmp)) goto done;
    if (directory_end(file, cmp, &super, &w.dir_end)) goto done;
    dirs = sqfs_meta_reader_create(file, cmp, super.directory_table_start, w.dir_end);
    inodes = sqfs_meta_reader_create(file, cmp, super.inode_table_start, super.directory_table_start);
    w.dirs = dirs; w.inodes = inodes; w.super = &super;
    w.inode_count = super.inode_count;
    w.queue = calloc(MAX_ENTRIES, sizeof(*w.queue));
    w.seen = calloc(MAX_ENTRIES + 1, 1);
    w.refs = calloc(REF_SLOTS, sizeof(*w.refs));
    w.ref_used = calloc(REF_SLOTS, 1);
    if (!dirs || !inodes || !w.queue || !w.seen || !w.refs || !w.ref_used ||
        remember_ref(&w, super.root_inode_ref) ||
        read_inode(&w, super.root_inode_ref, &w.queue[0].inode)) goto done;
    w.count = 1;
    sqfs_u32 root_xattr;
    if (sqfs_inode_get_xattr_index(w.queue[0].inode, &root_xattr) || root_xattr != UINT32_MAX) goto done;
    if ((w.queue[0].inode->base.type != SQFS_INODE_DIR &&
         w.queue[0].inode->base.type != SQFS_INODE_EXT_DIR) ||
        !w.queue[0].inode->base.inode_number || w.queue[0].inode->base.inode_number > w.inode_count) goto done;
    w.seen[w.queue[0].inode->base.inode_number] = 1;
    while (w.next < w.count) {
        pending p = w.queue[w.next++];
        int rc = scan(&w, p);
        sqfs_free(p.inode);
        if (rc) goto done;
    }
    if (!w.target || sqfs_inode_get_file_size(w.target, &size) || size > limit) goto done;
    data = sqfs_data_reader_create(file, super.block_size, cmp, 0);
    if (!data || sqfs_data_reader_load_fragment_table(data, &super)) goto done;
    output = malloc(size ? (size_t)size : 1);
    if (!output) goto done;
    for (sqfs_u64 pos = 0; pos < size;) {
        sqfs_u32 want = size - pos > 65536 ? 65536 : (sqfs_u32)(size - pos);
        sqfs_s32 got = sqfs_data_reader_read(data, w.target, pos, output + pos, want);
        if (got <= 0 || (sqfs_u32)got > want) goto done;
        pos += (sqfs_u32)got;
    }
    if (fwrite(output, 1, (size_t)size, stdout) != size || fflush(stdout)) goto done;
    ok = 0;
done:
    while (w.next < w.count) sqfs_free(w.queue[w.next++].inode);
    sqfs_free(w.target); free(w.queue); free(w.seen); free(w.refs); free(w.ref_used); free(output);
    sqfs_destroy(data); sqfs_destroy(dirs); sqfs_destroy(inodes); sqfs_destroy(cmp); sqfs_destroy(file);
    return ok;
}

int main(int argc, char **argv) {
    char *end;
    if (argc != 3 || argv[2][0] < '1' || argv[2][0] > '9') {
        fputs("SquashFS inspection failed.\n", stderr);
        return 1;
    }
    errno = 0;
    unsigned long limit = strtoul(argv[2], &end, 10);
    if (errno || *end || !limit || limit > MAX_OUTPUT || inspect(argv[1], limit)) {
        fputs("SquashFS inspection failed.\n", stderr);
        return 1;
    }
    return 0;
}
