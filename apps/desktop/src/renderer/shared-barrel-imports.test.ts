import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** The renderer runs in a browser. A runtime import from the whole
 * `@koed-labs/shared` package pulls modules that use Node's `crypto` into the
 * bundle and the window crashes at start-up (`createHash is not a function`),
 * which unit tests running in Node never notice. The renderer must take
 * runtime values from a browser-safe subpath such as
 * `@koed-labs/shared/personal-desktop`; types from the root are fine. */
const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [path]
      : [];
  });

const rootImport =
  /import\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']@koed-labs\/shared["']/g;

describe("renderer imports from @koed-labs/shared", () => {
  it("never take a runtime value from the package root", () => {
    const renderer = join(import.meta.dirname);
    const offenders: string[] = [];
    for (const file of sources(renderer)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(rootImport)) {
        if (match[1]) continue;
        const named = (match[3] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        const runtime = named.filter((item) => !item.startsWith("type "));
        if (match[2] || runtime.length > 0)
          offenders.push(
            `${relative(renderer, file)}: ${[match[2], ...runtime].filter(Boolean).join(", ")}`
          );
      }
    }
    expect(offenders).toEqual([]);
  });
});
