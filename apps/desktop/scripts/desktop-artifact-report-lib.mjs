import { lstatSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { listPackage, statFile } from "@electron/asar";

const regularFileBytes = (path) => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce(
    (sum, entry) => sum + regularFileBytes(resolve(path, entry)),
    0
  );
};

export const classifyAsarEntries = (entries) => {
  const bytes = { main: 0, preload: 0, metadata: 0 };
  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/");
    const key =
      normalized === "/dist-electron/preload.cjs"
        ? "preload"
        : normalized.startsWith("/dist-electron/") ||
            normalized.startsWith("/node_modules/")
          ? "main"
          : "metadata";
    bytes[key] += entry.size;
  }
  return bytes;
};

const asarEntries = (path) =>
  listPackage(path).flatMap((entry) => {
    const stat = statFile(path, entry.replace(/^\//, ""));
    return typeof stat.size === "number"
      ? [{ path: entry, size: stat.size }]
      : [];
  });

export const buildDesktopArtifactReport = ({ appPath, dmgPath, zipPath }) => {
  const resources = resolve(appPath, "Contents/Resources");
  const asarPath = resolve(resources, "app.asar");
  const runtimeRoot = resolve(resources, "koed-runtime");
  const nativeRuntimeBytes = ["postgres", "llama.cpp"].reduce(
    (sum, entry) => sum + regularFileBytes(resolve(runtimeRoot, entry)),
    0
  );
  const runtimeBytes = regularFileBytes(runtimeRoot);
  const signatureBytes = regularFileBytes(
    resolve(appPath, "Contents/_CodeSignature")
  );
  const rendererBytes = regularFileBytes(resolve(resources, "app-dist"));
  const appBytes = regularFileBytes(appPath);
  const asarBytes = lstatSync(asarPath).size;
  const asar = classifyAsarEntries(asarEntries(asarPath));
  const attributedBytes =
    asarBytes + runtimeBytes + rendererBytes + signatureBytes;
  return {
    schemaVersion: 1,
    app: appPath,
    distributions: {
      dmgBytes: dmgPath ? lstatSync(dmgPath).size : null,
      zipBytes: zipPath ? lstatSync(zipPath).size : null
    },
    components: {
      electronFrameworkAndShellBytes: Math.max(0, appBytes - attributedBytes),
      appAsarBytes: asarBytes,
      mainLogicalBytes: asar.main,
      preloadLogicalBytes: asar.preload,
      asarMetadataLogicalBytes: asar.metadata,
      rendererBytes,
      appRuntimeBytes: runtimeBytes - nativeRuntimeBytes,
      nativeRuntimeBytes,
      signatureBytes
    },
    totalAppBytes: appBytes
  };
};

export const evaluateDesktopArtifactPolicy = (report, policy, baseline) => {
  const errors = [];
  for (const [key, baselineName] of [
    ["dmgBytes", "Koed-0.6.2-arm64.dmg"],
    ["zipBytes", "Koed-0.6.2-arm64.zip"]
  ]) {
    const bytes = report.distributions[key];
    const baselineBytes = baseline.artifacts?.[baselineName];
    if (
      typeof bytes === "number" &&
      typeof baselineBytes === "number" &&
      bytes > baselineBytes * (1 - policy.desktopReductionMinimum)
    ) {
      errors.push(
        `${key} ${bytes} does not meet the v0.6.2 reduction gate ${Math.floor(baselineBytes * (1 - policy.desktopReductionMinimum))}`
      );
    }
  }
  return { ok: errors.length === 0, errors };
};
