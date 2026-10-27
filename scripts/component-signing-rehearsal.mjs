import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildComponentManifest,
  canonicalComponentManifestBytes
} from "./koed-server-package-lib.mjs";
import { writeDeterministicTarGz } from "./deterministic-tar-gzip.mjs";
import { verifyComponent } from "../packages/koed-server/dist/component-verification.js";
import { productionComponentTrustRoots } from "../packages/koed-server/dist/component-trust-roots.js";
import { createSyntheticManifestCatalog } from "./component-signing-rehearsal-fixture.mjs";
const url = process.env.KOED_COMPONENT_SIGNER_URL;
const keyId = process.env.KOED_COMPONENT_SIGNER_KEY_ID;
if (
  !url ||
  !url.startsWith("https://") ||
  !productionComponentTrustRoots.has(keyId)
)
  throw new Error("Approved signer and embedded public root required");
const tokenUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
tokenUrl.searchParams.set("audience", "koed-component-signer");
const tokenResponse = await fetch(tokenUrl, {
  headers: {
    authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
  },
  signal: AbortSignal.timeout(15000)
});
if (!tokenResponse.ok)
  throw new Error(`GitHub OIDC failed (${tokenResponse.status})`);
const { value: token } = await tokenResponse.json();
if (typeof token !== "string" || !token) throw new Error("Missing OIDC token");
const root = mkdtempSync(resolve(tmpdir(), "koed-signing-rehearsal-"));
try {
  const report = [];
  for (const component of ["base", "privacy"]) {
    const payload = resolve(root, component);
    mkdirSync(payload);
    for (let n = 0; n < 1000; n++)
      writeFileSync(
        resolve(payload, `fixture-${n}.txt`),
        `synthetic signing fixture ${n}\n`
      );
    const archivePath = resolve(
      root,
      `koed-${component}-0.8.1-linux-x64.tar.gz`
    );
    writeDeterministicTarGz({ sourceDir: payload, tarPath: archivePath });
    const runtime = {
      kind: "node",
      version: process.versions.node,
      nodeVersion: process.versions.node,
      modulesAbi: process.versions.modules,
      napiVersion: Number(process.versions.napi),
      platform: "linux",
      architecture: "x64",
      libcVersion: process.report.getReport().header.glibcVersionRuntime
    };
    const manifest = buildComponentManifest({
      componentRoot: payload,
      archivePath,
      component,
      productVersion: "0.8.1",
      target: { platform: "linux", architecture: "x64" },
      runtimes: [
        {
          kind: "node",
          runtimeRange: ">=24 <25",
          nodeRange: ">=24 <25",
          modulesAbi: runtime.modulesAbi,
          minimumNapi: 10
        }
      ],
      requiredFiles: ["fixture-0.txt"]
    });
    const manifestBytes = canonicalComponentManifestBytes(manifest);
    if (manifestBytes.length <= 65536)
      throw new Error("Rehearsal must exceed KMS raw-message limit");
    const request = async (path, body) => {
      const response = await fetch(url.replace(/\/$/, "") + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok)
        throw new Error(`Signer ${path} failed (${response.status})`);
      return response.json();
    };
    const manifestCatalog = createSyntheticManifestCatalog(manifestBytes);
    const { signature } = await request("/v1/sign", { keyId, manifest });
    // Local payload integrity uses fixture-only pins, not the KMS signature.
    await verifyComponent({
      manifestBytes,
      manifestCatalog,
      archivePath,
      expectedComponent: component,
      expectedVersion: "0.8.1",
      target: manifest.target,
      runtime
    });
    const verified = await request("/v1/verify", {
      keyId,
      manifest,
      signature
    });
    if (verified.verified !== true)
      throw new Error("Remote signature verification failed");
    const tampered = await request("/v1/verify", {
      keyId,
      manifest: { ...manifest, productVersion: "0.8.2" },
      signature
    });
    if (tampered.verified !== false)
      throw new Error("Tampered manifest was accepted");
    report.push({
      component,
      manifestBytes: manifestBytes.length,
      keyId,
      signatureSchema: signature.schemaVersion,
      syntheticPayloadVerified: true,
      remoteSignatureVerified: true,
      remoteManifestTamperingRejected: true
    });
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        evidence: "synthetic-fixture-only",
        publication: false,
        nativeAcceptance: false,
        publisherTrust: false,
        report
      },
      null,
      2
    )
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
