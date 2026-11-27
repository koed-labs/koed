import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import properLockfile from "proper-lockfile";
import { acquireDirectoryLock } from "./directory-lock.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>())
}));

const roots: string[] = [];
const lockPath = () => {
  const root = mkdtempSync(join(tmpdir(), "koed-directory-lock-"));
  roots.push(root);
  return join(root, "lock");
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("directory lock", () => {
  it("releases its own lock and remains idempotent", () => {
    const path = lockPath();
    const release = acquireDirectoryLock(path);
    release();
    expect(() => release()).not.toThrow();
    expect(() => readFileSync(path)).toThrow();
  });

  it("treats a preexisting empty directory as locked", () => {
    const path = lockPath();
    mkdirSync(path);
    expect(() => acquireDirectoryLock(path)).toThrowError(
      expect.objectContaining({ code: "ELOCKED" })
    );
  });

  it("does not remove a foreign replacement, even with copied metadata", () => {
    const path = lockPath();
    const release = acquireDirectoryLock(path);
    renameSync(path, `${path}.old`);
    mkdirSync(path);
    for (const name of readdirSync(`${path}.old`)) {
      writeFileSync(join(path, name), readFileSync(join(`${path}.old`, name)));
    }
    writeFileSync(join(path, "foreign"), "keep");
    expect(() => release()).toThrow();
    expect(readFileSync(join(path, "foreign"), "utf8")).toBe("keep");
  });

  it.each(["missing directory", "missing metadata", "malformed metadata"])(
    "fails closed on %s",
    (scenario) => {
      const path = lockPath();
      const release = acquireDirectoryLock(path);
      if (scenario === "missing directory") rmSync(path, { recursive: true });
      else {
        const metadata = join(path, readdirSync(path)[0]!);
        if (scenario === "missing metadata") rmSync(metadata);
        else writeFileSync(metadata, "malformed");
      }
      expect(() => release()).toThrow();
      expect(() => release()).toThrow();
    }
  );

  it("leaves the directory intact when metadata cannot be read", () => {
    const path = lockPath();
    const release = acquireDirectoryLock(path);
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    expect(() => release()).toThrow("read failed");
    expect(readdirSync(path)).toHaveLength(1);
    expect(() => release()).not.toThrow();
  });

  it("leaves the directory intact when metadata initialization fails", () => {
    const path = lockPath();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    expect(() => acquireDirectoryLock(path)).toThrow(
      /write failed.*manual recovery/i
    );
    expect(() => acquireDirectoryLock(path)).toThrowError(
      expect.objectContaining({ code: "ELOCKED" })
    );
  });

  it("cleans up initialization failure only when identity and token still match", () => {
    const path = lockPath();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((...args) => {
      write(...args);
      throw new Error("write failed after creation");
    });
    expect(() => acquireDirectoryLock(path)).toThrow(
      "write failed after creation"
    );
    const release = acquireDirectoryLock(path);
    release();
  });

  it("preserves a foreign replacement during failed initialization", () => {
    const path = lockPath();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      renameSync(path, `${path}.old`);
      mkdirSync(path);
      write(join(path, "foreign"), "keep");
      throw new Error("write failed");
    });
    expect(() => acquireDirectoryLock(path)).toThrow(/manual recovery/i);
    expect(readFileSync(join(path, "foreign"), "utf8")).toBe("keep");
  });

  it("reports manual recovery when initial identity cannot be read", () => {
    const path = lockPath();
    vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
      throw new Error("stat failed");
    });
    expect(() => acquireDirectoryLock(path)).toThrow(
      /stat failed.*manual recovery/i
    );
    expect(() => acquireDirectoryLock(path)).toThrowError(
      expect.objectContaining({ code: "ELOCKED" })
    );
  });

  it("preserves both errors and reports manual recovery when restoration fails", () => {
    const path = lockPath();
    const release = acquireDirectoryLock(path);
    const removal = new Error("remove failed");
    const restoration = new Error("restore failed");
    vi.spyOn(fs, "rmdirSync").mockImplementationOnce(() => {
      throw removal;
    });
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw restoration;
    });
    try {
      release();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([removal, restoration]);
      expect((error as Error).message).toMatch(/manual recovery/i);
    }
    expect(readdirSync(path)).toEqual([]);
  });

  it("interoperates with proper-lockfile contention in both directions", async () => {
    const path = lockPath();
    const target = `${path}.target`;
    writeFileSync(target, "target");
    const releaseProper = await properLockfile.lock(target, {
      lockfilePath: path
    });
    expect(() => acquireDirectoryLock(path)).toThrowError(
      expect.objectContaining({ code: "ELOCKED" })
    );
    await releaseProper();
    const release = acquireDirectoryLock(path);
    await expect(
      properLockfile.lock(target, { lockfilePath: path })
    ).rejects.toMatchObject({ code: "ELOCKED" });
    release();
  });

  it("cannot recover a stale crashed lock containing owner metadata", async () => {
    const path = lockPath();
    const target = `${path}.target`;
    writeFileSync(target, "target");
    // Simulate a crashed owner without creating or removing any live lock.
    mkdirSync(path);
    writeFileSync(join(path, "owner"), "crashed-owner-token");
    utimesSync(path, new Date(0), new Date(0));

    await expect(
      properLockfile.lock(target, { lockfilePath: path, stale: 2000 })
    ).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(readdirSync(path)).toEqual(["owner"]);
    expect(readFileSync(join(path, "owner"), "utf8")).toBe(
      "crashed-owner-token"
    );
  });

  it("restores metadata and permits retry after rmdir fails", () => {
    const path = lockPath();
    const release = acquireDirectoryLock(path);
    vi.spyOn(fs, "rmdirSync").mockImplementationOnce(() => {
      throw new Error("remove failed");
    });
    expect(() => release()).toThrow(/remove failed.*manual recovery/i);
    expect(() => release()).not.toThrow();
  });

  it("allows retry after removal fails without marking released", () => {
    const path = lockPath();
    const release = acquireDirectoryLock(path);
    writeFileSync(join(path, "unexpected"), "keep");
    expect(() => release()).toThrow();
    expect(readFileSync(join(path, "unexpected"), "utf8")).toBe("keep");
    rmSync(join(path, "unexpected"));
    release();
    expect(() => acquireDirectoryLock(path)).not.toThrow();
  });
});
