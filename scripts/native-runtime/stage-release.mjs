import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildLinuxCore } from "./build-core-linux-x64.mjs";
import { buildCudaAddon } from "./build-cuda-addon-linux-x64.mjs";
import { coreManifestName } from "./core-artifact.mjs";
import {
  assertCudaCoreCompatibility,
  cudaManifestPath
} from "./cuda-artifact.mjs";
import { sha256File } from "./manifest-lib.mjs";

const [version, cache, output] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !cache || !output)
  throw new Error(
    "Usage: stage-release.mjs <product version> <native package cache> <release directory>"
  );

const manifests = { core: coreManifestName, cuda: cudaManifestPath };
if (!existsSync(cache)) {
  const work = mkdtempSync(join(tmpdir(), "koed-native-build-"));
  try {
    const coreDir = join(work, "core");
    const core = buildLinuxCore({ outDir: coreDir, runtimeVersion: version });
    const cuda = buildCudaAddon({
      coreDir: join(coreDir, "koed-runtime"),
      outDir: join(work, "cuda"),
      runtimeVersion: version
    });
    mkdirSync(cache, { recursive: true });
    for (const report of [core, cuda]) {
      const dir = join(work, report.kind);
      const manifest = manifests[report.kind];
      copyFileSync(join(dir, report.archive), join(cache, report.archive));
      copyFileSync(
        join(dir, "koed-runtime", manifest),
        join(cache, basename(manifest))
      );
      copyFileSync(
        join(dir, report.kind + "-candidate.json"),
        join(cache, report.kind + "-candidate.json")
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

mkdirSync(output, { recursive: true });
function stage(kind) {
  const report = JSON.parse(
    readFileSync(join(cache, kind + "-candidate.json"), "utf8")
  );
  const { archive, schemaVersion, kind: reportedKind, ...pin } = report;
  if (
    schemaVersion !== 1 ||
    reportedKind !== kind ||
    !/^[a-f0-9]{64}$/.test(pin.recipeId) ||
    archive !== `koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz`
  )
    throw new Error(`Invalid ${kind} package identity.`);
  const manifest = basename(manifests[kind]);
  for (const [name, digest] of [
    [archive, pin.sha256],
    [manifest, pin.manifestSha256]
  ]) {
    const path = join(cache, name);
    if (
      sha256File(path) !== digest ||
      (name === archive && statSync(path).size !== pin.archiveBytes)
    )
      throw new Error(`Native release file differs from its build: ${name}`);
    copyFileSync(path, join(output, name));
  }
  writeFileSync(
    join(output, archive + ".sha256"),
    pin.sha256 + "  " + archive + "\n"
  );
  return {
    ...pin,
    url: `https://github.com/koed-labs/koed/releases/download/v${version}/${archive}`
  };
}
const core = stage("core"),
  cuda = stage("cuda");
assertCudaCoreCompatibility(
  { kind: "core", ...core },
  { kind: "cuda", ...cuda }
);
const catalog = {
  schemaVersion: 1,
  minimumCoreVersion: core.runtimeVersion,
  core,
  cuda
};
writeFileSync(
  join(output, "native-runtime-catalog.json"),
  JSON.stringify(catalog, null, 2) + "\n"
);
