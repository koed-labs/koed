import { createHash, createHmac } from "node:crypto";
import path from "node:path";

export interface NormalizedGitRemote {
  name: string;
  host: string | null;
  namespace: string | null;
  repo: string | null;
  display: string | null;
  fingerprint: string;
}

export interface ProjectPackageMetadata {
  manager: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  name: string | null;
  relativePath: string;
}

export interface ProjectMetadataV1 {
  schemaVersion: 1;
  discoveredAt: string;
  lastSeenAt: string;
  localProjectId: string;
  displayName: string;
  path: {
    cwd: string;
    projectRoot: string | null;
    basename: string;
    localPathHash: string;
  };
  git?: {
    rootHash: string;
    commonDirHash: string | null;
    remotes: NormalizedGitRemote[];
    remoteAliases: NormalizedGitRemote[];
    branch: string | null;
    headCommit: string | null;
    isWorktree: boolean;
    worktreeHash: string | null;
  };
  packages: ProjectPackageMetadata[];
  aiClient?: {
    cwdHash: string;
    cwdBasename: string;
    source: "codex";
  };
}

export const normalizeProjectDisplayName = (input: {
  projectRoot?: string | null;
  cwd: string;
  packages?: ProjectPackageMetadata[];
  remotes?: NormalizedGitRemote[];
}): string => {
  const packageName = input.packages?.find((entry) => entry.name)?.name;
  if (packageName) return packageName;
  const remoteRepo = input.remotes?.find((entry) => entry.repo)?.repo;
  if (remoteRepo) return remoteRepo;
  return path.basename(input.projectRoot ?? input.cwd) || "Project";
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const hmacProjectValue = (salt: string, value: string): string =>
  `hmac_sha256:${createHmac("sha256", salt).update(value).digest("hex")}`;

const stripGitSuffix = (value: string): string => value.replace(/\.git$/i, "");

const normalizedRemoteFingerprint = (parts: {
  host: string | null;
  namespace: string | null;
  repo: string | null;
  fallback: string;
}): string => {
  const canonical =
    parts.host && parts.namespace && parts.repo
      ? `${parts.host}/${parts.namespace}/${parts.repo}`
      : parts.fallback;
  return `gr_${sha256(canonical).slice(0, 32)}`;
};

const remoteFromPathParts = (
  name: string,
  host: string | null,
  pathName: string,
  fallback: string
): NormalizedGitRemote => {
  const segments = pathName.replace(/^\/+/, "").split("/").filter(Boolean);
  const namespace =
    segments.length >= 2 ? segments.slice(0, -1).join("/") : null;
  const repo =
    segments.length >= 1 ? stripGitSuffix(segments.at(-1) ?? "") : null;
  const normalizedHost = host?.toLowerCase() ?? null;
  const display =
    normalizedHost && namespace && repo
      ? `${normalizedHost}/${namespace}/${repo}`
      : null;
  return {
    name,
    host: normalizedHost,
    namespace,
    repo,
    display,
    fingerprint: normalizedRemoteFingerprint({
      host: normalizedHost,
      namespace,
      repo,
      fallback
    })
  };
};

const opaqueRemote = (name: string, value: string): NormalizedGitRemote => ({
  name,
  host: null,
  namespace: null,
  repo: null,
  display: null,
  fingerprint: `gr_${sha256(value).slice(0, 32)}`
});

export const normalizeGitRemoteUrl = (
  value: string,
  name = "origin"
): NormalizedGitRemote => {
  const trimmed = value.trim();
  const scpLike = trimmed.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (scpLike) {
    return remoteFromPathParts(
      name,
      scpLike[2] ?? null,
      scpLike[3] ?? "",
      trimmed
    );
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    if (parsed.protocol === "file:") {
      return opaqueRemote(name, parsed.toString());
    }
    return remoteFromPathParts(
      name,
      parsed.host,
      parsed.pathname,
      parsed.toString()
    );
  } catch {
    const sanitized = trimmed.replace(/\b[^\s:@/]+:[^\s@/]+@/g, "[redacted]@");
    return opaqueRemote(name, sanitized);
  }
};

export const isPortableGitRemote = (remote: NormalizedGitRemote): boolean =>
  Boolean(remote.host && remote.namespace && remote.repo);

export const mergeGitRemoteAliases = (
  ...remoteSets: NormalizedGitRemote[][]
): NormalizedGitRemote[] => {
  const byFingerprint = new Map<string, NormalizedGitRemote>();
  for (const remote of remoteSets.flat()) {
    if (isPortableGitRemote(remote)) {
      byFingerprint.set(remote.fingerprint, remote);
    }
  }
  return [...byFingerprint.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint)
  );
};

export const deriveLocalProjectId = (input: {
  salt: string;
  projectRoot?: string | null;
  cwd: string;
}): string => {
  const key = path.resolve(input.projectRoot ?? input.cwd);
  return `lp_${createHmac("sha256", input.salt).update(key).digest("hex").slice(0, 32)}`;
};

export const safeProjectMetadataForRemote = (
  metadata: ProjectMetadataV1
): Record<string, unknown> => ({
  schemaVersion: metadata.schemaVersion,
  localProjectId: metadata.localProjectId,
  displayName: metadata.displayName,
  path: {
    basename: metadata.path.basename,
    localPathHash: metadata.path.localPathHash
  },
  git: metadata.git
    ? {
        remotes: metadata.git.remotes.filter(isPortableGitRemote),
        branch: metadata.git.branch,
        headCommit: metadata.git.headCommit,
        isWorktree: metadata.git.isWorktree,
        rootHash: metadata.git.rootHash,
        worktreeHash: metadata.git.worktreeHash
      }
    : undefined,
  packages: metadata.packages
});
