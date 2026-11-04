import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { publishCore } from "./publish-core.mjs";

test("native workflow preserves independent approval, protected candidate digests and retention", () => {
  const source = readFileSync(
    new URL("../../.github/workflows/native-runtime-core.yml", import.meta.url),
    "utf8"
  );
  const workflow = parse(source);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.publish.environment, "production");
  assert.equal(workflow.jobs.publish.needs, "candidate");
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
  assert.match(workflow.jobs.candidate.if, /default_branch/);
  const steps = workflow.jobs.publish.steps;
  const authenticate = steps.findIndex((step) => step.env?.CANDIDATE_SHA256);
  const publish = steps.findIndex((step) => step.run?.includes("--publish"));
  assert.ok(authenticate >= 0 && authenticate < publish);
  assert.match(
    steps[authenticate].env.CANDIDATE_SHA256,
    /needs\.candidate\.outputs\.candidate_sha256/
  );
  assert.match(
    steps[authenticate].env.QUALIFICATION_SHA256,
    /needs\.candidate\.outputs\.qualification_sha256/
  );
  const publisher = readFileSync(
    new URL("./publish-core.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    publisher,
    /verifyWorkflowApproval\(candidate\.runtimeVersion\)/
  );
  assert.doesNotMatch(
    source + publisher,
    /--clobber|release delete|delete-tag|--method["' ]+DELETE/
  );
  assert.doesNotMatch(source, /cuda-toolkit|nvidia-smi|--gpu-backend/);
});

const fixture = ({ published = false, present = 0 } = {}) => {
  const commit = "c".repeat(40);
  const candidate = {
    tag: `native-core-${"a".repeat(64)}`,
    recipeId: "a".repeat(64),
    runtimeVersion: "1.0.0",
    sha256: "b".repeat(64),
    assets: [
      "core.tar.gz",
      "core-candidate.json",
      "native-core-manifest.json",
      "qualification.json"
    ].map((name, i) => ({
      name,
      path: `/candidate/${name}`,
      bytes: 10 + i,
      sha256: String(i).repeat(64)
    }))
  };
  const state = { release: null, tag: null, changes: [], releases: [] };
  const asset = (expected, id) => ({
    id,
    name: expected.name,
    size: expected.bytes,
    state: "uploaded",
    hash: expected.sha256
  });
  if (published || present) {
    state.release = {
      id: 1,
      name: "Native CPU core 1.0.0",
      tag_name: candidate.tag,
      target_commitish: commit,
      prerelease: false,
      draft: !published,
      immutable: published,
      assets: candidate.assets.slice(0, published ? 4 : present).map(asset)
    };
    state.tag = commit;
  }
  const client = {
    listReleases: async () => [
      ...state.releases,
      ...(state.release ? [structuredClone(state.release)] : [])
    ],
    getTagCommit: async () => state.tag,
    createRelease: async (body) => {
      state.changes.push(["create", body]);
      state.release = { id: 1, ...body, assets: [] };
      return structuredClone(state.release);
    },
    upload: async (tag, path) => {
      assert.equal(state.release.draft, true);
      assert.equal(tag, candidate.tag);
      const expected = candidate.assets.find((item) => item.path === path);
      assert.ok(expected);
      assert.ok(
        !state.release.assets.some((item) => item.name === expected.name)
      );
      state.changes.push(["upload", expected.name]);
      state.release.assets.push(asset(expected, state.release.assets.length));
    },
    hashAsset: async (id) =>
      state.release.assets.find((item) => item.id === id).hash,
    getRelease: async () => structuredClone(state.release),
    publishRelease: async (id, body) => {
      assert.equal(id, 1);
      assert.equal(state.release.assets.length, candidate.assets.length);
      assert.equal(body.make_latest, "false");
      state.changes.push(["publish", body]);
      Object.assign(state.release, body);
      state.tag = commit;
      return structuredClone(state.release);
    },
    getLatestRelease: async () => ({ tag_name: "v0.10.3" })
  };
  return { candidate, commit, client, state };
};

test("native publication uploads a complete authenticated draft before publishing without latest", async () => {
  const f = fixture();
  const result = await publishCore(f);
  assert.equal(result.published, true);
  assert.deepEqual(
    f.state.changes.map(([kind]) => kind),
    ["create", "upload", "upload", "upload", "upload", "publish"]
  );
  assert.equal(f.state.changes[0][1].make_latest, "false");
  assert.equal(f.state.changes[0][1].draft, true);
});

test("published native retry authenticates retained assets without mutation, even after a newer core", async () => {
  const f = fixture({ published: true });
  f.state.releases.push({
    tag_name: `native-core-${"e".repeat(64)}`,
    name: "Native CPU core 2.0.0",
    draft: false
  });
  assert.equal((await publishCore(f)).immutable, true);
  assert.deepEqual(f.state.changes, []);
});

test("partial draft retry uploads only missing identical assets", async () => {
  const f = fixture({ present: 2 });
  await publishCore(f);
  assert.deepEqual(
    f.state.changes.map(([kind]) => kind),
    ["upload", "upload", "publish"]
  );
});

for (const published of [false, true]) {
  test(`changed retained bytes refuse replacement in a ${published ? "published release" : "draft"}`, async () => {
    const f = fixture({ published, present: 2 });
    f.state.release.assets[0].hash = "f".repeat(64);
    await assert.rejects(publishCore(f), /Changed native asset/);
    assert.deepEqual(f.state.changes, []);
  });
}

test("missing published assets refuse repair through mutation", async () => {
  const f = fixture({ published: true });
  f.state.release.assets.pop();
  await assert.rejects(publishCore(f), /Missing retained/);
  assert.deepEqual(f.state.changes, []);
});

test("conflicting tags refuse without moving or deleting them", async () => {
  const f = fixture();
  f.state.tag = "f".repeat(40);
  await assert.rejects(publishCore(f), /different commit/);
  assert.deepEqual(f.state.changes, []);
});

test("new recipes require a monotonic runtime version", async () => {
  const f = fixture();
  f.state.releases.push({
    tag_name: `native-core-${"e".repeat(64)}`,
    name: "Native CPU core 1.0.0",
    draft: false
  });
  await assert.rejects(publishCore(f), /greater runtime version/);
  assert.deepEqual(f.state.changes, []);
});

test("unexpected retained assets refuse publication", async () => {
  const f = fixture({ present: 2 });
  f.state.release.assets.push({ name: "unreviewed.so" });
  await assert.rejects(publishCore(f), /asset set conflicts/);
  assert.deepEqual(f.state.changes, []);
});
