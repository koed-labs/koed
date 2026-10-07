import { createHash } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rm,
  utimes,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 1024;

// Node's Zstd stream can accept an unfinished frame at EOF. Validate RFC 8878
// framing only; native Zstd still performs all decompression and checksum checks.
const verifyCompleteFrames = async (
  source: FileHandle,
  size: number
): Promise<void> => {
  if (size === 0 || size > MAX_DECODED_BYTES)
    throw new Error("codex_compressed_transcript_invalid_size");
  let offset = 0;
  let headers = 0;
  const deadline = Date.now() + 30_000;
  const header = Buffer.alloc(4);
  const read = async (length: number): Promise<number> => {
    if (++headers > 100_000 || Date.now() > deadline)
      throw new Error("codex_compressed_transcript_limit_exceeded");
    if (offset + length > size)
      throw new Error("codex_compressed_transcript_invalid");
    const result = await source.read(header, 0, length, offset);
    if (result.bytesRead !== length)
      throw new Error("codex_compressed_transcript_changed");
    offset += length;
    return header.readUIntLE(0, length);
  };
  const skip = (length: number): void => {
    offset += length;
    if (offset > size) throw new Error("codex_compressed_transcript_invalid");
  };
  while (offset < size) {
    const magic = await read(4);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      skip(await read(4));
      continue;
    }
    if (magic !== 0xfd2fb528)
      throw new Error("codex_compressed_transcript_invalid");
    const descriptor = await read(1);
    if (descriptor & 0x08)
      throw new Error("codex_compressed_transcript_invalid");
    const singleSegment = Boolean(descriptor & 0x20);
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!;
    const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][
      descriptor >>> 6
    ]!;
    skip((singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes);
    let lastBlock = false;
    while (!lastBlock) {
      const block = await read(3);
      lastBlock = Boolean(block & 1);
      const type = (block >>> 1) & 3;
      const bytes = block >>> 3;
      if (type === 3 || bytes > 128 * 1024)
        throw new Error("codex_compressed_transcript_invalid");
      skip(type === 1 ? 1 : bytes);
    }
    if (descriptor & 0x04) skip(4);
  }
};

export class CodexCompressedTranscriptReader {
  private directory?: string;
  private directoryPromise?: Promise<string>;
  private closed = false;
  private readonly pending = new Map<string, Promise<string>>();
  private readonly cached = new Map<
    string,
    { path: string; size: number; sourcePath: string }
  >();
  private readonly activeSources = new Map<string, number>();
  private readonly activeOperations = new Set<Promise<void>>();
  private cachedBytes = 0;
  private reservedBytes = 0;

  constructor(
    private readonly koedHome: string,
    private readonly maxDecodedBytes = MAX_DECODED_BYTES,
    private readonly maxCacheBytes = MAX_CACHE_BYTES,
    private readonly maxCacheEntries = MAX_CACHE_ENTRIES
  ) {
    if (
      !Number.isSafeInteger(maxDecodedBytes) ||
      maxDecodedBytes <= 0 ||
      maxDecodedBytes > MAX_DECODED_BYTES ||
      !Number.isSafeInteger(maxCacheBytes) ||
      maxCacheBytes < maxDecodedBytes ||
      maxCacheBytes > MAX_CACHE_BYTES ||
      !Number.isSafeInteger(maxCacheEntries) ||
      maxCacheEntries <= 0 ||
      maxCacheEntries > MAX_CACHE_ENTRIES
    ) {
      throw new Error("codex_compressed_transcript_invalid_limit");
    }
  }

