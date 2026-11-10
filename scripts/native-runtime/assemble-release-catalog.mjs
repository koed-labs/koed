import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCompiledNativeCatalog,
  verifyDraftNativePins
} from "../native-runtime-pins.mjs";
import { sha256File } from "./manifest-lib.mjs";

const [version, macosDir, releaseDir] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !macosDir || !releaseDir)
  throw new Error(
    "Usage: assemble-release-catalog.mjs <version> <macOS core directory> <Linux release directory>"
  );
const linux = JSON.parse(process.env.LINUX_CATALOG ?? "null");
const report = JSON.parse(
  readFileSync(resolve(macosDir, "core-candidate.json"), "utf8")
);
const { schemaVersion, kind, archive, ...pin } = report;
if (
  schemaVersion !== 1 ||
  kind !== "core" ||
  !/^[a-f0-9]{64}$/.test(pin.recipeId ?? "") ||
  archive !== `koed-native-core-${pin.recipeId}-macos-arm64.tar.gz`
)
  throw new Error("Invalid macOS core package identity.");
const macos = {
  schemaVersion: 1,
  minimumCoreVersion: pin.runtimeVersion,
  core: {
    ...pin,
    url: `https://github.com/koed-labs/koed/releases/download/v${version}/${archive}`
  },
  cuda: null
};
const catalog = createCompiledNativeCatalog(linux, macos);
copyFileSync(resolve(macosDir, archive), resolve(releaseDir, archive));
copyFileSync(
  resolve(macosDir, "koed-runtime/native-core-manifest.json"),
  resolve(releaseDir, "native-core-manifest-macos-arm64.json")
);
writeFileSync(
  resolve(releaseDir, `${archive}.sha256`),
  `${pin.sha256}  ${archive}\n`
);
writeFileSync(
  resolve(releaseDir, "native-runtime-catalog.json"),
  `${JSON.stringify(catalog, null, 2)}\n`
);
const names = [
  `koed-native-core-${linux.core.recipeId}-linux-x64.tar.gz`,
  `koed-native-cuda-${linux.cuda.recipeId}-linux-x64.tar.gz`,
  "native-core-manifest.json",
  "native-cuda-manifest.json",
  archive,
  "native-core-manifest-macos-arm64.json"
];
const assets = names.map((name) => ({
  name,
  sha256: sha256File(resolve(releaseDir, name))
}));
verifyDraftNativePins(catalog, { root: releaseDir, version, assets });
