import assert from "node:assert/strict";
import test from "node:test";
import {
  createCandidateReaders,
  candidateAssetTransferTimeoutMs,
  runReleaseVerification
} from "./release-candidate-readers.mjs";
import {
  setupCandidate,
  verificationArgs
} from "./test-utils/release-candidate-fixture.mjs";
import { writeFileSync } from "node:fs";
import {
  parseArgs,
  runReleasePromotion
} from "./release-promotion-adapter.mjs";

test("verify-only CLI parses without signer options", () => {
  assert.equal(
    parseArgs(["--verify-only", "--expected-build", "expected.json"])
      .verifyOnly,
    true
  );
});
test("missing independent approval rejects before signer or remote access", async () => {
  await assert.rejects(
    runReleasePromotion(
      {},
      {
        signerToken: "must-not-use",
        run: () => {
          throw Error("REMOTE_CALLED");
        }
      }
    ),
    /Independent publication approval/
  );
});
test("expected identity file and immutable artifact ID/digest cannot be swapped", async () => {
  const f = await setupCandidate();
  try {
    const args = verificationArgs(f);
    assert.equal(
      (await runReleaseVerification(args, f.readers)).kind,
      "verified-release-candidate"
    );
    for (const changes of [
      { identityArtifactId: 100 },
      { identityArtifactDigest: `sha256:${"a".repeat(64)}` },
      { reviewedCommit: "f".repeat(40) },
      { approvedRunId: 43 }
    ])
      await assert.rejects(
        runReleaseVerification({ ...args, ...changes }, f.readers),
        /artifact mismatch/
      );
    writeFileSync(
      args.expectedBuild,
      JSON.stringify({ ...f.expected, commit: "f".repeat(40) })
    );
    await assert.rejects(
      runReleaseVerification(args, f.readers),
      /expected-build digest mismatch/
    );
  } finally {
    f.cleanup();
  }
});

test("large asset transfers have a bounded 20-minute budget", () => {
  assert.equal(candidateAssetTransferTimeoutMs, 20 * 60 * 1000);
});

test("asset reader exposes response stream and rejects HTTP errors", async () => {
  const readers = createCandidateReaders({
    fetchImpl: async () =>
      new Response("abcd", { headers: { "content-length": "1" } })
  });
  const stream = await readers.getAsset("org/repo", 1);
  assert.equal(typeof stream.getReader, "function");
  assert.equal(await new Response(stream).text(), "abcd");
  const failed = createCandidateReaders({
    fetchImpl: async () => new Response("error", { status: 403 })
  });
  await assert.rejects(failed.getAsset("org/repo", 1), /HTTP 403/);
});

test("reader surface permits GET only, without generic execution or writes", async () => {
  const requests = [];
  const readers = createCandidateReaders({
    token: "read-only",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: 1 }));
    }
  });
  await readers.getWorkflowRun("org/repo", 1);
  await readers.getArtifact("org/repo", 2);
  await readers.getRelease("org/repo", 3);
  await readers.getAsset("org/repo", 4);
  await readers.getRegistryVersion("@koed-labs/server", "1.2.3");
  assert.equal(requests.length, 5);
  for (const request of requests) assert.equal(request.options.method, "GET");
  assert.equal(requests.at(-1).options.headers, undefined);
  assert.throws(() => readers.getRelease("org/../evil", 1), /repository/);
  assert.throws(
    () => readers.getAsset("org/repo", "1?method=DELETE"),
    /identity/
  );
  assert.equal(readers.run, undefined);
  assert.equal(readers.publish, undefined);
});
