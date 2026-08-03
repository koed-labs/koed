import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export type LocalModelKind = "embedding" | "reranker";
export type LocalModelState =
  | "installed"
  | "missing"
  | "checksum_mismatch"
  | "not_configured";

export interface LocalModelManifest {
  kind: LocalModelKind;
  key: string;
  filename: string;
  modelPath: string;
  urlEnv: string;
  sha256Env: string;
  pathEnv: string;
  url?: string;
  sha256?: string;
  defaultUrl?: string;
  defaultSha256?: string;
}

export interface LocalModelStatus {
  state: LocalModelState;
  message: string;
  action?: string;
  modelPath: string;
  sizeBytes?: number;
  sha256?: string;
  manifest: LocalModelManifest;
}

export interface LocalModelInstallResult extends LocalModelStatus {
  ok: boolean;
}

export interface LocalModelInstallDependencies {
  fetch?: typeof fetch;
  onProgress?: (progress: LocalModelInstallProgress) => void;
}

export interface LocalModelInstallProgress {
  completedBytes: number | null;
  phase: "downloading" | "verifying" | "complete";
  totalBytes: number | null;
}

const MODEL_DEFINITIONS: Record<
  LocalModelKind,
  {
    key: string;
    filename: string;
    urlEnv: string;
    sha256Env: string;
    pathEnv: string;
    defaultUrl?: string;
    defaultSha256?: string;
  }
> = {
  embedding: {
    key: "qwen3-0.6b",
    filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    urlEnv: "KOED_EMBEDDING_MODEL_URL",
    sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
    pathEnv: "KOED_EMBEDDING_MODEL_PATH",
    defaultUrl:
      "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
    defaultSha256:
      "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
  },
  reranker: {
    key: "qwen3-reranker-0.6b",
    filename: "Qwen3-Reranker-0.6B-Q4_K_M.gguf",
    urlEnv: "KOED_RERANKER_MODEL_URL",
    sha256Env: "KOED_RERANKER_MODEL_SHA256",
    pathEnv: "KOED_RERANKER_MODEL_PATH"
  }
};

export const localModelKinds: LocalModelKind[] = ["embedding", "reranker"];

const trimEnv = (
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = environment[name]?.trim();
  return value ? value : undefined;
};

const dependencyMode = (
  environment: NodeJS.ProcessEnv
): "bundled-local" | "external" | undefined => {
  const value = trimEnv(environment, "KOED_DEPENDENCY_MODE");
  if (value === "bundled-local" || value === "external") {
    return value;
  }
  return undefined;
};

const modelDownloadBlockedAction = (manifest: LocalModelManifest): string =>
  `External dependency mode does not download model assets. Switch to bundled-local mode or set ${manifest.pathEnv} to an existing model file.`;

const normalizeSha256 = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(
      "Model SHA-256 must be 64 lowercase or uppercase hex characters."
    );
  }
  return normalized;
};

export const resolveLocalModelManifest = (
  paths: KoedServerPaths,
  kind: LocalModelKind = "embedding",
  environment: NodeJS.ProcessEnv = process.env
): LocalModelManifest => {
  const definition = MODEL_DEFINITIONS[kind];
  const explicitPath = trimEnv(environment, definition.pathEnv);
  return {
    kind,
    key: definition.key,
    filename: definition.filename,
    modelPath: explicitPath
      ? resolve(explicitPath)
      : resolve(paths.modelsDir, definition.filename),
    urlEnv: definition.urlEnv,
    sha256Env: definition.sha256Env,
    pathEnv: definition.pathEnv,
    url: trimEnv(environment, definition.urlEnv) ?? definition.defaultUrl,
    sha256: normalizeSha256(
      trimEnv(environment, definition.sha256Env) ?? definition.defaultSha256
    ),
    defaultUrl: definition.defaultUrl,
    defaultSha256: definition.defaultSha256
  };
};

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

export const collectLocalModelStatus = async (
  paths: KoedServerPaths,
  kind: LocalModelKind = "embedding",
  environment: NodeJS.ProcessEnv = process.env
): Promise<LocalModelStatus> => {
  const manifest = resolveLocalModelManifest(paths, kind, environment);
  const mode = dependencyMode(environment);
  if (!existsSync(manifest.modelPath)) {
    return {
      state: "missing",
      message: `${manifest.key} model is not installed at ${manifest.modelPath}.`,
      action:
        mode === "external"
          ? modelDownloadBlockedAction(manifest)
          : `Run koed-server models install --kind ${kind}. Override ${manifest.urlEnv} and ${manifest.sha256Env} only when using a custom model artifact.`,
      modelPath: manifest.modelPath,
      manifest
    };
  }

  const sizeBytes = statSync(manifest.modelPath).size;
  if (!manifest.sha256) {
    return {
      state: "not_configured",
      message: `${manifest.key} model exists, but ${manifest.sha256Env} is not configured for verification.`,
      action: `Set ${manifest.sha256Env} to verify installed model checksum.`,
      modelPath: manifest.modelPath,
      sizeBytes,
      manifest
    };
  }

  const actual = await sha256File(manifest.modelPath);
  if (actual !== manifest.sha256) {
    return {
      state: "checksum_mismatch",
      message: `${manifest.key} model checksum mismatch.`,
      action: `Remove ${manifest.modelPath}, verify ${manifest.sha256Env}, then run koed-server models install --kind ${kind}.`,
      modelPath: manifest.modelPath,
      sizeBytes,
      sha256: actual,
      manifest
    };
  }

  return {
    state: "installed",
    message: `${manifest.key} model is installed and checksum verified.`,
    modelPath: manifest.modelPath,
    sizeBytes,
    sha256: actual,
    manifest
  };
};

