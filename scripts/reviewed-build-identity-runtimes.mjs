import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validatedElectronRuntime } from "./koed-component-runtime-policy.mjs";

// Protected checkout policy, never component manifests or downloaded packages.
// Node tuple matches the pinned release toolchain; libc is the admission baseline.
export const reviewedRuntimeIdentities = () => {
  const lock = parse(
    readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8")
  );
  const electronVersion =
    lock.importers?.["apps/desktop"]?.devDependencies?.electron?.version;
  if (electronVersion !== validatedElectronRuntime.version)
    throw new Error(
      "Reviewed Electron runtime identity does not match Desktop lock; review runtime policy before release."
    );
  const node = {
    kind: "node",
    version: "24.13.1",
    nodeVersion: "24.13.1",
    modulesAbi: "137",
    napiVersion: 10
  };
  return [
    { ...node, platform: "linux", architecture: "x64", libcVersion: "2.35" },
    { ...node, platform: "macos", architecture: "arm64" },
    {
      kind: "electron",
      ...validatedElectronRuntime,
      platform: "macos",
      architecture: "arm64"
    }
  ];
};

export const validateReviewedRuntimeIdentities = (identities) => {
  const expected = reviewedRuntimeIdentities();
  if (!Array.isArray(identities) || identities.length !== expected.length)
    throw new Error("Incomplete protected runtime identity matrix.");
  for (const runtime of expected) {
    const matches = identities.filter(
      (row) =>
        row?.kind === runtime.kind &&
        row.platform === runtime.platform &&
        row.architecture === runtime.architecture
    );
    if (
      matches.length !== 1 ||
      Object.keys(matches[0]).length !== Object.keys(runtime).length ||
      Object.entries(runtime).some(([key, value]) => matches[0][key] !== value)
    )
      throw new Error(
        "Protected runtime identity matrix differs from reviewed build policy."
      );
  }
  return structuredClone(identities);
};
