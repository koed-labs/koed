#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalReleaseJson,
  verifyReleaseSignatures
} from "./release-promotion-adapter.mjs";

const main = async () => {
  const [
    directory,
    version,
    target,
    trustRootsPath,
    signerUrl,
    keyId,
    expectedDigest,
    expectedControlplaneDigest
  ] = process.argv.slice(2);
  if (
    [
      directory,
      version,
      target,
      trustRootsPath,
      signerUrl,
      keyId,
      expectedDigest,
      expectedControlplaneDigest
    ].some((value) => !value)
  )
    throw new Error(
      "Usage: release-signing-adapter <dir> <version> <target> <trust-roots> <signer-url> <key-id> <trust-roots-sha256> <controlplane-roots-sha256>;"
    );
  const rootsBytes = readFileSync(resolve(trustRootsPath));
  if (createHash("sha256").update(rootsBytes).digest("hex") !== expectedDigest)
    throw new Error("Signing trust roots digest mismatch.");
  const roots = JSON.parse(rootsBytes.toString("utf8"));
  const builtModule = await import(
    new URL(
      `../packages/koed-server/dist/component-trust-roots.js?${Date.now()}`,
      import.meta.url
    )
  );
  const builtRoots = Object.fromEntries(
    builtModule.productionComponentTrustRoots
  );
  const builtDigest = createHash("sha256")
    .update(canonicalReleaseJson(builtRoots))
    .digest("hex");
  if (
    builtDigest !== expectedControlplaneDigest ||
    canonicalReleaseJson(builtRoots) !== canonicalReleaseJson(roots.keys)
  )
    throw new Error(
      "Signing trust roots do not match roots embedded in built control-plane package."
    );
  const files = readdirSync(resolve(directory)).filter((name) =>
    name.endsWith(".manifest.json")
  );
  if (files.length !== 2)
    throw new Error("Expected base and privacy component manifests.");
  const requestUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  requestUrl.searchParams.set("audience", "koed-component-signer");
  const tokenResponse = await fetch(requestUrl, {
    headers: {
      authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
    }
  });
  if (!tokenResponse.ok)
    throw new Error(
      `GitHub OIDC token request failed: HTTP ${tokenResponse.status}.`
    );
  const { value: token } = await tokenResponse.json();
  const artifacts = [];
  for (const manifestName of files) {
    const manifestPath = resolve(directory, manifestName);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.productVersion !== version ||
      `${manifest.target?.platform}-${manifest.target?.architecture}` !== target
    )
      throw new Error(`Component manifest identity mismatch: ${manifestName}`);
    const response = await fetch(`${signerUrl.replace(/\/$/, "")}/v1/sign`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ keyId, manifest })
    });
    if (!response.ok)
      throw new Error(
        `External signer returned HTTP ${response.status} for ${manifestName}.`
      );
    const payload = await response.json();
    const signature = payload.signature ?? payload;
    if (signature.keyId !== keyId)
      throw new Error(
        `External signer returned unexpected key ID for ${manifestName}.`
      );
    const signaturePath = resolve(
      directory,
      manifestName.replace(/\.manifest\.json$/, ".signature.json")
    );
    writeFileSync(signaturePath, `${JSON.stringify(signature)}\n`, {
      flag: "w"
    });
    artifacts.push({
      manifest: manifestPath,
      signature: signaturePath,
      component: manifest.component,
      version,
      target
    });
  }
  const verified = verifyReleaseSignatures(artifacts, roots);
  console.log(
    JSON.stringify({
      ok: true,
      signed: verified.length,
      targets: verified.map(({ target }) => target)
    })
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
