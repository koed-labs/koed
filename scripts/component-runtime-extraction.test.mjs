import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import { extractFrozenComponents } from "./component-runtime-extraction.mjs";

test("extracts selected frozen archives rather than staging directories and rejects tampering", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-frozen-extract-test-"));
  try {
    const source = resolve(root, "source");
    for (const component of ["base", "privacy", "privacy-cpu"]) {
      mkdirSync(resolve(source, component), { recursive: true });
      writeFileSync(
        resolve(source, component, "marker"),
        `archive-${component}`
      );
    }
    const release = resolve(root, "release");
    const { components } = buildComponentReleaseSet({
      componentsRoot: source,
      outDir: release,
      version: "1.0.0",
      target: { platform: "linux", architecture: "x64" },
      runtimes: [
        {
          kind: "node",
          runtimeRange: ">=24 <27",
          nodeRange: ">=24 <27",
          minimumNapi: 10
        }
      ],
      requiredFiles: { base: ["marker"], privacy: ["marker"] }
    });
    writeFileSync(resolve(source, "base/marker"), "staging-changed");
    const dest = resolve(root, "extracted");
    await extractFrozenComponents(release, components, "privacy-cuda", dest);
    assert.equal(
      readFileSync(resolve(dest, "components/base/marker"), "utf8"),
      "archive-base"
    );
    assert.equal(
      readFileSync(resolve(dest, "components/privacy/marker"), "utf8"),
      "archive-privacy"
    );
    writeFileSync(resolve(release, components.base.archive), "tampered");
    await assert.rejects(
      extractFrozenComponents(
        release,
        components,
        "privacy-cpu",
        resolve(root, "tampered")
      ),
      /checksum/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
