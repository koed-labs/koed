#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";
import { resolveKoedServerPaths } from "../packages/koed-server/dist/paths.js";
import { discoverActualRuntimeIdentity } from "../packages/koed-server/dist/component-runtime-identity.js";
import { readStoredComponents } from "../packages/koed-server/dist/component-store.js";
import { collectPrivacyModelStatus } from "../packages/koed-server/dist/privacy-model-runtime.js";
import { probePrivacyDownloadCompatibility } from "../packages/koed-server/dist/privacy-download-compatibility.js";
import { verifyPrivacyComponentInference } from "../packages/koed-server/dist/privacy-inference.js";
import { PINNED_PRIVACY_MODEL_REVISION } from "../packages/shared/dist/privacy-classifier-generation.js";

const repo = resolve(import.meta.dirname, "..");
const stages = new Map([
  ["macos", { platform: "macos", architecture: "arm64", cases: ["macos"] }],
  [
    "linux-cpu",
    { platform: "linux", architecture: "x64", cases: ["cpu", "cuda-fallback"] }
  ],
  [
    "linux-cuda",
    { platform: "linux", architecture: "x64", cases: ["cuda", "cuda-fallback"] }
  ]
]);
const external = (path) => {
  const location = relative(realpathSync(repo), realpathSync(path));
  assert.ok(
    isAbsolute(location) ||
      location === ".." ||
      location.startsWith(`..${sep}`),
    "Qualification artifacts and profiles must be outside the checkout"
  );
};
const command = (args, environment, log) => {
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 900000
  });
  writeFileSync(`${log}.stdout`, result.stdout ?? "");
  writeFileSync(`${log}.stderr`, result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${args[0]} failed: ${result.stderr}\n${result.stdout}`
  );
  return result.stdout;
};

export async function qualifyPrivacyReleaseComponents({
  assetsDir,
  catalogPath,
  version,
  stage,
  workDir,
  outputPath,
  sourceRevision,
  nativeHost
}) {
  const target = stages.get(stage);
  assert.ok(target, "Unknown qualification stage");
  assert.equal(
    nativeHost,
    true,
    "Explicit native-host confirmation is required"
  );
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  const runtime = discoverActualRuntimeIdentity();
  assert.equal(runtime.kind, "node");
  assert.equal(runtime.platform, target.platform);
  assert.equal(runtime.architecture, target.architecture);
  assert.equal(Number(runtime.version.split(".")[0]), 24);
  assert.equal(
    existsSync(workDir),
    false,
    "Use a fresh qualification work directory"
  );
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  external(workDir);
  await verifyFrozenComponentAssets({ assetsDir, catalogPath, version });
  const catalog = JSON.parse(readFileSync(catalogPath));
  const { productionComponentManifestCatalog } =
    await import("../packages/koed-server/dist/component-manifest-catalog-data.js");
  assert.deepEqual(
    productionComponentManifestCatalog,
    catalog,
    "Harness catalog differs from frozen catalog"
  );
  const environment = {
    ...process.env,
    KOED_TEAM_COLLABORATION_ENABLED: "true",
    KOED_COMPONENT_MANIFEST_CATALOG: catalogPath,
    PRIVACY_RUNTIME_ENGINE: "transformers"
  };
  delete environment.NODE_PATH;
  delete environment.KOED_ALLOW_PACKAGED_SOURCE_FALLBACK;
  const compatibility = await probePrivacyDownloadCompatibility({
    preference: "auto",
    environment
  });
  if (stage === "linux-cpu") assert.equal(compatibility.variant, "cpu");
  if (stage === "linux-cuda")
    assert.equal(compatibility.variant, "cuda", compatibility.reason);
  const control = resolve(workDir, "control-plane");
  command(
    [
      resolve(repo, "scripts/build-public-server-package.mjs"),
      "--out-dir",
      control
    ],
    environment,
    resolve(workDir, "control-plane-build")
  );
  const cli = resolve(control, "package/bin/koed.js");
  const report = {
    schemaVersion: 1,
    stage,
    version,
    sourceRevision,
    modelRevision: PINNED_PRIVACY_MODEL_REVISION,
    catalogSha256: createHash("sha256")
      .update(readFileSync(catalogPath))
      .digest("hex"),
    environment: {
      runtime,
      nativeHost,
      runnerName: process.env.RUNNER_NAME ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null
    },
    compatibility,
    cases: []
  };
  let cudaHome;
  for (const name of target.cases) {
    const variant =
      name === "macos" ? undefined : name === "cpu" ? "cpu" : "cuda";
    const home =
      name === "cuda-fallback" && cudaHome
        ? cudaHome
        : resolve(workDir, `${name}-home`);
    const env = {
      ...environment,
      KOED_HOME: home,
      ...(name === "cuda-fallback" ? { CUDA_VISIBLE_DEVICES: "-1" } : {})
    };
    if (!existsSync(home)) {
      mkdirSync(home, { mode: 0o700 });
      const suffix = `${version}-${target.platform}-${target.architecture}`;
      for (const component of ["base", "privacy"]) {
        const archive = resolve(
          assetsDir,
          `koed-${component}-${suffix}${component === "privacy" && variant ? `-${variant}` : ""}.tar.gz`
        );
        command(
          [
            cli,
            "components",
            "install",
            "--component",
            component,
            ...(component === "privacy" && variant
              ? ["--variant", variant]
              : []),
            "--archive",
            archive,
            "--manifest",
            `${archive}.manifest.json`,
            "--json"
          ],
          env,
          resolve(workDir, `${name}-${component}-install`)
        );
      }
      command(
        [cli, "models", "install", "--kind", "privacy", "--json"],
        env,
        resolve(workDir, `${name}-model-install`)
      );
    }
    if (name === "cuda") cudaHome = home;
    const paths = resolveKoedServerPaths(env);
    const component = (await readStoredComponents(paths, runtime)).find(
      (item) =>
        item.manifest.component === "privacy" &&
        item.manifest.productVersion === version &&
        item.manifest.variant === variant
    );
    assert.ok(component, "No authenticated installed Privacy component");
    external(component.root);
    const model = await collectPrivacyModelStatus(paths);
    assert.equal(model.ok, true, model.message);
    const verification = await verifyPrivacyComponentInference({
      paths,
      componentRoot: component.root,
      modelPath: model.modelPath,
      provider: variant === "cuda" ? "cuda" : "cpu",
      environment: env
    });
    assert.equal(verification.activeProvider, name === "cuda" ? "cuda" : "cpu");
    assert.equal(verification.proof, "onnx-execution-profile");
    if (name === "cuda-fallback")
      assert.equal(
        verification.fallbackReason,
        "cuda_initialization_or_inference_failed"
      );
    const provider = name === "macos" ? "coreml" : verification.activeProvider;
    const service = JSON.parse(
      command(
        [
          resolve(repo, "scripts/validate-packaged-privacy-runtime.mjs"),
          "--runtime-root",
          component.root,
          "--transformers-cache",
          model.modelPath,
          "--provider",
          provider
        ],
        env,
        resolve(workDir, `${name}-service`)
      )
    );
    report.cases.push({
      name,
      manifestDigest: component.manifestDigest,
      archiveSha256: component.manifest.archive.sha256,
      verification,
      service
    });
  }
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const values = new Map();
  let nativeHost = false;
  const allowed = new Set([
    "--assets-dir",
    "--catalog",
    "--version",
    "--stage",
    "--work-dir",
    "--out",
    "--source-revision"
  ]);
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--native-host") {
      nativeHost = true;
      continue;
    }
    assert.ok(
      allowed.has(flag) && process.argv[i + 1] && !values.has(flag),
      `Invalid argument: ${flag}`
    );
    values.set(flag, process.argv[++i]);
  }
  for (const flag of allowed) assert.ok(values.has(flag), `Missing ${flag}`);
  await qualifyPrivacyReleaseComponents({
    assetsDir: resolve(values.get("--assets-dir")),
    catalogPath: resolve(values.get("--catalog")),
    version: values.get("--version"),
    stage: values.get("--stage"),
    workDir: resolve(values.get("--work-dir")),
    outputPath: resolve(values.get("--out")),
    sourceRevision: values.get("--source-revision"),
    nativeHost
  });
}
