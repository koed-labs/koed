import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import { parse } from "yaml";
import { format } from "oxfmt";
import { canonicalArtifactJson } from "../packages/koed-server/src/artifact-canonical-json.mjs";
import { refreshSourceRuntimeCatalogs } from "./refresh-source-runtime-catalogs.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(
  readFileSync(resolve(repoRoot, "config/source-runtime-catalogs.json"), "utf8")
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function published(tag = "v0.11.2", id = 1) {
  const native = structuredClone(baseline.native);
  native.minimumCoreVersion = "0.10.3";
  const content = new Map();
  for (const kind of ["core", "cuda"]) {
    const pin = native[kind];
    const recipe = { kind, fixture: tag };
    pin.recipeId = digest(canonicalArtifactJson(recipe));
    pin.runtimeVersion = tag.slice(1);
    pin.url = `https://github.com/koed-labs/koed/releases/download/${tag}/koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz`;
    const archive = Buffer.from(`synthetic ${kind} ${tag}`);
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind,
        recipe,
        recipeId: pin.recipeId,
        runtimeVersion: pin.runtimeVersion,
        target: pin.target,
        contracts: pin.contracts,
        inventory: [],
        ...(kind === "core"
          ? { components: pin.components }
          : { llamaCpp: pin.llamaCpp, cuda: pin.cuda })
      })
    );
    pin.sha256 = digest(archive);
    pin.manifestSha256 = digest(manifest);
    pin.archiveBytes = archive.length;
    pin.expandedBytes = manifest.length;
    content.set(pin.url.split("/").at(-1), archive);
    content.set(`native-${kind}-manifest.json`, manifest);
  }
  content.set(
    "native-runtime-catalog.json",
    Buffer.from(JSON.stringify(native))
  );
  const release = {
    id,
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-11-10T00:00:00Z",
    assets: [...content].map(([name, bytes], i) => ({
      id: id * 10 + i,
      name,
      size: bytes.length,
      digest: `sha256:${digest(bytes)}`,
      state: "uploaded",
      browser_download_url: `https://github.com/koed-labs/koed/releases/download/${tag}/${name}`
    }))
  };
  return { release, content, native };
}
function fixture(releases = [published()]) {
  mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, "scratch/catalog-refresh-test-"));
  roots.push(root);
  mkdirSync(resolve(root, "config"));
  mkdirSync(resolve(root, "scripts/native-runtime"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), '{"version":"0.12.0"}');
  writeFileSync(
    resolve(root, "scripts/native-runtime/core-compatibility.linux-x64.json"),
    '{"schemaVersion":1,"minimumCoreVersion":"0.10.3"}'
  );
  const destination = resolve(root, "config/source-runtime-catalogs.json");
  writeFileSync(destination, JSON.stringify(baseline));
  const calls = [];
  const readers = {
    listReleases: async () =>
      releases.map(({ release }) => structuredClone(release)),
    getRelease: async (_repo, id) =>
      structuredClone(releases.find((x) => x.release.id === id).release),
    getAsset: async (_repo, id) => {
      calls.push(id);
      const item = releases.find((x) =>
        x.release.assets.some((a) => a.id === id)
      );
      const asset = item.release.assets.find((a) => a.id === id);
      return (async function* () {
        yield item.content.get(asset.name);
      })();
    }
  };
  return {
    root,
    destination,
    readers,
    calls,
    releases,
    read: () => JSON.parse(readFileSync(destination, "utf8"))
  };
}

test("refresh verifies all five assets, commits only native pins, and reuses an unchanged reviewed release", async () => {
  const f = fixture();
  const first = await refreshSourceRuntimeCatalogs({
    repoRoot: f.root,
    readers: f.readers
  });
  assert.equal(first.state, "updated");
  assert.equal(first.sourceRelease, "v0.11.2");
  assert.deepEqual(f.read().native, f.releases[0].native);
  assert.equal(f.read().components, undefined);
  assert.equal(f.calls.length, 5);
  const snapshot = readFileSync(f.destination, "utf8");
  assert.equal(
    (
      await format("config/source-runtime-catalogs.json", snapshot, {
        printWidth: 80
      })
    ).code,
    snapshot
  );
  assert.equal(
    (
      await refreshSourceRuntimeCatalogs({
        repoRoot: f.root,
        readers: f.readers
      })
    ).state,
    "current"
  );
  assert.equal(f.calls.length, 6);
  assert.equal(readFileSync(f.destination, "utf8"), snapshot);
});

test("ignores drafts, prereleases, future versions, and releases without native catalogs", async () => {
  const good = published();
  const draft = published("v0.11.9", 2);
  draft.release.draft = true;
  const prerelease = published("v0.11.8", 3);
  prerelease.release.prerelease = true;
  const future = published("v1.0.0", 4);
  const absent = published("v0.11.7", 5);
  absent.release.assets = [];
  const f = fixture([draft, future, prerelease, absent, good]);
  assert.equal(
    (
      await refreshSourceRuntimeCatalogs({
        repoRoot: f.root,
        readers: f.readers
      })
    ).sourceRelease,
    good.release.tag_name
  );
});

