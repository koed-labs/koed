import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const staticImport =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;

/** Bare package specifiers reachable from an entry through static imports. */
function staticPackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(sourceDir, file), "utf8");
    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1]!;
      if (/^import\s+type\b|^export\s+type\b/.test(match[0].trim())) continue;
      if (specifier.startsWith("./"))
        pending.push(specifier.slice(2).replace(/\.js$/, ".ts"));
      else if (!specifier.startsWith("node:")) packages.add(specifier);
    }
  }
  return packages;
}

describe("CLI startup imports", () => {
  it("does not load X.509 support while peer-online sync is disabled", () => {
    const packages = staticPackages("cli.ts");
    expect(packages.has("commander")).toBe(true);
    expect(packages.has("@peculiar/x509")).toBe(false);
    expect(packages.has("reflect-metadata")).toBe(false);
  });
});
