import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
