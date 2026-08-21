import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { KoedServerPaths } from "./paths.js";
import {
  PINNED_PRIVACY_MODEL_FILES,
  PINNED_PRIVACY_MODEL_ID,
  PINNED_PRIVACY_MODEL_REVISION
} from "@koed/shared";

// Immutable release metadata published by apps/privacy-service/src/provenance.ts.
export const PRIVACY_MODEL_ID = PINNED_PRIVACY_MODEL_ID;
export const PRIVACY_MODEL_REVISION = PINNED_PRIVACY_MODEL_REVISION;

interface PrivacyModelFile {
  path: string;
  sha256: string;
  size?: number;
}

export const PRIVACY_MODEL_FILES: readonly PrivacyModelFile[] =
  PINNED_PRIVACY_MODEL_FILES;

export interface PrivacyModelPaths {
  blobsDir: string;
  cacheDir: string;
}

export interface PrivacyModelStatus {
  ok: boolean;
  state: "installed" | "missing" | "checksum_mismatch" | "not_configured";
  message: string;
  action?: string;
  modelPath: string;
  files: Array<{ path: string; sha256: string; sizeBytes?: number }>;
}

export const resolvePrivacyModelPaths = (
  paths: KoedServerPaths
): PrivacyModelPaths => ({
  blobsDir: resolve(paths.modelsDir, "privacy", "blobs", "sha256"),
  cacheDir: resolve(paths.modelsDir, "privacy", "transformers-cache")
});

const cachePath = (paths: PrivacyModelPaths, file: PrivacyModelFile): string =>
  resolve(paths.cacheDir, PRIVACY_MODEL_ID, PRIVACY_MODEL_REVISION, file.path);

const blobPath = (paths: PrivacyModelPaths, file: PrivacyModelFile): string =>
  resolve(paths.blobsDir, file.sha256);

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

const materializeCacheEntry = (
  paths: PrivacyModelPaths,
  file: PrivacyModelFile
): void => {
  const target = cachePath(paths, file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  rmSync(target, { force: true });
  linkSync(blobPath(paths, file), target);
};

export const collectPrivacyModelStatus = async (
  serverPaths: KoedServerPaths
): Promise<PrivacyModelStatus> => {
  const paths = resolvePrivacyModelPaths(serverPaths);
  const files: PrivacyModelStatus["files"] = [];
  for (const file of PRIVACY_MODEL_FILES) {
    const blob = blobPath(paths, file);
    if (!existsSync(blob)) {
      return {
        ok: false,
        state: "missing",
        message: `Pinned Privacy Filter model asset is missing: ${file.path}.`,
        action: "Run koed-server models install --kind privacy.",
        modelPath: paths.cacheDir,
        files
      };
    }
    const sizeBytes = statSync(blob).size;
    const actual = await sha256File(blob);
    files.push({ path: file.path, sha256: actual, sizeBytes });
    if (
      actual !== file.sha256 ||
      (file.size !== undefined && sizeBytes !== file.size)
    ) {
      return {
        ok: false,
        state: "checksum_mismatch",
        message: `Pinned Privacy Filter model asset failed verification: ${file.path}.`,
        action:
          "Run koed-server models install --kind privacy to replace the invalid content-addressed asset.",
        modelPath: paths.cacheDir,
        files
      };
    }
    materializeCacheEntry(paths, file);
  }
  return {
    ok: true,
    state: "installed",
    message: "Pinned Privacy Filter model assets are installed and verified.",
    modelPath: paths.cacheDir,
    files
  };
};

export const installPrivacyModel = async (
  serverPaths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<PrivacyModelStatus> => {
  if (environment.KOED_DEPENDENCY_MODE?.trim() === "external") {
    return {
      ok: false,
      state: "not_configured",
      message:
        "Privacy Filter model downloads are disabled in external dependency mode.",
      action:
        "Run the Operator-managed Privacy Filter Service with its pinned model assets.",
      modelPath: resolvePrivacyModelPaths(serverPaths).cacheDir,
      files: []
    };
  }
  const paths = resolvePrivacyModelPaths(serverPaths);
  mkdirSync(paths.blobsDir, { recursive: true, mode: 0o700 });
  for (const file of PRIVACY_MODEL_FILES) {
    const blob = blobPath(paths, file);
    if (existsSync(blob) && (await sha256File(blob)) === file.sha256) {
      materializeCacheEntry(paths, file);
      continue;
    }
    const url = `https://huggingface.co/${PRIVACY_MODEL_ID}/resolve/${PRIVACY_MODEL_REVISION}/${file.path}`;
    const response = await fetcher(url);
    if (!response.ok || !response.body) {
      return {
        ok: false,
        state: "missing",
        message: `Could not download pinned Privacy Filter model asset ${file.path} (HTTP ${response.status}).`,
        action: "Check network access to huggingface.co and retry.",
        modelPath: paths.cacheDir,
        files: []
      };
    }
    const temporary = `${blob}.${process.pid}.download`;
    rmSync(temporary, { force: true });
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporary, { mode: 0o600 })
    );
    const sizeBytes = statSync(temporary).size;
    const actual = await sha256File(temporary);
    if (
      actual !== file.sha256 ||
      (file.size !== undefined && sizeBytes !== file.size)
    ) {
      rmSync(temporary, { force: true });
      return {
        ok: false,
        state: "checksum_mismatch",
        message: `Downloaded Privacy Filter model asset failed verification: ${file.path}.`,
        action:
          "Do not use the asset; verify the pinned upstream revision and retry.",
        modelPath: paths.cacheDir,
        files: [{ path: file.path, sha256: actual, sizeBytes }]
      };
    }
    rmSync(blob, { force: true });
    renameSync(temporary, blob);
    materializeCacheEntry(paths, file);
  }
  return collectPrivacyModelStatus(serverPaths);
};
