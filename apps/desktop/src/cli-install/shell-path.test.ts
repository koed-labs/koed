import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateManagedPathBlock } from "./shell-path.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("managed shell PATH block", () => {
  it("fails closed on edited or duplicate markers and preserves contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed path "));
    roots.push(root);
    const rcPath = join(root, ".zshrc");
    const input = {
      rcPath,
      shell: "zsh" as const,
      operation: "add" as const,
      consent: true,
      launcherDirectory: join(root, ".local", "bin")
    };
    const edited = "# >>> koed managed PATH >>> altered\nkeep\n";
    writeFileSync(rcPath, edited);
    await expect(updateManagedPathBlock(input)).rejects.toThrow(/markers/);
    expect(readFileSync(rcPath, "utf8")).toBe(edited);
    const duplicate =
      "# >>> koed managed PATH >>>\n# <<< koed managed PATH <<<\n".repeat(2);
    writeFileSync(rcPath, duplicate);
    await expect(updateManagedPathBlock(input)).rejects.toThrow(/markers/);
    expect(readFileSync(rcPath, "utf8")).toBe(duplicate);
  });

  it("adds one idempotent block and removes only unchanged owned bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "koed path "));
    roots.push(root);
    const rcPath = join(root, ".zshrc");
    writeFileSync(rcPath, "export KEEP=1\n");
    const input = {
      rcPath,
      shell: "zsh" as const,
      operation: "add" as const,
      consent: true,
      launcherDirectory: join(root, ".local", "bin")
    };
    await updateManagedPathBlock(input);
    const first = readFileSync(rcPath, "utf8");
    await updateManagedPathBlock(input);
    expect(readFileSync(rcPath, "utf8")).toBe(first);
    await updateManagedPathBlock({ ...input, operation: "remove" });
    expect(readFileSync(rcPath, "utf8")).toBe("export KEEP=1\n");
  });
});