  async materialize(
    sourcePath: string,
    snapshotPlain = false,
    expected?: Stats
  ): Promise<string> {
    if (this.closed)
      throw new Error("codex_compressed_transcript_reader_closed");
    const compressed = sourcePath.endsWith(".jsonl.zst");
    if (!compressed && !snapshotPlain) return sourcePath;
    if (compressed && typeof zlib.createZstdDecompress !== "function") {
      throw new Error("codex_compressed_transcript_runtime_unsupported");
    }
    const before = await lstat(sourcePath);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error("codex_compressed_transcript_not_regular_file");
    if (
      expected &&
      (before.dev !== expected.dev ||
        before.ino !== expected.ino ||
        before.size !== expected.size ||
        before.mtimeMs !== expected.mtimeMs ||
        before.ctimeMs !== expected.ctimeMs)
    )
      throw new Error("codex_compressed_transcript_changed");
    if (before.size > MAX_DECODED_BYTES)
      throw new Error("codex_compressed_transcript_invalid_size");
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          path.resolve(sourcePath),
          compressed,
          before.dev,
          before.ino,
          before.size,
          before.mtimeMs,
          before.ctimeMs
        ])
      )
      .digest("hex");
    const cached = this.cached.get(key);
    if (cached) {
      this.cached.delete(key);
      this.cached.set(key, cached);
      return cached.path;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = this.decode(sourcePath, key, before, compressed);
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }

  async withMaterialized<T>(
    sourcePath: string,
    consume: (readablePath: string) => Promise<T>,
    expected?: Stats
  ): Promise<T> {
    if (this.closed)
      throw new Error("codex_compressed_transcript_reader_closed");
    const key = path.resolve(sourcePath);
    this.activeSources.set(key, (this.activeSources.get(key) ?? 0) + 1);
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.activeOperations.add(completed);
    try {
      return await consume(await this.materialize(sourcePath, true, expected));
    } finally {
      const count = this.activeSources.get(key)! - 1;
      if (count) this.activeSources.set(key, count);
      else this.activeSources.delete(key);
      this.activeOperations.delete(completed);
      release();
    }
  }

  private async reserveCache(): Promise<void> {
    this.reservedBytes += this.maxDecodedBytes;
    const removed: string[] = [];
    try {
      while (
        this.cachedBytes + this.reservedBytes > this.maxCacheBytes ||
        this.cached.size + this.pending.size > this.maxCacheEntries
      ) {
        const oldest = [...this.cached.entries()].find(
          ([, entry]) => !this.activeSources.has(entry.sourcePath)
        );
        if (!oldest)
          throw new Error("codex_compressed_transcript_limit_exceeded");
        this.cached.delete(oldest[0]);
        this.cachedBytes -= oldest[1].size;
        removed.push(oldest[1].path);
      }
      await Promise.all(removed.map((file) => rm(file, { force: true })));
    } catch (error) {
      this.reservedBytes -= this.maxDecodedBytes;
      await Promise.all(removed.map((file) => rm(file, { force: true })));
      throw error;
    }
  }

  private privateDirectory(): Promise<string> {
    this.directoryPromise ??= (async () => {
      const parent = path.join(this.koedHome, "state");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentState = await lstat(parent);
      if (
        !parentState.isDirectory() ||
        parentState.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((parentState.mode & 0o022) !== 0 ||
            parentState.uid !== process.getuid?.()))
      ) {
        throw new Error("codex_compressed_transcript_cache_not_private");
      }
      await this.removeAbandonedDirectories(parent);
      this.directory = await mkdtemp(
        path.join(parent, `codex-decoded-${process.pid}-`)
      );
      if (process.platform !== "win32") await chmod(this.directory, 0o700);
      return this.directory;
    })();
    return this.directoryPromise;
  }

  private async removeAbandonedDirectories(parent: string): Promise<void> {
    const directory = await opendir(parent);
    let examined = 0;
    for await (const entry of directory) {
      if (++examined > 256) break;
      const match = /^codex-decoded-([1-9][0-9]{0,9})-[A-Za-z0-9]{6}$/.exec(
        entry.name
      );
      if (!match || !entry.isDirectory()) continue;
      const pid = Number(match[1]);
      if (pid === process.pid || pid > 2_147_483_647) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      const candidate = path.join(parent, entry.name);
      const state = await lstat(candidate).catch(() => undefined);
      if (
        !state?.isDirectory() ||
        state.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((state.mode & 0o077) !== 0 || state.uid !== process.getuid?.()))
      )
        continue;
      const files = await readdir(candidate, { withFileTypes: true });
      if (
        files.some(
          (file) =>
            !file.isFile() || !/^rollout-[a-f0-9]{64}\.jsonl$/.test(file.name)
        )
      )
        continue;
      await rm(candidate, { recursive: true, force: true });
    }
  }

  private async decode(
    sourcePath: string,
    key: string,
    before: Stats,
    compressed: boolean
  ): Promise<string> {
    const decodedPath = path.join(
      await this.privateDirectory(),
      `rollout-${key}.jsonl`
    );
    const source = await open(
      sourcePath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
    let count = 0;
    let reserved = false;
    try {
      const opened = await source.stat();
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs
      ) {
        throw new Error("codex_compressed_transcript_changed");
      }
      if (compressed) await verifyCompleteFrames(source, before.size);
      await this.reserveCache();
      reserved = true;
      const limiter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          count += chunk.length;
          callback(
            count > this.maxDecodedBytes
              ? new Error("codex_compressed_transcript_limit_exceeded")
              : null,
            chunk
          );
        }
      });
      await pipeline(
        source.createReadStream({ autoClose: false }),
        compressed
          ? zlib.createZstdDecompress({
              params: { [zlib.constants.ZSTD_d_windowLogMax]: 26 }
            })
          : new PassThrough(),
        limiter,
        createWriteStream(decodedPath, { flags: "wx", mode: 0o600 }),
        { signal: AbortSignal.timeout(30_000) }
      );
      const after = await source.stat();
      const pathState = await lstat(sourcePath);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        pathState.dev !== before.dev ||
        pathState.ino !== before.ino ||
        pathState.isSymbolicLink()
      ) {
        throw new Error("codex_compressed_transcript_changed");
      }
      await utimes(decodedPath, before.atime, before.mtime);
      this.cached.set(key, {
        path: decodedPath,
        size: count,
        sourcePath: path.resolve(sourcePath)
      });
      this.cachedBytes += count;
      return decodedPath;
    } catch (error) {
      await rm(decodedPath, { force: true });
      if (
        error instanceof Error &&
        error.message.startsWith("codex_compressed_transcript_")
      )
        throw error;
      throw new Error("codex_compressed_transcript_invalid", { cause: error });
    } finally {
      if (reserved) this.reservedBytes -= this.maxDecodedBytes;
      await source.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.activeOperations);
    await Promise.allSettled(this.pending.values());
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.directoryPromise = undefined;
    this.cached.clear();
    this.cachedBytes = 0;
  }
}
