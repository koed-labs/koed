/* global Buffer, Response */
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import {
  authenticate,
  authorizeClaims,
  crc32c,
  createKmsClient,
  signingMessage,
  verifyEnvelope
} from "./service.mjs";
const config = {
  keyId: "test-key",
  keyVersion:
    "projects/test/locations/europe-west2/keyRings/release/cryptoKeys/signing/cryptoKeyVersions/1",
  repositoryId: "1239895353",
  ownerId: "284669191"
};
const claims = {
  repository: "koed-labs/koed",
  repository_id: config.repositoryId,
  repository_owner_id: config.ownerId,
  ref: "refs/heads/main",
  workflow_ref: "koed-labs/koed/.github/workflows/release.yml@refs/heads/main",
  event_name: "push"
};
const manifest = {
  schemaVersion: 1,
  productVersion: "0.8.1",
  component: "base",
  target: { platform: "macos", architecture: "arm64" },
  runtimes: [
    {
      kind: "node",
      runtimeRange: ">=24 <25",
      nodeRange: ">=24 <25",
      modulesAbi: "137",
      minimumNapi: 10
    }
  ],
  archive: {
    name: "koed-base-0.8.1-macos-arm64.tar.gz",
    bytes: 1,
    sha256: "a".repeat(64)
  },
  requiredFiles: ["entry.js"],
  files: [{ path: "entry.js", sha256: "b".repeat(64) }]
};
test("authorizes release main workflow and rejects removed recovery workflow", () => {
  authorizeClaims(claims, config);
  assert.throws(
    () =>
      authorizeClaims(
        {
          ...claims,
          workflow_ref:
            "koed-labs/koed/.github/workflows/release-desktop-assets.yml@refs/heads/main",
          event_name: "workflow_dispatch"
        },
        config
      ),
    /not authorized/
  );
  for (const change of [
    { repository_id: "1" },
    { repository_owner_id: "1" },
    { ref: "refs/heads/fix" },
    {
      workflow_ref: "koed-labs/koed/.github/workflows/tests.yml@refs/heads/main"
    },
    { event_name: "pull_request" }
  ])
    assert.throws(() => authorizeClaims({ ...claims, ...change }, config));
});
test("cryptographically rejects expired, wrong-audience and forged JWTs", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(rsa.publicKey);
  jwk.kid = "test";
  jwk.alg = "RS256";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const make = (audience, expires, pair = rsa) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience(audience)
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) - 1)
      .setExpirationTime(expires)
      .sign(pair.privateKey);
  const good = await make("koed-component-signer", "5m");
  await authenticate(`Bearer ${good}`, config, keys);
  for (const token of [
    await make("wrong", "5m"),
    await make("koed-component-signer", Math.floor(Date.now() / 1000) - 10),
    await make(
      "koed-component-signer",
      "5m",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
    )
  ])
    await assert.rejects(authenticate(`Bearer ${token}`, config, keys));
});
test("validates manifest and key identity before signing, and rejects old/tampered envelopes", () => {
  const keys = generateKeyPairSync("ed25519");
  const message = signingMessage({ keyId: config.keyId, manifest }, config);
  assert.equal(message.length, 66);
  assert.throws(() => signingMessage({ keyId: "other", manifest }, config));
  assert.throws(() =>
    signingMessage(
      { keyId: config.keyId, manifest: { ...manifest, component: "other" } },
      config
    )
  );
  const envelope = {
    schemaVersion: 2,
    keyId: config.keyId,
    algorithm: "ed25519",
    signature: sign(null, message, keys.privateKey).toString("base64")
  };
  assert.equal(verifyEnvelope(envelope, message, config, keys.publicKey), true);
  assert.equal(
    verifyEnvelope(
      { ...envelope, schemaVersion: 1 },
      message,
      config,
      keys.publicKey
    ),
    false
  );
  const changed = signingMessage(
    { keyId: config.keyId, manifest: { ...manifest, productVersion: "0.8.2" } },
    config
  );
  assert.equal(
    verifyEnvelope(envelope, changed, config, keys.publicKey),
    false
  );
});
test("KMS uses raw data and rejects incorrect response integrity or key version", async () => {
  assert.equal(crc32c(Buffer.from("123456789")), 0xe3069283);
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" });
  const message = signingMessage({ keyId: config.keyId, manifest }, config);
  for (const corrupt of [null, "crc", "version", "input"]) {
    const request = async (url, options) => {
      if (url.startsWith("http://metadata"))
        return new Response(
          JSON.stringify({ access_token: "fake", expires_in: 3600 }),
          { headers: { "Metadata-Flavor": "Google" } }
        );
      if (url.endsWith("/publicKey"))
        return new Response(
          JSON.stringify({
            name: config.keyVersion,
            algorithm: "EC_SIGN_ED25519",
            pem,
            pemCrc32c: String(crc32c(Buffer.from(pem)))
          })
        );
      const body = JSON.parse(options.body);
      assert.equal(body.digest, undefined);
      assert.equal(body.dataCrc32c, String(crc32c(message)));
      const raw = sign(null, Buffer.from(body.data, "base64"), pair.privateKey);
      return new Response(
        JSON.stringify({
          name: corrupt === "version" ? "wrong" : config.keyVersion,
          signature: raw.toString("base64"),
          signatureCrc32c: String(corrupt === "crc" ? 0 : crc32c(raw)),
          verifiedDataCrc32c: corrupt !== "input"
        })
      );
    };
    const client = createKmsClient(config, request);
    if (corrupt)
      await assert.rejects(client.sign(message), /integrity mismatch/);
    else
      assert.equal(
        verifyEnvelope(
          await client.sign(message),
          message,
          config,
          pair.publicKey
        ),
        true
      );
  }
});

test("rehearsal requires explicit pin plus exact repository, workflow, ref and event", () => {
  const pin = "a".repeat(40);
  const rehearsal = {
    ...claims,
    sha: pin,
    ref: "refs/heads/codex/headless-distribution-fixes",
    workflow_ref:
      "koed-labs/koed/.github/workflows/ci.yml@refs/heads/codex/headless-distribution-fixes",
    event_name: "workflow_dispatch"
  };
  authorizeClaims(rehearsal, { ...config, rehearsalSha: pin });
  assert.throws(() => authorizeClaims(rehearsal, config));
  for (const change of [
    { sha: "b".repeat(40) },
    { repository_id: "1" },
    { workflow_ref: claims.workflow_ref },
    { event_name: "pull_request" },
    { ref: "refs/heads/other" }
  ])
    assert.throws(() =>
      authorizeClaims(
        { ...rehearsal, ...change },
        { ...config, rehearsalSha: pin }
      )
    );
});
