import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemConversationSourceStorage } from "./conversation-source-storage.js";

const temporaryHomes: string[] = [];

const temporaryHome = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "koed-source-journal-"));
  temporaryHomes.push(directory);
  return directory;
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const directory of temporaryHomes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("filesystem conversation source storage", () => {
  it("stores and verifies immutable content-addressed segments", () => {
    const storage = createFilesystemConversationSourceStorage(temporaryHome());
    const artifactId = randomUUID();
    const bytes = Buffer.from('{"type":"event_msg"}\n');
    const plaintextDigest = digest(bytes);

    const first = storage.put({ artifactId, plaintextDigest, bytes });
    const replay = storage.put({ artifactId, plaintextDigest, bytes });
    const read = storage.read({
      storageKey: first.storageKey,
      expectedDigest: plaintextDigest,
      maximumBytes: bytes.byteLength
    });

    expect(replay).toEqual(first);
    expect(Buffer.from(read)).toEqual(bytes);
  });

  it("rejects storage-key traversal and symlinked artifact directories", () => {
    const koedHome = temporaryHome();
    const storage = createFilesystemConversationSourceStorage(koedHome);
    const artifactId = randomUUID();
    const bytes = Buffer.from('{"type":"event_msg"}\n');
    const plaintextDigest = digest(bytes);
    const external = join(koedHome, "external");
    mkdirSync(external);
    symlinkSync(external, join(koedHome, "source-journal", artifactId));

    expect(() => storage.put({ artifactId, plaintextDigest, bytes })).toThrow(
      "must be a real directory"
    );
    expect(() =>
      storage.read({
        storageKey: `../${artifactId}/${plaintextDigest}.segment`,
        expectedDigest: plaintextDigest,
        maximumBytes: bytes.byteLength
      })
    ).toThrow("storage key is invalid");
  });

  it("does not follow a symlinked segment during reads", () => {
    const koedHome = temporaryHome();
    const storage = createFilesystemConversationSourceStorage(koedHome);
    const artifactId = randomUUID();
    const bytes = Buffer.from('{"type":"event_msg"}\n');
    const plaintextDigest = digest(bytes);
    const artifactDirectory = join(koedHome, "source-journal", artifactId);
    const external = join(koedHome, "external.segment");
    mkdirSync(artifactDirectory);
    writeFileSync(external, bytes);
    symlinkSync(
      external,
      join(artifactDirectory, `${plaintextDigest}.segment`)
    );

    expect(() =>
      storage.read({
        storageKey: `${artifactId}/${plaintextDigest}.segment`,
        expectedDigest: plaintextDigest,
        maximumBytes: bytes.byteLength
      })
    ).toThrow();
  });
});
