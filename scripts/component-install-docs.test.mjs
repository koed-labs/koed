import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("overview and Desktop component inputs do not request signature sidecars", async () => {
  const docs = await readFile(
    new URL("../docs/running-koed.md", import.meta.url),
    "utf8"
  );
  const overview = docs
    .split("Service components, native runtime dependencies")[1]
    ?.split("`pnpm desktop:start`")[0];
  const desktop = docs
    .split("### Packaged Desktop first-run")[1]
    ?.split("Packaged Koed Desktop starts")[0];
  for (const section of [overview, desktop]) {
    assert.ok(section);
    assert.doesNotMatch(
      section,
      /signed metadata|signed archive|signature (?:paths|files)/
    );
    assert.match(section, /archive.*manifest/s);
    assert.match(section, /version-matched/);
  }
});

test("component provisioning examples use supported archive/manifest inputs", async () => {
  const docs = await readFile(
    new URL("../docs/running-koed.md", import.meta.url),
    "utf8"
  );
  const section = docs
    .split("### Explicit component provisioning")[1]
    ?.split("Task 7 focused evidence")[0];
  assert.ok(section);
  const examples = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
    (match) => match[1]
  );
  assert.equal(examples.length, 2);
  for (const example of examples) {
    assert.match(example, /koed components install --component base/);
    assert.doesNotMatch(example, /--signature(?:-url)?\b/);
  }
  assert.match(examples[0], /--archive \/path\/to\/base\.tar\.gz/);
  assert.match(examples[0], /--manifest \/path\/to\/base\.manifest\.json/);
  assert.match(examples[1], /--version 1\.2\.3/);
  assert.match(examples[1], /--archive-url https:\/\//);
  assert.match(examples[1], /--manifest-url https:\/\//);
  assert.match(
    section,
    /Another product version is rejected rather than staged/
  );
  assert.match(section, /Old-version components are never reused/);
});
