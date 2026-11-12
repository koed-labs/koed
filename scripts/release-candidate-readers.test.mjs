import assert from "node:assert/strict";
import test from "node:test";
import {
  createCandidateReaders,
  candidateAssetTransferTimeoutMs,
  runReleaseVerification
} from "./release-candidate-readers.mjs";
import {
  setupCandidate as setupFixture,
  verificationArgs
} from "./test-utils/release-candidate-fixture.mjs";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  parseArgs,
  runReleasePromotion
} from "./release-promotion-adapter.mjs";

const setupCandidate = (options = {}) =>
  setupFixture({ ...options, native: true });

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
  const requests = [];
  const readers = createCandidateReaders({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response("abcd", { headers: { "content-length": "1" } });
    }
  });
  const stream = await readers.getAsset("org/repo", 1);
  assert.equal(typeof stream.getReader, "function");
  assert.equal(await new Response(stream).text(), "abcd");
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/org/repo/releases/assets/1"
  );
  assert.equal(requests[0].options.headers.accept, "application/octet-stream");
  const failed = createCandidateReaders({
    fetchImpl: async () => new Response("error", { status: 403 })
  });
  await assert.rejects(failed.getAsset("org/repo", 1), /HTTP 403/);
});

test("private artifact reader downloads exact ID as a stream and rejects invalid identities", async () => {
  const requests = [];
  const readers = createCandidateReaders({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response("artifact bytes");
    }
  });
  const stream = await readers.getArtifactArchive("org/repo", 42);
  assert.equal(await new Response(stream).text(), "artifact bytes");
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/org/repo/actions/artifacts/42/zip"
  );
  assert.equal(requests[0].options.method, "GET");
  // GitHub answers HTTP 415 when this endpoint is asked for octet-stream.
  assert.equal(
    requests[0].options.headers.accept,
    "application/vnd.github+json"
  );
  assert.throws(
    () => readers.getArtifactArchive("org/../evil", 42),
    /repository/
  );
  assert.throws(
    () => readers.getArtifactArchive("org/repo", "42?x=1"),
    /identity/
  );
  const failed = createCandidateReaders({
    fetchImpl: async () => new Response("expired", { status: 410 })
  });
  await assert.rejects(failed.getArtifactArchive("org/repo", 42), /HTTP 410/);
});

test("artifact redirect never forwards authorization to cross-origin storage", async () => {
  let storageAuthorization;
  let apiAuthorization;
  const storage = createServer((request, response) => {
    storageAuthorization = request.headers.authorization;
    response.end("artifact");
  });
  storage.listen(0, "127.0.0.1");
  await once(storage, "listening");
  const api = createServer((request, response) => {
    apiAuthorization = request.headers.authorization;
    response.writeHead(302, {
      location: `http://127.0.0.1:${storage.address().port}/file`
    });
    response.end();
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  try {
    const readers = createCandidateReaders({
      token: "synthetic-token",
      fetchImpl: (url, options) =>
        fetch(
          `http://127.0.0.1:${api.address().port}${new URL(url).pathname}`,
          options
        )
    });
    assert.equal(
      await new Response(
        await readers.getArtifactArchive("org/repo", 42)
      ).text(),
      "artifact"
    );
    assert.equal(apiAuthorization, "Bearer synthetic-token");
    assert.equal(storageAuthorization, undefined);
  } finally {
    api.close();
    storage.close();
  }
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
  await readers.listReleases("org/repo", 2);
  await readers.getWorkflowRun("org/repo", 1);
  await readers.getArtifact("org/repo", 2);
  await readers.getRelease("org/repo", 3);
  await readers.getAsset("org/repo", 4);
  await readers.getRegistryVersion("@koed-labs/server", "1.2.3");
  assert.equal(requests.length, 6);
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/org/repo/releases?per_page=100&page=2"
  );
  for (const request of requests) assert.equal(request.options.method, "GET");
  assert.equal(requests.at(-1).options.headers, undefined);
  assert.throws(() => readers.getRelease("org/../evil", 1), /repository/);
  assert.throws(
    () => readers.listReleases("org/repo", "1&draft=true"),
    /identity/
  );
  assert.throws(
    () => readers.getAsset("org/repo", "1?method=DELETE"),
    /identity/
  );
  assert.equal(readers.run, undefined);
  assert.equal(readers.publish, undefined);
});
