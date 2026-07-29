import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface ConversationSourceStorage {
  readonly provider: "filesystem";
  put(input: {
    artifactId: string;
    plaintextDigest: string;
    bytes: Uint8Array;
  }): { storageKey: string; storedSize: number };
  read(input: {
    storageKey: string;
    expectedDigest: string;
    maximumBytes: number;
  }): Uint8Array;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const artifactIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const storageKeyPattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{64})\.segment$/i;

const safeStoragePath = (root: string, storageKey: string): string => {
  if (!storageKeyPattern.test(storageKey)) {
    throw new Error("Conversation source storage key is invalid");
  }
  const target = resolve(root, storageKey);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error("Conversation source storage key escapes storage root");
  }
  return target;
};

const readRegularFile = (path: string, maximumBytes: number): Uint8Array => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile()) {
      throw new Error("Conversation source segment is not a regular file");
    }
    if (state.size > maximumBytes) {
      throw new Error("Conversation source segment exceeds read limit");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const fsyncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

export const createFilesystemConversationSourceStorage = (
  koedHome: string
): ConversationSourceStorage => {
  const configuredRoot = resolve(koedHome, "source-journal");
  mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(configuredRoot).isSymbolicLink()) {
    throw new Error("Conversation source storage root must not be a symlink");
  }
  chmodSync(configuredRoot, 0o700);
  const root = realpathSync(configuredRoot);

  return {
    provider: "filesystem",

    put(input) {
      if (
        !artifactIdPattern.test(input.artifactId) ||
        !digestPattern.test(input.plaintextDigest)
      ) {
        throw new Error("Conversation source storage identity is invalid");
      }
      if (sha256(input.bytes) !== input.plaintextDigest) {
        throw new Error("Conversation source segment digest mismatch");
      }
      const storageKey = join(
        input.artifactId,
        `${input.plaintextDigest}.segment`
      );
      const target = safeStoragePath(root, storageKey);
      const directory = dirname(target);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryState = lstatSync(directory);
      if (
        directoryState.isSymbolicLink() ||
        !directoryState.isDirectory() ||
        realpathSync(directory) !== directory
      ) {
        throw new Error(
          "Conversation source artifact directory must be a real directory"
        );
      }
      chmodSync(directory, 0o700);
      if (existsSync(target)) {
        const existing = readRegularFile(target, input.bytes.byteLength);
        if (existing.byteLength !== input.bytes.byteLength) {
          throw new Error("Conversation source storage collision");
        }
        if (sha256(existing) !== input.plaintextDigest) {
          throw new Error("Conversation source storage collision");
        }
        return { storageKey, storedSize: existing.byteLength };
      }

      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, input.bytes, {
          mode: 0o600,
          flag: "wx"
        });
        const descriptor = openSync(temporary, constants.O_RDONLY);
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        renameSync(temporary, target);
        fsyncDirectory(directory);
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
      }
      return { storageKey, storedSize: input.bytes.byteLength };
    },

    read(input) {
      if (!digestPattern.test(input.expectedDigest)) {
        throw new Error("Conversation source segment digest is invalid");
      }
      const target = safeStoragePath(root, input.storageKey);
      const bytes = readRegularFile(target, input.maximumBytes);
      if (sha256(bytes) !== input.expectedDigest) {
        throw new Error("Conversation source segment failed verification");
      }
      return bytes;
    }
  };
};