for (const [label, mutate] of [
  [
    "corrupt catalog",
    (f) => {
      f.releases[0].content.set(
        "native-runtime-catalog.json",
        Buffer.from("{}")
      );
    }
  ],
  [
    "corrupt archive",
    (f) => {
      const name = [...f.releases[0].content.keys()][0];
      const bytes = Buffer.from(f.releases[0].content.get(name));
      bytes[0] ^= 255;
      f.releases[0].content.set(name, bytes);
    }
  ],
  [
    "corrupt manifest",
    (f) => {
      f.releases[0].content.set("native-cuda-manifest.json", Buffer.from("{}"));
    }
  ],
  [
    "missing GitHub digest",
    (f) => {
      delete f.releases[0].release.assets[0].digest;
    }
  ],
  [
    "conflicting asset digest",
    (f) => {
      f.releases[0].release.assets[0].digest = `sha256:${"e".repeat(64)}`;
    }
  ],
  [
    "wrong asset host",
    (f) => {
      f.releases[0].release.assets[0].browser_download_url =
        "https://example.com/archive";
    }
  ],
  [
    "duplicate asset",
    (f) => {
      f.releases[0].release.assets.push(f.releases[0].release.assets[0]);
    }
  ],
  [
    "raised compatibility floor",
    (f) => {
      writeFileSync(
        resolve(
          f.root,
          "scripts/native-runtime/core-compatibility.linux-x64.json"
        ),
        '{"schemaVersion":1,"minimumCoreVersion":"0.12.0"}'
      );
    }
  ]
])
  test(`keeps committed pins intact after ${label}`, async () => {
    const f = fixture();
    const before = readFileSync(f.destination, "utf8");
    mutate(f);
    await assert.rejects(
      refreshSourceRuntimeCatalogs({ repoRoot: f.root, readers: f.readers })
    );
    assert.equal(readFileSync(f.destination, "utf8"), before);
  });

test("rejects a coherently replaced catalog under the same reviewed release", async () => {
  const f = fixture();
  await refreshSourceRuntimeCatalogs({ repoRoot: f.root, readers: f.readers });
  const before = readFileSync(f.destination, "utf8");
  const item = f.releases[0];
  item.native.minimumCoreVersion = "0.10.4";
  const bytes = Buffer.from(JSON.stringify(item.native));
  item.content.set("native-runtime-catalog.json", bytes);
  Object.assign(item.release.assets.at(-1), {
    digest: `sha256:${digest(bytes)}`,
    size: bytes.length
  });
  await assert.rejects(
    refreshSourceRuntimeCatalogs({ repoRoot: f.root, readers: f.readers }),
    /already-reviewed/
  );
  assert.equal(readFileSync(f.destination, "utf8"), before);
});

test("does not allow an explicit downgrade or unpublished release", async () => {
  const f = fixture([published("v0.10.3")]);
  await assert.rejects(
    refreshSourceRuntimeCatalogs({
      repoRoot: f.root,
      tag: "v0.10.3",
      readers: f.readers
    }),
    /downgrade/
  );
  await assert.rejects(
    refreshSourceRuntimeCatalogs({
      repoRoot: f.root,
      tag: "v0.12.0",
      readers: f.readers
    }),
    /No published/
  );
});

test("rechecks release identity after downloads but ignores download counters", async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    let reads = 0;
    const get = f.readers.getRelease;
    f.readers.getRelease = async (...args) => {
      const release = await get(...args);
      if (++reads > 1) {
        release.assets[0].download_count = 42;
        if (changed) release.draft = true;
      }
      return release;
    };
    if (changed)
      await assert.rejects(
        refreshSourceRuntimeCatalogs({ repoRoot: f.root, readers: f.readers }),
        /changed while downloading/
      );
    else
      assert.equal(
        (
          await refreshSourceRuntimeCatalogs({
            repoRoot: f.root,
            readers: f.readers
          })
        ).state,
        "updated"
      );
  }
});

test("Version Koed runs pin refresh inside the Changesets version command", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8")
  );
  const workflow = parse(
    readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8")
  );
  const step = workflow.jobs.release.steps.find(
    (step) => step.id === "changesets"
  );
  assert.equal(step.with.version, "pnpm release:version");
  assert.match(
    manifest.scripts["release:version"],
    /sync-product-release.*&& pnpm source-runtime:refresh$/
  );
  assert.match(
    manifest.scripts["source-runtime:refresh"],
    /server build && node scripts\/refresh-source-runtime-catalogs\.mjs$/
  );
  assert.ok(step.env.GH_TOKEN);
  const ci = parse(
    readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8")
  );
  const smoke = ci.jobs.build.steps.find((step) =>
    step.run?.includes("scripts/source-runtime-cpu-smoke.mjs")
  );
  assert.match(
    smoke.run,
    /node scripts\/embed-source-runtime-catalogs\.mjs\s+node scripts\/source-runtime-cpu-smoke\.mjs/
  );
  assert.ok(
    ci.jobs.build.steps.findIndex((step) => step.run === "pnpm build") <
      ci.jobs.build.steps.indexOf(smoke)
  );
  assert.doesNotMatch(smoke.run, /source-runtime:prepare|pnpm build/);
});
