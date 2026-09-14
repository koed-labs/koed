import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupLegacyProtectedFdFiles,
  withProtectedJsonFd,
  withProtectedTextFd
} from "./protected-json-fd.js";

const roots: string[] = [];

describe("withProtectedJsonFd", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands an asynchronous reader a descriptor positioned at byte zero", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-protected-fd-"));
    roots.push(root);

    const result = await withProtectedJsonFd(
      root,
      "payload",
      { invitation: "one-time" },
      async (fd) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        expect(readdirSync(root)).toEqual([]);
        return JSON.parse(readFileSync(fd, "utf8")) as {
          invitation: string;
        };
      }
    );

    expect(result).toEqual({ invitation: "one-time" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes the protected payload when the operation fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-protected-fd-"));
    roots.push(root);

    await expect(
      withProtectedJsonFd(root, "payload", { secret: "value" }, async () => {
        throw new Error("operation failed");
      })
    ).rejects.toThrow("operation failed");

    expect(readdirSync(root)).toEqual([]);
  });

  it("cleans only scoped legacy protected-FD files", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-protected-fd-"));
    roots.push(root);
    const legacyPath = resolve(
      root,
      "pds-recovery-code-999999999-11111111-2222-4333-8444-555555555555"
    );
    const activePath = resolve(
      root,
      `pds-ipc-${process.pid}-11111111-2222-4333-8444-555555555555`
    );
    const unrelatedPath = resolve(root, "pds-recovery-code.txt");
    writeFileSync(legacyPath, "recovery-code", { mode: 0o600 });
    writeFileSync(activePath, "active-payload", { mode: 0o600 });
    writeFileSync(unrelatedPath, "keep-me", { mode: 0o600 });

    expect(cleanupLegacyProtectedFdFiles(root)).toBe(1);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(activePath)).toBe(true);
    expect(existsSync(unrelatedPath)).toBe(true);
  });

  it("passes sensitive text without serializing it as JSON", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-protected-fd-"));
    roots.push(root);

    const result = await withProtectedTextFd(
      root,
      "recovery",
      "one-time-recovery-code",
      async (fd) => readFileSync(fd, "utf8")
    );

    expect(result).toBe("one-time-recovery-code");
    expect(readdirSync(root)).toEqual([]);
  });
});
