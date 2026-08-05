import { describe, expect, it } from "vitest";

import { parseSourcePatch } from "./source-diff.js";

describe("source diff parsing", () => {
  it("normalizes a multi-file Codex patch and reports per-file changes", () => {
    const details = parseSourcePatch(`*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Add File: src/new.ts
@@
+export const created = true;
*** Delete File: src/old.ts
@@
-export const removed = true;
*** End Patch`);

    expect(details).toMatchObject({
      supported: true,
      additions: 2,
      deletions: 2
    });
    expect(details?.files.map(({ displayName }) => displayName)).toEqual([
      "app.ts",
      "new.ts",
      "old.ts"
    ]);
    expect(details?.normalizedText).toContain("@@ -0,0 +1,1 @@");
    expect(details?.normalizedText).toContain("@@ -1,1 +0,0 @@");
    expect(details?.summary).toContain("3 files changed");
  });

  it("parses a standard unified diff", () => {
    const details = parseSourcePatch(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-old
+new`);
    expect(details).toMatchObject({
      supported: true,
      files: [
        expect.objectContaining({
          displayName: "app.ts",
          additions: 1,
          deletions: 1
        })
      ]
    });
  });

  it("returns a raw fallback model for an unparseable patch", () => {
    const details = parseSourcePatch("*** Begin Patch\n*** End Patch");
    expect(details).toMatchObject({
      supported: false,
      parseError: "Patch text could not be normalized"
    });
  });

  it("preserves long source lines for horizontal diff scrolling", () => {
    const longLine = "x".repeat(8_000);
    const details = parseSourcePatch(`diff --git a/src/long.ts b/src/long.ts
--- a/src/long.ts
+++ b/src/long.ts
@@ -1,1 +1,1 @@
-short
+${longLine}`);

    expect(details).toMatchObject({
      supported: true,
      additions: 1,
      deletions: 1
    });
    expect(details?.normalizedText).toContain(longLine);
  });

  it("does not treat ordinary text as a source diff", () => {
    expect(parseSourcePatch("Discuss a possible source change.")).toBeNull();
  });
});
