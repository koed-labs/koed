import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
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

export interface PrivacyModelInstallOptions {
  signal?: AbortSignal;
  progress?: (event: {
    phase: string;
    transferredBytes: number;
    totalBytes?: number;
    file?: string;
  }) => void;
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

const isSameFile = (left: string, right: string): boolean => {
  try {
    const leftStat = statSync(left);
    const rightStat = lstatSync(right);
    return (
      rightStat.isFile() &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const materializePrivacyModelCacheEntry = (
  blob: string,
  target: string
): void => {
  if (isSameFile(blob, target)) return;
  rmSync(target, { force: true });
  try {
    linkSync(blob, target);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      isSameFile(blob, target)
    ) {
      return;
    }
    throw error;
  }
};

const sha256File = async (
  path: string,
  signal?: AbortSignal
): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash, signal ? { signal } : {});
  return hash.digest("hex");
};

const materializeCacheEntry = (
  paths: PrivacyModelPaths,
  file: PrivacyModelFile
): void => {
  const target = cachePath(paths, file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  materializePrivacyModelCacheEntry(blobPath(paths, file), target);
};

const retryableTransferError = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"
  ].includes(code ?? "");
};

const downloadPrivacyAsset = async (
  file: PrivacyModelFile,
  temporary: string,
  fetcher: typeof fetch,
  options: PrivacyModelInstallOptions
): Promise<number | undefined> => {
  const url = `https://huggingface.co/${PRIVACY_MODEL_ID}/resolve/${PRIVACY_MODEL_REVISION}/${file.path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    options.signal?.throwIfAborted();
    rmSync(temporary, { force: true });
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const activity = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => idle.abort(new Error("Privacy model transfer stalled.")),
        30000
      );
    };
    activity();
    const signal = options.signal
      ? AbortSignal.any([options.signal, idle.signal])
      : idle.signal;
    try {
      const response = await fetcher(url, { signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const requestedDelay =
          retryAfter === null
            ? NaN
            : Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(retryAfter) - Date.now();
        const retryDelay = Number.isFinite(requestedDelay)
          ? Math.max(0, requestedDelay)
          : 250 * attempt;
        if (
          attempt < 3 &&
          retryDelay <= 30_000 &&
          (response.status === 408 ||
            response.status === 429 ||
            response.status >= 500)
        ) {
          clearTimeout(idleTimer);
          await delay(
            retryDelay,
            undefined,
            options.signal ? { signal: options.signal } : {}
          );
          continue;
        }
        return response.status;
      }
      let transferredBytes = 0;
      let lastProgressAt = 0;
      const headerSize = Number(response.headers.get("content-length"));
      const totalBytes =
        file.size ??
        (Number.isSafeInteger(headerSize) && headerSize > 0
          ? headerSize
          : undefined);
      options.progress?.({
        phase: "model-download",
        transferredBytes,
        ...(totalBytes === undefined ? {} : { totalBytes }),
        file: file.path
      });
      const monitor = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          activity();
          transferredBytes += chunk.length;
          if (Date.now() - lastProgressAt >= 100) {
            options.progress?.({
              phase: "model-download",
              transferredBytes,
              ...(totalBytes === undefined ? {} : { totalBytes }),
              file: file.path
            });
            lastProgressAt = Date.now();
          }
          callback(null, chunk);
        }
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        monitor,
        createWriteStream(temporary, { mode: 0o600 }),
        { signal }
      );
      options.progress?.({
        phase: "model-download",
        transferredBytes,
        ...(totalBytes === undefined ? {} : { totalBytes }),
        file: file.path
      });
      return undefined;
    } catch (error) {
      rmSync(temporary, { force: true });
      options.signal?.throwIfAborted();
      if (!idle.signal.aborted && !retryableTransferError(error)) throw error;
      if (attempt === 3) {
        throw new Error(
          `Could not download pinned Privacy Filter model asset ${file.path}: transfer failed after ${attempt} attempts.`,
          { cause: error }
        );
      }
      clearTimeout(idleTimer);
      await delay(
        250 * attempt,
        undefined,
        options.signal ? { signal: options.signal } : {}
      );
    } finally {
      clearTimeout(idleTimer);
    }
  }
  throw new Error("Privacy Filter model transfer did not complete.");
};

export const collectPrivacyModelStatus = async (
  serverPaths: KoedServerPaths,
  signal?: AbortSignal
): Promise<PrivacyModelStatus> => {
  const paths = resolvePrivacyModelPaths(serverPaths);
  const files: PrivacyModelStatus["files"] = [];
  for (const file of PRIVACY_MODEL_FILES) {
    signal?.throwIfAborted();
    const blob = blobPath(paths, file);
    if (!existsSync(blob)) {
      return {
        ok: false,
        state: "missing",
        message: `Pinned Privacy Filter model asset is missing: ${file.path}.`,
        action: "Run koed models install --kind privacy.",
        modelPath: paths.cacheDir,
        files
      };
    }
    const sizeBytes = statSync(blob).size;
    const actual = await sha256File(blob, signal);
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
          "Run koed models install --kind privacy to replace the invalid content-addressed asset.",
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
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  options: PrivacyModelInstallOptions = {}
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
    options.signal?.throwIfAborted();
    const blob = blobPath(paths, file);
    if (
      existsSync(blob) &&
      (await sha256File(blob, options.signal)) === file.sha256
    ) {
      materializeCacheEntry(paths, file);
      continue;
    }
    const temporary = `${blob}.${process.pid}.${randomUUID()}.download`;
    try {
      const failedStatus = await downloadPrivacyAsset(
        file,
        temporary,
        fetcher,
        options
      );
      if (failedStatus !== undefined) {
        return {
          ok: false,
          state: "missing",
          message: `Could not download pinned Privacy Filter model asset ${file.path} (HTTP ${failedStatus}).`,
          action: "Check network access to huggingface.co and retry.",
          modelPath: paths.cacheDir,
          files: []
        };
      }
      const sizeBytes = statSync(temporary).size;
      options.progress?.({
        phase: "model-verify",
        transferredBytes: sizeBytes,
        totalBytes: sizeBytes,
        file: file.path
      });
      const actual = await sha256File(temporary, options.signal);
      if (
        actual !== file.sha256 ||
        (file.size !== undefined && sizeBytes !== file.size)
      ) {
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
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return collectPrivacyModelStatus(serverPaths, options.signal);
};
