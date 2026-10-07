import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { CodexCompressedTranscriptReader } from "../src/codex-compressed-transcript.js";

const roots: string[] = [];
const readers: CodexCompressedTranscriptReader[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const fixture = async (
  maxBytes?: number,
  maxCacheBytes?: number,
  maxCacheEntries?: number
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-compressed-test-"));
  roots.push(root);
  const source = path.join(root, "rollout-fixture.jsonl.zst");
  const reader = new CodexCompressedTranscriptReader(
    root,
    maxBytes,
    maxCacheBytes,
    maxCacheEntries
  );
  readers.push(reader);
  return { root, source, reader };
};

describe("Codex compressed transcript reader", () => {
  it("bounds the number of cached snapshots even for empty plaintext sources", async () => {
    const { root, reader } = await fixture(64, 256, 2);
    const snapshots: string[] = [];
    for (let index = 0; index < 4; index++) {
      const source = path.join(root, `rollout-empty-${index}.jsonl`);
      await writeFile(source, "");
      snapshots.push(
        await reader.withMaterialized(source, async (snapshot) => snapshot)
      );
    }
    expect(await readdir(path.dirname(snapshots[0]!))).toHaveLength(2);
    await expect(stat(snapshots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(snapshots[3]!, "utf8")).toBe("");
  });
  it("cleans abandoned owned snapshots without removing live or unrecognized directories", async () => {
    const { root, source, reader } = await fixture();
    const parent = path.join(root, "state");
    await mkdir(parent, { mode: 0o700 });
    const stale = path.join(parent, "codex-decoded-2147483647-Abc123");
    const live = path.join(parent, `codex-decoded-${process.pid}-Def456`);
    const unrecognized = path.join(parent, "codex-decoded-2147483647-Ghi789");
    for (const directory of [stale, live, unrecognized])
      await mkdir(directory, { mode: 0o700 });
    await writeFile(
      path.join(stale, `rollout-${"a".repeat(64)}.jsonl`),
      "temporary\n",
      { mode: 0o600 }
    );
    await writeFile(
      path.join(unrecognized, "retain.txt"),
      "not a decoder artifact\n"
    );
    await writeFile(source, zstdCompressSync(Buffer.from("new source\n")));
    expect(await readFile(await reader.materialize(source), "utf8")).toBe(
      "new source\n"
    );
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(live)).isDirectory()).toBe(true);
    expect(await readFile(path.join(unrecognized, "retain.txt"), "utf8")).toBe(
      "not a decoder artifact\n"
    );
  });
  it("keeps leased snapshots readable and evicts unleased cache entries within its bound", async () => {
    const { root, source, reader } = await fixture(64, 64);
    const other = path.join(root, "rollout-other.jsonl.zst");
    await writeFile(source, zstdCompressSync(Buffer.from("original\n")));
    await writeFile(other, zstdCompressSync(Buffer.from("replacement\n")));
    let release!: () => void;
    let started!: (file: string) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readable = new Promise<string>((resolve) => {
      started = resolve;
    });
    const first = reader.withMaterialized(source, async (file) => {
      started(file);
      await barrier;
      return readFile(file, "utf8");
    });
    const firstPath = await readable;
    await expect(reader.materialize(other)).rejects.toThrow(
      "codex_compressed_transcript_limit_exceeded"
    );
    expect(await readFile(firstPath, "utf8")).toBe("original\n");
    release();
    expect(await first).toBe("original\n");
    expect(await readFile(await reader.materialize(other), "utf8")).toBe(
      "replacement\n"
    );
    await expect(stat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await reader.materialize(source), "utf8")).toBe(
      "original\n"
    );
  });

  it("pins an identity-bound plain snapshot through source replacement and orderly close", async () => {
    const { root, reader } = await fixture();
    const plain = path.join(root, "rollout-plain.jsonl");
    await writeFile(plain, "admitted bytes\n");
    const before = await stat(plain);
    let release!: () => void;
    let started!: (file: string) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readable = new Promise<string>((resolve) => {
      started = resolve;
    });
    const capture = reader.withMaterialized(
      plain,
      async (file) => {
        started(file);
        await barrier;
        return readFile(file, "utf8");
      },
      before
    );
    const snapshot = await readable;
    expect(snapshot).not.toBe(plain);
    await writeFile(plain, "new source bytes\n");
    let closed = false;
    const close = reader.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release();
    expect(await capture).toBe("admitted bytes\n");
    await close;
    await expect(stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a plain snapshot when the source identity differs from its confinement check", async () => {
    const { root, reader } = await fixture();
    const plain = path.join(root, "rollout-plain.jsonl");
    await writeFile(plain, "initial\n");
    const before = await stat(plain);
    await writeFile(plain, "different length\n");
    await expect(
      reader.withMaterialized(plain, async (file) => readFile(file), before)
    ).rejects.toThrow("codex_compressed_transcript_changed");
    expect(await readFile(plain, "utf8")).toBe("different length\n");
  });
  it("decodes exact JSONL bytes privately without changing the native source", async () => {
    const { source, reader } = await fixture();
    const content = Buffer.from(
      '{"type":"session_meta","payload":{"id":"fixture"}}\n'
    );
    const compressed = zstdCompressSync(content);
    await writeFile(source, compressed);
    const decoded = await reader.materialize(source);
    expect(await readFile(decoded)).toEqual(content);
    expect(await readFile(source)).toEqual(compressed);
    expect(decoded).not.toBe(source);
    if (process.platform !== "win32") {
      expect((await stat(decoded)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(decoded))).mode & 0o777).toBe(0o700);
    }
    expect(await reader.materialize(source)).toBe(decoded);
    await reader.close();
    await expect(stat(decoded)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares concurrent reads and uses one private cache directory", async () => {
    const { root, source, reader } = await fixture();
    const other = path.join(root, "rollout-other.jsonl.zst");
    await writeFile(source, zstdCompressSync(Buffer.from("first\n")));
    await writeFile(other, zstdCompressSync(Buffer.from("second\n")));
    const [first, repeated, second] = await Promise.all([
      reader.materialize(source),
      reader.materialize(source),
      reader.materialize(other)
    ]);
    expect(first).toBe(repeated);
    expect(path.dirname(first)).toBe(path.dirname(second));
    expect(await readdir(path.join(root, "state"))).toHaveLength(1);
  });

  it("keeps changed representations separate so old evidence remains readable", async () => {
    const { source, reader } = await fixture();
    await writeFile(source, zstdCompressSync(Buffer.from("original\n")));
    const first = await reader.materialize(source);
    await writeFile(source, zstdCompressSync(Buffer.from("replacement\n")));
    const second = await reader.materialize(source);
    expect(second).not.toBe(first);
    expect(await readFile(first, "utf8")).toBe("original\n");
    expect(await readFile(second, "utf8")).toBe("replacement\n");
  });

  it("rejects a malformed compressed file without leaving a decoded artifact", async () => {
    const { root, source, reader } = await fixture();
    await writeFile(source, "not a compressed frame");
    await expect(reader.materialize(source)).rejects.toThrow(
      "codex_compressed_transcript_invalid"
    );
    const cache = (await readdir(path.join(root, "state")))[0]!;
    expect(await readdir(path.join(root, "state", cache))).toEqual([]);
  });

  it("bounds decoded output and removes partial files after refusal", async () => {
    const { source, reader } = await fixture(128);
    await writeFile(source, zstdCompressSync(Buffer.alloc(256, 0x61)));
    await expect(reader.materialize(source)).rejects.toThrow(
      "codex_compressed_transcript_limit_exceeded"
    );
    await writeFile(source, zstdCompressSync(Buffer.from("small\n")));
    expect(await readFile(await reader.materialize(source), "utf8")).toBe(
      "small\n"
    );
  });

  it("refuses truncated frames and removes their partial output", async () => {
    const { root, source, reader } = await fixture();
    const frame = zstdCompressSync(Buffer.from("complete transcript\n"));
    await writeFile(source, frame.subarray(0, frame.length - 2));
    await expect(reader.materialize(source)).rejects.toThrow(
      "codex_compressed_transcript_invalid"
    );
    const cache = (await readdir(path.join(root, "state")))[0]!;
    expect(await readdir(path.join(root, "state", cache))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink sources",
    async () => {
      const { root, source, reader } = await fixture();
      const original = path.join(root, "original");
      await writeFile(original, zstdCompressSync(Buffer.from("private\n")));
      await symlink(original, source);
      await expect(reader.materialize(source)).rejects.toThrow(
        "codex_compressed_transcript_not_regular_file"
      );
    }
  );

  it("refuses use after cleanup and passes through plain source paths", async () => {
    const { root, reader } = await fixture();
    const plain = path.join(root, "rollout-fixture.jsonl");
    expect(await reader.materialize(plain)).toBe(plain);
    await reader.close();
    await expect(reader.materialize(plain)).rejects.toThrow(
      "codex_compressed_transcript_reader_closed"
    );
  });
});
