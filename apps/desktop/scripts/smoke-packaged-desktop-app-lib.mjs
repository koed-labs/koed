import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const PACKAGED_NATIVE_ASSET_DIRECTORIES = ["postgres", "llama.cpp"];

export const smokeExecutionPlan = ({ missingAssets }) => ({
  collaborationBroker: !missingAssets,
  rendererFaults: !missingAssets,
  missingAssets: Boolean(missingAssets),
  healthyDaemon: !missingAssets
});

export const removeSmokeHome = (koedHome, remove = rmSync) =>
  remove(koedHome, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });

export const withPackagedNativeAssetsMasked = async ({ runtimeRoot, work }) => {
  const entries = PACKAGED_NATIVE_ASSET_DIRECTORIES.map((entry) => ({
    entry,
    source: resolve(runtimeRoot, entry)
  })).filter(({ source }) => existsSync(source));
  if (entries.length === 0) {
    return work({ maskedEntries: [] });
  }

  const stagingRoot = resolve(
    runtimeRoot,
    `.koed-smoke-masked-native-assets-${randomUUID()}`
  );
  mkdirSync(stagingRoot, { recursive: false });
  const moved = [];
  try {
    for (const item of entries) {
      const target = resolve(stagingRoot, item.entry);
      renameSync(item.source, target);
      moved.push({ ...item, target });
    }
  } catch (error) {
    for (const item of moved.toReversed()) {
      if (!existsSync(item.source) && existsSync(item.target)) {
        renameSync(item.target, item.source);
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  let result;
  let workError;
  const restoreErrors = [];
  try {
    result = await work({ maskedEntries: moved.map(({ entry }) => entry) });
  } catch (error) {
    workError = error;
  } finally {
    for (const item of moved.toReversed()) {
      if (existsSync(item.source)) {
        restoreErrors.push(
          new Error(
            `Cannot restore masked packaged native assets because ${item.source} already exists. Backup remains at ${item.target}.`
          )
        );
        continue;
      }
      try {
        renameSync(item.target, item.source);
      } catch (error) {
        restoreErrors.push(error);
      }
    }
    if (restoreErrors.length === 0) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  if (restoreErrors.length > 0) {
    throw new AggregateError(
      workError ? [workError, ...restoreErrors] : restoreErrors,
      `Failed to restore packaged native assets from ${stagingRoot}.`
    );
  }
  if (workError) throw workError;
  return result;
};
