import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  setupCandidate,
  verificationArgs
} from "./test-utils/release-candidate-fixture.mjs";
import {
  runReleasePromotion,
  verifyNpmCandidate,
  parseArgs
} from "./release-promotion-adapter.mjs";

for (const flag of [
  "--trust-roots",
  "--trust-roots-sha256",
  "--controlplane-trust-roots-sha256",
  "--signer-url",
  "--signer-key-id"
])
  test(`removed signing option rejects: ${flag}`, () => {
    assert.throws(() => parseArgs([flag, "unused"]), /Unknown option/);
  });

test("verify-only ignores mutation capabilities; publication rejects without separate approval before any I/O", async () => {
  const f = await setupCandidate({ desktop: true });
  try {
    const args = verificationArgs(f);
    let calls = 0;
    const forbidden = () => {
      calls++;
      throw new Error("mutation capability touched");
    };
    const adapters = {
      readers: f.readers,
      run: forbidden,
      fetchRegistry: forbidden
    };
    const receipt = await runReleasePromotion(
      { ...args, verifyOnly: true },
      adapters
    );
    assert.equal(receipt.kind, "verified-release-candidate");
    await assert.rejects(
      runReleasePromotion(args, {
        ...adapters,
        readers: new Proxy({}, { get: forbidden })
      }),
      /Independent publication approval/
    );
    assert.equal(calls, 0);
    assert.equal(parseArgs(["--verify-only"]).verifyOnly, true);
    assert.throws(
      () => parseArgs(["--expected-build", "--verify-only"]),
      /Missing or duplicate/
    );
  } finally {
    f.cleanup();
  }
});

test("candidate failures block all publication adapters even with independent approval", async () => {
  const cases = [
    (f) => f.contents.delete("component-manifest-hashes.json"),
    (f) => f.contents.set("component-manifest-hashes.json", Buffer.from("{}")),
    (f) =>
      f.contents.set("koed-labs-server.tgz", Buffer.from("substituted npm")),
    (f) =>
      f.contents.set(
        f.expected.desktop.asset,
        Buffer.from("substituted Desktop")
      ),
    (f) => {
      const getWorkflowRun = f.readers.getWorkflowRun;
      f.readers.getWorkflowRun = async () => ({
        ...(await getWorkflowRun()),
        head_sha: "f".repeat(40)
      });
    },
    (f) => {
      f.expected.npm.integrity = `sha512-${"a".repeat(88)}`;
    },
    (f) => {
      f.release.draft = false;
    },
    (f) => {
      f.readers.getAsset = async () => {
        throw new Error("unavailable candidate");
      };
    }
  ];
  for (const alter of cases) {
    const f = await setupCandidate({ desktop: true });
    try {
      alter(f);
      let calls = 0;
      const forbidden = () => {
        calls++;
        throw new Error("mutation touched");
      };
      await assert.rejects(
        runReleasePromotion(verificationArgs(f), {
          publicationApproved: true,
          readers: f.readers,
          run: forbidden,
          fetchRegistry: forbidden
        })
      );
      assert.equal(calls, 0);
    } finally {
      f.cleanup();
    }
  }
});

