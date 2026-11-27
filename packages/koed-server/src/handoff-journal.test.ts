import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openHandoffJournal,
  unsafeOpenHandoffJournalForTesting,
  type HandoffAuthority
} from "./handoff-journal.js";

const identity = {
  installationId: "11111111-1111-4111-8111-111111111111",
  journalId: "22222222-2222-4222-8222-222222222222"
};
const operation = "33333333-3333-4333-8333-333333333333";
const authority = {} as HandoffAuthority;
const record = (extra = {}) => ({
  format: "koed-handoff-journal",
  version: 1,
  ...identity,
  generation: 0,
  state: "clean",
  operationId: null,
  ...extra
});
const bytes = (value: unknown) => `${JSON.stringify(value)}\n`;
const dirs: string[] = [];
async function fixture(content: string | Buffer = bytes(record())) {
  const directory = await mkdtemp(join(tmpdir(), "koed-journal-"));
  dirs.push(directory);
  await writeFile(join(directory, "handoff-journal.json"), content);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("handoff journal", () => {
  it("keeps a relative directory anchored when cwd changes", async () => {
    const first = await fixture();
    const second = await fixture();
    await fs.mkdir(join(first, "journal"));
    await fs.mkdir(join(second, "journal"));
    await writeFile(
      join(first, "journal", "handoff-journal.json"),
      bytes(record())
    );
    await writeFile(
      join(second, "journal", "handoff-journal.json"),
      bytes(record())
    );
    const cwd = process.cwd();
    try {
      process.chdir(first);
      const journal = await openHandoffJournal({
        directory: "journal",
        identity,
        authority
      });
      const clean = await journal.read(authority);
      process.chdir(second);
      await journal.begin(authority, clean, operation);
      expect(
        await readFile(join(first, "journal", "handoff-journal.json"), "utf8")
      ).toBe(
        bytes(record({ generation: 1, state: "dirty", operationId: operation }))
      );
      expect(
        await readFile(join(second, "journal", "handoff-journal.json"), "utf8")
      ).toBe(bytes(record()));
      await journal.close();
    } finally {
      process.chdir(cwd);
    }
  });
  it.each(["begin", "clean"] as const)(
    "validates captured accessor snapshot for %s",
    async (transition) => {
      const dirty = transition === "clean";
      const initial = dirty
        ? record({ generation: 1, state: "dirty", operationId: operation })
        : record();
      const directory = await fixture(bytes(initial));
      const journal = await openHandoffJournal({
        directory,
        identity,
        authority
      });
      let reads = 0;
      const input = {
        get generation() {
          return ++reads === 1 ? -1 : dirty ? 1 : 0;
        },
        state: dirty ? ("dirty" as const) : ("clean" as const),
        operationId: dirty ? operation : null
      };
      await expect(
        dirty
          ? journal.markCleanAfterVerifiedCleanup(
              authority,
              input as {
                generation: number;
                state: "dirty";
                operationId: string;
              }
            )
          : journal.begin(authority, input, operation)
      ).rejects.toMatchObject({ code: "INVALID" });
      expect(
        await readFile(join(directory, "handoff-journal.json"), "utf8")
      ).toBe(bytes(initial));
      await journal.close();
    }
  );
  it.each(["begin", "clean"] as const)(
    "rejects throwing snapshot access for %s as a promise",
    async (transition) => {
      const directory = await fixture();
      const journal = await openHandoffJournal({
        directory,
        identity,
        authority
      });
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const getter = {
        get generation(): number {
          throw new Error("getter");
        }
      };
      for (const input of [getter, revoked.proxy]) {
        const result =
          transition === "begin"
            ? journal.begin(authority, input as never, operation)
            : journal.markCleanAfterVerifiedCleanup(authority, input as never);
        await expect(result).rejects.toMatchObject({ code: "INVALID" });
      }
      expect(
        await readFile(join(directory, "handoff-journal.json"), "utf8")
      ).toBe(bytes(record()));
      await journal.close();
    }
  );
  it.each(["installationId", "journalId"] as const)(
    "captures %s once before validating open identity",
    async (field) => {
      const directory = await fixture();
      let reads = 0;
      const changingIdentity = {
        ...identity,
        get [field]() {
          return ++reads === 1 ? identity[field] : "invalid";
        }
      };
      const journal = await openHandoffJournal({
        directory,
        identity: changingIdentity,
        authority
      });
      const clean = await journal.read(authority);
      await journal.begin(authority, clean, operation);
      expect(
        await readFile(join(directory, "handoff-journal.json"), "utf8")
      ).toBe(
        bytes(record({ generation: 1, state: "dirty", operationId: operation }))
      );
      expect(reads).toBe(1);
      await journal.close();
    }
  );
  it("persists transitions and detects stale concurrent requests", async () => {
    const directory = await fixture();
    const journal = await openHandoffJournal({
      directory,
      identity,
      authority
    });
    const clean = await journal.read(authority);
    const [first, second] = await Promise.allSettled([
      journal.begin(authority, clean, operation),
      journal.begin(authority, clean, operation)
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status === "rejected" && second.reason.code).toBe("STALE");
    if (first.status !== "fulfilled") throw new Error("begin failed");
    expect(
      await journal.markCleanAfterVerifiedCleanup(authority, first.value)
    ).toEqual({ generation: 1, state: "clean", operationId: null });
    await journal.close();
    const reopened = await openHandoffJournal({
      directory,
      identity,
      authority
    });
    expect(await reopened.read(authority)).toEqual({
      generation: 1,
      state: "clean",
      operationId: null
    });
    expect(
      await readFile(join(directory, "handoff-journal.json"), "utf8")
    ).toBe(bytes(record({ generation: 1 })));
  });
  it.each([
    [
      "duplicate",
      bytes(record()).replace('"version":1', '"version":1,"version":1')
    ],
    ["truncated", "{"],
    ["BOM", `\ufeff${bytes(record())}`],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["oversized", " ".repeat(4097)],
    ["extra field", bytes(record({ extra: true }))],
    ["invalid UUID", bytes(record({ journalId: "bad" }))],
    ["fraction", bytes(record({ generation: 0.5 }))],
    ["negative", bytes(record({ generation: -1 }))],
    ["unsafe", bytes(record({ generation: Number.MAX_SAFE_INTEGER + 1 }))],
    ["inconsistent", bytes(record({ state: "dirty" }))],
    ["noncanonical", JSON.stringify(record())]
  ])("rejects %s", async (_name, content) => {
    const directory = await fixture(content);
    await expect(
      openHandoffJournal({ directory, identity, authority })
    ).rejects.toMatchObject({ code: "INVALID" });
  });
  it("rejects missing, foreign, unsupported and symlinked records", async () => {
    const directory = await fixture(bytes(record({ version: 2 })));
    await expect(
      openHandoffJournal({ directory, identity, authority })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    await writeFile(
      join(directory, "handoff-journal.json"),
      bytes(record({ journalId: operation }))
    );
    await expect(
      openHandoffJournal({ directory, identity, authority })
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await rm(join(directory, "handoff-journal.json"));
    await expect(
      openHandoffJournal({ directory, identity, authority })
    ).rejects.toMatchObject({ code: "MISSING" });
    await symlink("elsewhere", join(directory, "handoff-journal.json"));
    await expect(
      openHandoffJournal({ directory, identity, authority })
    ).rejects.toMatchObject({ code: "INVALID" });
  });
  it("completes repeated short writes before syncing and replacing", async () => {
    const directory = await fixture();
    const events: string[] = [];
    const ops = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (args[1] !== "wx" && args[0] !== directory) return handle;
        const temp = args[1] === "wx";
        return new Proxy(handle, {
          get(target, key) {
            if (key === "write" && temp)
              return async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number
              ) => {
                events.push("write");
                return handle.write(
                  buffer,
                  offset,
                  Math.min(length, 7),
                  position
                );
              };
            if (key === "sync")
              return async () => {
                events.push(temp ? "file-sync" : "dir-sync");
                return handle.sync();
              };
            if (key === "close")
              return async () => {
                events.push(temp ? "file-close" : "dir-close");
                return handle.close();
              };
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      },
      rename: async (...args: Parameters<typeof fs.rename>) => {
        events.push("rename");
        return fs.rename(...args);
      }
    } as typeof fs;
    const journal = await unsafeOpenHandoffJournalForTesting(
      { directory, identity, authority },
      ops
    );
    await journal.begin(authority, await journal.read(authority), operation);
    expect(events.filter((event) => event === "write").length).toBeGreaterThan(
      1
    );
    expect(events.slice(-5)).toEqual([
      "file-sync",
      "file-close",
      "rename",
      "dir-sync",
      "dir-close"
    ]);
    expect(
      JSON.parse(
        await readFile(join(directory, "handoff-journal.json"), "utf8")
      )
    ).toMatchObject({ state: "dirty", operationId: operation });
  });
  it.each(
    [
      "temp-open",
      "write",
      "partial-write",
      "file-sync",
      "file-close",
      "rename",
      "dir-open",
      "dir-sync",
      "dir-close"
    ].flatMap((failure) =>
      ["begin", "clean"].map((transition) => [failure, transition])
    )
  )(
    "poisons after %s failure during %s without masking its cause",
    async (failure, transition) => {
      const directory = await fixture(
        transition === "clean"
          ? bytes(
              record({ generation: 1, state: "dirty", operationId: operation })
            )
          : undefined
      );
      const original = await readFile(
        join(directory, "handoff-journal.json"),
        "utf8"
      );
      const fault = new Error(`injected ${failure}`);
      let armed = false;
      let fired = false;
      let wrotePart = false;
      const fail = (point: string) => {
        if (armed && !fired && point === failure) {
          fired = true;
          throw fault;
        }
      };
      const ops = {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          const [path, flags] = args;
          const temp = flags === "wx";
          const dir = path === directory;
          if (temp) fail("temp-open");
          if (dir) fail("dir-open");
          const handle = await fs.open(...args);
          if (!temp && !dir) return handle;
          return new Proxy(handle, {
            get(target, key) {
              if (key === "write" && temp)
                return async (
                  ...writeArgs: Parameters<typeof handle.write>
                ) => {
                  fail("write");
                  if (failure === "partial-write") {
                    if (wrotePart) fail("partial-write");
                    wrotePart = true;
                    const [buffer, offset, length, position] = writeArgs;
                    return handle.write(
                      buffer,
                      offset,
                      Math.min(length, 7),
                      position
                    );
                  }
                  return handle.write(...writeArgs);
                };
              if (key === "sync")
                return async () => {
                  fail(temp ? "file-sync" : "dir-sync");
                  return handle.sync();
                };
              if (key === "close")
                return async () => {
                  fail(temp ? "file-close" : "dir-close");
                  return handle.close();
                };
              const value = Reflect.get(target, key, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        },
        rename: async (...args: Parameters<typeof fs.rename>) => {
          fail("rename");
          return fs.rename(...args);
        },
        unlink: async () => {
          throw new Error("cleanup failure");
        }
      } as typeof fs;
      const journal = await unsafeOpenHandoffJournalForTesting(
        { directory, identity, authority },
        ops
      );
      const before = await journal.read(authority);
      armed = true;
      await expect(
        transition === "begin"
          ? journal.begin(authority, before, operation)
          : journal.markCleanAfterVerifiedCleanup(
              authority,
              before as {
                generation: number;
                state: "dirty";
                operationId: string;
              }
            )
      ).rejects.toMatchObject({ code: "INDETERMINATE", cause: fault });
      expect(fired).toBe(true);
      await expect(journal.read(authority)).rejects.toMatchObject({
        code: "INDETERMINATE"
      });
      const persisted = await readFile(
        join(directory, "handoff-journal.json"),
        "utf8"
      );
      if (
        [
          "temp-open",
          "write",
          "partial-write",
          "file-sync",
          "file-close",
          "rename"
        ].includes(failure)
      )
        expect(persisted).toBe(original);
      else
        expect(persisted).toBe(
          bytes(
            record(
              transition === "begin"
                ? { generation: 1, state: "dirty", operationId: operation }
                : { generation: 1 }
            )
          )
        );
      await journal.close();
      const reopened = await openHandoffJournal({
        directory,
        identity,
        authority
      });
      const parsed = JSON.parse(persisted);
      expect(await reopened.read(authority)).toEqual({
        generation: parsed.generation,
        state: parsed.state,
        operationId: parsed.operationId
      });
      await reopened.close();
    }
  );
  it("queues reads, transitions and close behind a failing write", async () => {
    const directory = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fault = new Error("write failed");
    const ops = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (args[1] !== "wx") return handle;
        return new Proxy(handle, {
          get(target, key) {
            if (key === "write")
              return async () => {
                entered();
                await gate;
                throw fault;
              };
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    } as typeof fs;
    const journal = await unsafeOpenHandoffJournalForTesting(
      { directory, identity, authority },
      ops
    );
    const clean = await journal.read(authority);
    const failing = journal.begin(authority, clean, operation);
    await started;
    const read = journal.read(authority);
    const next = journal.begin(authority, clean, operation);
    let closed = false;
    const closing = journal.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await expect(failing).rejects.toMatchObject({
      code: "INDETERMINATE",
      cause: fault
    });
    await expect(read).rejects.toMatchObject({ code: "INDETERMINATE" });
    await expect(next).rejects.toMatchObject({ code: "INDETERMINATE" });
    await closing;
    await expect(journal.read(authority)).rejects.toMatchObject({
      code: "CLOSED"
    });
    expect(
      await readFile(join(directory, "handoff-journal.json"), "utf8")
    ).toBe(bytes(record()));
  });
  it("preserves zero-progress write error when cleanup close and unlink fail", async () => {
    const directory = await fixture();
    const ops = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (args[1] !== "wx") return handle;
        return new Proxy(handle, {
          get(target, key) {
            if (key === "write")
              return async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
            if (key === "close")
              return async () => {
                await handle.close();
                throw new Error("cleanup close failed");
              };
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      },
      unlink: async () => {
        throw new Error("cleanup unlink failed");
      }
    } as typeof fs;
    const journal = await unsafeOpenHandoffJournalForTesting(
      { directory, identity, authority },
      ops
    );
    await expect(
      journal.begin(authority, await journal.read(authority), operation)
    ).rejects.toMatchObject({
      code: "INDETERMINATE",
      cause: { message: "short write made no progress" }
    });
    await expect(journal.read(authority)).rejects.toMatchObject({
      code: "INDETERMINATE"
    });
    expect(
      await readFile(join(directory, "handoff-journal.json"), "utf8")
    ).toBe(bytes(record()));
    await journal.close();
  });
  it("rejects mutable stale cleanup snapshots during disk read", async () => {
    const directory = await fixture(
      bytes(record({ generation: 2, state: "dirty", operationId: operation }))
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let armed = false;
    const ops = {
      ...fs,
      lstat: async (...args: Parameters<typeof fs.lstat>) => {
        if (armed) {
          entered();
          await gate;
        }
        return fs.lstat(...args);
      }
    } as typeof fs;
    const journal = await unsafeOpenHandoffJournalForTesting(
      { directory, identity, authority },
      ops
    );
    const expected = {
      generation: 1,
      state: "dirty" as const,
      operationId: operation
    };
    armed = true;
    const result = journal.markCleanAfterVerifiedCleanup(authority, expected);
    await started;
    expected.generation = 2;
    release();
    await expect(result).rejects.toMatchObject({ code: "STALE" });
    expect(
      JSON.parse(
        await readFile(join(directory, "handoff-journal.json"), "utf8")
      )
    ).toMatchObject({ generation: 2, state: "dirty" });
  });
  it("ignores extra identity fields when writing canonical records", async () => {
    const directory = await fixture();
    const extraIdentity = {
      ...identity,
      format: "wrong",
      version: 9,
      extra: true
    };
    const journal = await openHandoffJournal({
      directory,
      identity: extraIdentity,
      authority
    });
    await journal.begin(authority, await journal.read(authority), operation);
    expect(
      await readFile(join(directory, "handoff-journal.json"), "utf8")
    ).toBe(
      bytes(record({ generation: 1, state: "dirty", operationId: operation }))
    );
    expect(await journal.read(authority)).toMatchObject({ state: "dirty" });
  });
  it("does not unlink an existing temp entry after exclusive creation fails", async () => {
    const directory = await fixture();
    let collision = "";
    const ops = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        if (args[1] === "wx") {
          collision = String(args[0]);
          await writeFile(collision, "other owner");
        }
        return fs.open(...args);
      }
    } as typeof fs;
    const journal = await unsafeOpenHandoffJournalForTesting(
      { directory, identity, authority },
      ops
    );
    await expect(
      journal.begin(authority, await journal.read(authority), operation)
    ).rejects.toMatchObject({ code: "INDETERMINATE" });
    expect(await readFile(collision, "utf8")).toBe("other owner");
  });
  it("handles overflow, stale snapshot replay and immutable snapshots", async () => {
    const directory = await fixture();
    const journal = await openHandoffJournal({
      directory,
      identity,
      authority
    });
    const clean = await journal.read(authority);
    expect(Object.isFrozen(clean)).toBe(true);
    await expect(
      journal.markCleanAfterVerifiedCleanup(authority, clean as never)
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const dirty = await journal.begin(authority, clean, operation);
    expect(Object.isFrozen(dirty)).toBe(true);
    const cleaned = await journal.markCleanAfterVerifiedCleanup(
      authority,
      dirty
    );
    await expect(
      journal.markCleanAfterVerifiedCleanup(authority, dirty)
    ).rejects.toMatchObject({ code: "STALE" });
    // The journal cannot enforce the caller's fresh-UUID obligation.
    const next = await journal.begin(authority, cleaned, operation);
    expect(next).toEqual({
      generation: 2,
      state: "dirty",
      operationId: operation
    });
    await expect(
      journal.markCleanAfterVerifiedCleanup(authority, dirty)
    ).rejects.toMatchObject({ code: "STALE" });
    await journal.close();
    await writeFile(
      join(directory, "handoff-journal.json"),
      bytes(record({ generation: Number.MAX_SAFE_INTEGER }))
    );
    const max = await openHandoffJournal({ directory, identity, authority });
    await expect(
      max.begin(authority, await max.read(authority), operation)
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
  it("ignores orphan temps, retains private permissions, and rereads corruption", async () => {
    const directory = await fixture();
    await writeFile(join(directory, ".handoff-journal-orphan.tmp"), "junk");
    const journal = await openHandoffJournal({
      directory,
      identity,
      authority
    });
    await journal.begin(authority, await journal.read(authority), operation);
    expect(
      (await fs.stat(join(directory, "handoff-journal.json"))).mode & 0o777
    ).toBe(0o600);
    expect(
      await readFile(join(directory, ".handoff-journal-orphan.tmp"), "utf8")
    ).toBe("junk");
    await writeFile(join(directory, "handoff-journal.json"), "corrupt");
    await expect(journal.read(authority)).rejects.toMatchObject({
      code: "INVALID"
    });
  });
  it("rejects a non-regular journal", async () => {
    const directory = await fixture();
    const path = join(directory, "handoff-journal.json");
    await rm(path);
    await fs.mkdir(path);
    await expect(
      openHandoffJournal({ directory, identity, authority })
    ).rejects.toMatchObject({ code: "INVALID" });
  });
  it("rejects wrong authority, invalid transitions and closed handles", async () => {
    const directory = await fixture();
    const journal = await openHandoffJournal({
      directory,
      identity,
      authority
    });
    const clean = await journal.read(authority);
    await expect(journal.read({} as HandoffAuthority)).rejects.toMatchObject({
      code: "INVALID"
    });
    await expect(journal.begin(authority, clean, "bad")).rejects.toMatchObject({
      code: "INVALID"
    });
    const dirty = await journal.begin(authority, clean, operation);
    await expect(
      journal.begin(authority, dirty, operation)
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await journal.close();
    await expect(journal.read(authority)).rejects.toMatchObject({
      code: "CLOSED"
    });
  });
});
