import test from "node:test";
import assert from "node:assert/strict";
import { syncChangelogs } from "./product-changelog.mjs";

test("merges current release notes once and preserves historical content", () => {
  const root =
    "# Koed\n\n## 1.0.0\n\n### Patch Changes\n\n- shared\n\n## 0.9.0\n\nOld root history.\n";
  const desktop = "# @koed-labs/desktop\n\n## 0.1.1\n\nOld desktop history.\n";
  const product =
    "# @koed-labs/koed\n\n## 1.0.0\n\n### Patch Changes\n\n- shared\n- product\n\n## 0.9.0\n\nProduct history.\n";
  const server =
    "# server\n\n## 1.0.0\n\n### Patch Changes\n\n- shared\n- server\n  continuation\n\n## 0.9.0\n\nServer history.\n";
  const result = syncChangelogs({
    root,
    desktop,
    product,
    server,
    version: "1.0.0"
  });
  assert.match(
    result.root,
    /- shared\n\n- product\n\n- server\n {2}continuation/
  );
  assert.ok(result.root.endsWith("## 0.9.0\n\nOld root history.\n"));
  assert.equal(
    result.desktop,
    "# @koed-labs/desktop\n\n## 1.0.0\n\n## 0.1.1\n\nOld desktop history.\n"
  );
  assert.deepEqual(
    syncChangelogs({ ...result, product, server, version: "1.0.0" }),
    result
  );
});

test("creates current headings when only server has notes", () => {
  const result = syncChangelogs({
    root: "# Koed\n\n## 0.9.0\n\nHistory\n",
    desktop: "# @koed-labs/desktop\n",
    product: "# product\n",
    server: "# server\n\n## 1.0.0\n\n### Patch Changes\n\n- fix\n",
    version: "1.0.0"
  });
  assert.equal(
    result.root,
    "# Koed\n\n## 1.0.0\n\n### Patch Changes\n\n- fix\n\n## 0.9.0\n\nHistory\n"
  );
  assert.equal(result.desktop, "# @koed-labs/desktop\n\n## 1.0.0\n");
});

test("preserves prose and fenced heading examples in release notes", () => {
  const input = {
    root: "# Koed\n\n## 0.9.0\n\nHistory\n",
    desktop: "# desktop\n",
    product:
      "# product\n\n## 1.0.0\n\n### Patch Changes\n\nIntro paragraph.\n\n- Example:\n\n  ```md\n## not a release\n### not a section\n  ```\n\n- Another\n",
    server: "# server\n",
    version: "1.0.0"
  };
  const result = syncChangelogs(input);
  assert.ok(result.root.includes("Intro paragraph."));
  assert.ok(result.root.includes("## not a release\n### not a section"));
  assert.ok(result.root.includes("- Another"));
  assert.deepEqual(syncChangelogs({ ...input, ...result }), result);
});
