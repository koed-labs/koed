/* Experimental standalone inspector. Not a production release gate. */
#include <sqfs/io.h>
#include <sqfs/super.h>
#include <sqfs/compressor.h>
#include <sqfs/dir_reader.h>
#include <sqfs/dir.h>
#include <sqfs/inode.h>
#include <sqfs/data_reader.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#define MAX_ENTRIES 100000U
#define MAX_DEPTH 64U
#define MAX_OUTPUT (128U * 1024U * 1024U)

typedef struct { sqfs_inode_generic_t *inode; unsigned depth; int resources; } pending;
typedef struct {
    sqfs_dir_reader_t *reader;
    pending *queue;
    unsigned count, next, entries;
    unsigned char *seen;
    sqfs_inode_generic_t *target;
} walk;

static int scan(walk *w, pending dir) {
    sqfs_dir_entry_t *entry = NULL;
    char previous[257] = "";
    int rc;
    if (sqfs_dir_reader_open_dir(w->reader, dir.inode, 0)) return -1;
    while ((rc = sqfs_dir_reader_read(w->reader, &entry)) == 0) {
        sqfs_inode_generic_t *inode = NULL;
        size_t n = (size_t)entry->size + 1;
        if (++w->entries > MAX_ENTRIES || n > 256 || memchr(entry->name, 0, n) ||
            memchr(entry->name, '/', n)) goto bad;
        char name[257];
        memcpy(name, entry->name, n); name[n] = 0;
        if (!strcmp(name, ".") || !strcmp(name, "..") || strcmp(previous, name) >= 0) goto bad;
        memcpy(previous, name, n + 1);
        if (sqfs_dir_reader_get_inode(w->reader, &inode)) goto bad;
        unsigned id = inode->base.inode_number;
        if (!id || id > MAX_ENTRIES || w->seen[id]) { sqfs_free(inode); goto bad; }
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
    return rc > 0 ? 0 : -1;
bad:
    sqfs_free(entry);
    return -1;
}

static int inspect(const char *path, unsigned long limit) {
    int ok = -1;
    sqfs_file_t *file = NULL;
    sqfs_compressor_t *cmp = NULL;
    sqfs_dir_reader_t *reader = NULL;
    sqfs_data_reader_t *data = NULL;
    sqfs_super_t super;
    sqfs_compressor_config_t cfg;
    walk w = {0};
    unsigned char *output = NULL;
    sqfs_u64 size = 0;
    file = sqfs_open_file(path, SQFS_FILE_OPEN_READ_ONLY);
    if (!file || file->get_size(file) > UINT64_C(4294967296) ||
        sqfs_super_read(&super, file) || super.inode_count > MAX_ENTRIES ||
        sqfs_compressor_config_init(&cfg, super.compression_id, super.block_size, SQFS_COMP_FLAG_UNCOMPRESS) ||
        sqfs_compressor_create(&cfg, &cmp)) goto done;
    reader = sqfs_dir_reader_create(&super, cmp, file, 0);
    w.reader = reader;
    w.queue = calloc(MAX_ENTRIES, sizeof(*w.queue));
    w.seen = calloc(MAX_ENTRIES + 1, 1);
    if (!reader || !w.queue || !w.seen || sqfs_dir_reader_get_root_inode(reader, &w.queue[0].inode)) goto done;
    w.count = 1;
    if ((w.queue[0].inode->base.type != SQFS_INODE_DIR &&
         w.queue[0].inode->base.type != SQFS_INODE_EXT_DIR) ||
        !w.queue[0].inode->base.inode_number || w.queue[0].inode->base.inode_number > MAX_ENTRIES) goto done;
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
    sqfs_free(w.target); free(w.queue); free(w.seen); free(output);
    sqfs_destroy(data); sqfs_destroy(reader); sqfs_destroy(cmp); sqfs_destroy(file);
    return ok;
}

int main(int argc, char **argv) {
    char *end;
    if (argc != 3 || argv[2][0] < '1' || argv[2][0] > '9') return 1;
    errno = 0;
    unsigned long limit = strtoul(argv[2], &end, 10);
    if (errno || *end || !limit || limit > MAX_OUTPUT || inspect(argv[1], limit)) {
        fputs("SquashFS inspection failed.\n", stderr);
        return 1;
    }
    return 0;
}
