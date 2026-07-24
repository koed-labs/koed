import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOwnedDiagnosticsDir,
  writeDiagnosticTail
} from "./smoke-diagnostics.mjs";

describe("packaged Desktop smoke diagnostics", () => {
  it("creates an owned child without deleting caller-owned files", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-smoke-diagnostics-"));
    const sentinel = resolve(root, "keep-me.txt");
    try {
      writeFileSync(sentinel, "unrelated");
      const owned = createOwnedDiagnosticsDir(root);

      expect(owned).not.toBe(root);
      expect(owned.startsWith(resolve(root, "koed-desktop-smoke-"))).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("unrelated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes only the configured tail of an oversized log", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-smoke-diagnostics-"));
    const source = resolve(root, "source.log");
    const target = resolve(root, "owned", "logs", "supervisor.log");
    try {
      writeFileSync(source, "prefix-keep-out-TAIL");
      writeDiagnosticTail(source, target, 4);

      expect(readFileSync(target, "utf8")).toBe("TAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
