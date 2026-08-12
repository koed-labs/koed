import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceReproducibility } from "./runner.js";

describe("Retrieval Arena source reproducibility", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  });

  it("changes the effective hash for dirty production code outside packages/evals", () => {
    const root = mkdtempSync(join(tmpdir(), "koed-arena-source-"));
    roots.push(root);
    const evalCwd = join(root, "packages", "evals");
    const apiFile = join(root, "apps", "api", "src", "production.ts");
    mkdirSync(evalCwd, { recursive: true });
    mkdirSync(join(root, "apps", "api", "src"), { recursive: true });
    writeFileSync(apiFile, "export const value = 1;\n");
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "arena@example.test"], {
      cwd: root
    });
    execFileSync("git", ["config", "user.name", "Arena Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });

    const clean = sourceReproducibility(evalCwd);
    writeFileSync(apiFile, "export const value = 2;\n");
    const dirty = sourceReproducibility(evalCwd);

    expect(clean.workingTreeDirty).toBe(false);
    expect(dirty.workingTreeDirty).toBe(true);
    expect(dirty.effectiveSourceTreeHash).not.toBe(
      clean.effectiveSourceTreeHash
    );
  });
});