for (const downloadDrift of [
  false,
  "manifest",
  "archive",
  "catalog",
  "tarball",
  "identity",
  "recheck"
])
  test(`pin-only promotion verifies frozen assets before mutation (download drift: ${downloadDrift})`, async () => {
    const f = await setupCandidate({ desktop: true });
    try {
      assert.ok(
        ![...f.contents.keys()].some((name) => name.endsWith(".signature.json"))
      );
      const args = verificationArgs(f);
      let published = false;
      const mutations = [];
      const downloads = [];
      const tarCalls = [];
      const metadata = {
        name: "@koed-labs/server",
        version: "1.2.3",
        dist: { integrity: f.identity.npm.integrity }
      };
      f.readers.getRegistryVersion = async (_name, version) =>
        version === "latest" || !published ? null : metadata;
      const driftNames = {
        manifest: "koed-base-1.2.3-linux-x64.tar.gz.manifest.json",
        archive: "koed-base-1.2.3-linux-x64.tar.gz",
        catalog: "component-manifest-hashes.json",
        tarball: "koed-labs-server.tgz",
        identity: "koed-labs-server-release-identity.json"
      };
      const adapters = {
        publicationApproved: true,
        readers: f.readers,
        run: (command, argv, options = {}) => {
          if (command === "tar") {
            tarCalls.push(argv);
            return execFileSync(command, argv, { encoding: "utf8" });
          }
          if (command === "gh" && !argv.includes("PATCH")) {
            const assetId = Number(argv.at(-1).split("/").at(-1));
            if (argv.includes("Accept: application/octet-stream")) {
              const asset = f.release.assets.find(
                (item) => item.id === assetId
              );
              downloads.push(asset.name);
              const bytes = f.contents.get(asset.name);
              writeFileSync(
                options.stdio[1],
                asset.name === driftNames[downloadDrift]
                  ? downloadDrift === "catalog"
                    ? Buffer.from("not JSON")
                    : Buffer.concat([bytes, Buffer.from("\n")])
                  : bytes
              );
              if (downloadDrift === "recheck") f.release.draft = false;
              return "";
            }
            return JSON.stringify(f.release);
          }
          mutations.push([command, ...argv]);
          if (command === "npm" && argv[0] === "publish") published = true;
          if (command === "gh" && argv.includes("PATCH"))
            f.release.draft = false;
          return "";
        },
        fetchRegistry: async (_name, version) =>
          version === "latest" || !published ? null : metadata
      };
      if (downloadDrift) {
        await assert.rejects(
          runReleasePromotion(args, adapters),
          downloadDrift === "catalog"
            ? /Release asset differs from protected build/
            : /protected build|Frozen component|not canonical|draft|Candidate changed/
        );
        assert.equal(
          mutations.length,
          0,
          "drift must reject before npm/GitHub mutation"
        );
        if (["tarball", "identity"].includes(downloadDrift))
          assert.equal(
            tarCalls.length,
            0,
            "unreviewed package bytes must not reach tar"
          );
        return;
      }
      const result = await runReleasePromotion(args, adapters);
      assert.equal(result.ok, true);
      assert.equal(result.verifiedComponents, 4);
      assert.ok(!downloads.some((name) => name.endsWith(".signature.json")));
      assert.equal(
        mutations.filter(
          ([cmd, action]) => cmd === "npm" && action === "publish"
        ).length,
        1
      );
      const latestAt = mutations.findIndex(
        ([cmd, , , , tag]) => cmd === "npm" && tag === "latest"
      );
      const patchAt = mutations.findIndex(
        ([cmd, ...argv]) => cmd === "gh" && argv.includes("PATCH")
      );
      assert.ok(patchAt >= 0 && latestAt > patchAt, "GitHub before npm latest");
      // Published release assets are re-downloaded and re-verified after PATCH.
      // 11 immutable assets verified before mutation, then again after publish.
      assert.equal(downloads.length, 22);
      mutations.length = 0;
      f.release.draft = true;
      f.contents.set(
        "component-manifest-hashes.json",
        Buffer.from("substituted")
      );
      await assert.rejects(runReleasePromotion(args, adapters), /digest/);
      assert.equal(mutations.length, 0);
    } finally {
      f.cleanup();
    }
  });

test("registry package/version/SRI must match exact candidate", async () => {
  const expected = {
    packageName: "@koed-labs/server",
    version: "1.0.0",
    integrity: "sha512-YWJj"
  };
  const metadata = {
    name: expected.packageName,
    version: expected.version,
    dist: { integrity: expected.integrity }
  };
  assert.deepEqual(await verifyNpmCandidate(expected, async () => metadata), {
    verified: true
  });
  for (const actual of [
    null,
    { ...metadata, name: "wrong" },
    { ...metadata, version: "2.0.0" },
    { ...metadata, dist: { integrity: "sha512-d3Jvbmc=" } }
  ])
    await assert.rejects(
      verifyNpmCandidate(expected, async () => actual),
      /missing|mismatch/
    );
});

for (const failure of ["patch-fails", "published-bytes-drift"])
  test(`npm latest is never promoted when GitHub publication fails verification (${failure})`, async () => {
    const f = await setupCandidate({ desktop: true });
    try {
      let published = false;
      const mutations = [];
      const metadata = {
        name: "@koed-labs/server",
        version: "1.2.3",
        dist: { integrity: f.identity.npm.integrity }
      };
      const adapters = {
        publicationApproved: true,
        readers: f.readers,
        run: (command, argv, options = {}) => {
          if (command === "tar")
            return execFileSync(command, argv, { encoding: "utf8" });
          if (command === "gh" && !argv.includes("PATCH")) {
            if (argv.includes("Accept: application/octet-stream")) {
              const assetId = Number(argv.at(-1).split("/").at(-1));
              const asset = f.release.assets.find(
                (item) => item.id === assetId
              );
              const bytes = f.contents.get(asset.name);
              writeFileSync(
                options.stdio[1],
                failure === "published-bytes-drift" &&
                  f.release.draft === false &&
                  asset.name === "koed-labs-server.tgz"
                  ? Buffer.concat([bytes, Buffer.from("\n")])
                  : bytes
              );
              return "";
            }
            return JSON.stringify(f.release);
          }
          mutations.push([command, ...argv]);
          if (command === "npm" && argv[0] === "publish") published = true;
          if (command === "gh" && argv.includes("PATCH")) {
            if (failure === "patch-fails") throw new Error("PATCH failed");
            f.release.draft = false;
          }
          return "";
        },
        fetchRegistry: async (_name, version) =>
          version === "latest" || !published ? null : metadata
      };
      await assert.rejects(
        runReleasePromotion(verificationArgs(f), adapters),
        /PATCH failed|differs from protected build/
      );
      assert.ok(
        !mutations.some(
          ([cmd, , , , tag]) => cmd === "npm" && tag === "latest"
        ),
        "npm latest must not move"
      );
    } finally {
      f.cleanup();
    }
  });