export const installLocalModel = async (
  paths: KoedServerPaths,
  kind: LocalModelKind = "embedding",
  environment: NodeJS.ProcessEnv = process.env,
  {
    fetch: fetcher = globalThis.fetch.bind(globalThis),
    onProgress
  }: LocalModelInstallDependencies = {}
): Promise<LocalModelInstallResult> => {
  const manifest = resolveLocalModelManifest(paths, kind, environment);
  const mode = dependencyMode(environment);
  if (mode === "external") {
    return {
      ok: false,
      state: "not_configured",
      message: `${manifest.key} model downloads are disabled in external dependency mode.`,
      action: modelDownloadBlockedAction(manifest),
      modelPath: manifest.modelPath,
      manifest
    };
  }
  if (!manifest.url) {
    return {
      ok: false,
      state: "not_configured",
      message: `${manifest.urlEnv} is required to install ${manifest.key}.`,
      action: `Set ${manifest.urlEnv} to HTTPS model artifact URL.`,
      modelPath: manifest.modelPath,
      manifest
    };
  }
  if (!manifest.sha256) {
    return {
      ok: false,
      state: "not_configured",
      message: `${manifest.sha256Env} is required before installing ${manifest.key}.`,
      action: `Set ${manifest.sha256Env} to expected SHA-256 checksum.`,
      modelPath: manifest.modelPath,
      manifest
    };
  }
  try {
    if (new URL(manifest.url).protocol !== "https:") {
      return {
        ok: false,
        state: "not_configured",
        message: `${manifest.urlEnv} must be an HTTPS URL.`,
        action: `Set ${manifest.urlEnv} to a trusted HTTPS model artifact URL.`,
        modelPath: manifest.modelPath,
        manifest
      };
    }
  } catch {
    return {
      ok: false,
      state: "not_configured",
      message: `${manifest.urlEnv} must be a valid HTTPS URL.`,
      action: `Set ${manifest.urlEnv} to a trusted HTTPS model artifact URL.`,
      modelPath: manifest.modelPath,
      manifest
    };
  }

  mkdirSync(dirname(manifest.modelPath), { recursive: true, mode: 0o700 });
  const tempPath = resolve(
    paths.cacheDir,
    `${basename(manifest.modelPath)}.${process.pid}.download`
  );
  mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
  rmSync(tempPath, { force: true });

  const response = await fetcher(manifest.url);
  if (!response.ok || !response.body) {
    return {
      ok: false,
      state: "missing",
      message: `Could not download ${manifest.key}: HTTP ${response.status}.`,
      action: `Check ${manifest.urlEnv}, network access, and artifact permissions.`,
      modelPath: manifest.modelPath,
      manifest
    };
  }

  const contentLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10
  );
  const totalBytes =
    Number.isSafeInteger(contentLength) && contentLength >= 0
      ? contentLength
      : null;
  let completedBytes = 0;
  let lastReportedBytes = 0;
  let lastReportedAt = 0;
  onProgress?.({
    completedBytes: 0,
    phase: "downloading",
    totalBytes
  });
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      completedBytes += chunk.byteLength;
      const now = Date.now();
      if (
        completedBytes === totalBytes ||
        completedBytes - lastReportedBytes >= 1_048_576 ||
        now - lastReportedAt >= 250
      ) {
        lastReportedBytes = completedBytes;
        lastReportedAt = now;
        onProgress?.({
          completedBytes,
          phase: "downloading",
          totalBytes
        });
      }
      callback(null, chunk);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    progress,
    createWriteStream(tempPath, { mode: 0o600 })
  );
  onProgress?.({
    completedBytes,
    phase: "verifying",
    totalBytes
  });
  const actual = await sha256File(tempPath);
  if (actual !== manifest.sha256) {
    rmSync(tempPath, { force: true });
    return {
      ok: false,
      state: "checksum_mismatch",
      message: `${manifest.key} downloaded checksum mismatch.`,
      action: `Verify ${manifest.sha256Env} and ${manifest.urlEnv}.`,
      modelPath: manifest.modelPath,
      sha256: actual,
      manifest
    };
  }

  renameSync(tempPath, manifest.modelPath);
  const status = await collectLocalModelStatus(paths, kind, environment);
  onProgress?.({
    completedBytes: status.sizeBytes ?? completedBytes,
    phase: "complete",
    totalBytes: status.sizeBytes ?? totalBytes
  });
  return { ok: status.state === "installed", ...status };
};
