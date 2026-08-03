import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const maximumManagedHomes = 4_096;
const maximumTranscriptFiles = 16_384;
const maximumSessionMetadataBytes = 1024 * 1024;

export type DiscoveredManagedConversationRuntime = {
  managedHome: string;
  transcriptPath: string;
  providerCliVersion: string | null;
  projectPath: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const containedPath = (root: string, candidate: string): boolean =>
  candidate.startsWith(`${root}${sep}`);

const readSessionMetadata = async (
  transcriptPath: string
): Promise<Record<string, unknown> | null> => {
  const descriptor = await open(transcriptPath, "r");
  try {
    const bytes = Buffer.alloc(maximumSessionMetadataBytes);
    const { bytesRead } = await descriptor.read(bytes, 0, bytes.byteLength, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return null;
    const parsed = JSON.parse(
      bytes.subarray(0, newline).toString("utf8")
    ) as unknown;
    const envelope = record(parsed);
    return envelope.type === "session_meta" ? record(envelope.payload) : null;
  } finally {
    await descriptor.close();
  }
};

const managedHomeIsValid = async (
  managedRoot: string,
  candidate: string
): Promise<boolean> => {
  const resolved = await realpath(candidate);
  if (!containedPath(managedRoot, resolved)) return false;
  const marker = JSON.parse(
    await readFile(resolve(resolved, "koed-managed-home.json"), "utf8")
  ) as unknown;
  const metadata = record(marker);
  return metadata.version === 1 && metadata.kind === "koed-managed-codex-home";
};

export const discoverManagedConversationRuntime = async (input: {
  koedHome: string;
  providerThreadId: string;
}): Promise<DiscoveredManagedConversationRuntime | null> => {
  const managedRoot = resolve(input.koedHome, "codex-managed");
  const root = await realpath(managedRoot).catch(() => null);
  if (!root) return null;
  const homeEntries = await readdir(root, { withFileTypes: true });
  if (homeEntries.length > maximumManagedHomes) {
    throw new Error("ManagedConversationRuntimeDiscoveryCapacityError");
  }
  const matches: DiscoveredManagedConversationRuntime[] = [];
  let visitedFiles = 0;
  for (const homeEntry of homeEntries) {
    if (!homeEntry.isDirectory() || !homeEntry.name.startsWith("session-")) {
      continue;
    }
    const managedHome = resolve(root, homeEntry.name);
    if (!(await managedHomeIsValid(root, managedHome).catch(() => false))) {
      continue;
    }
    const sessionsRoot = resolve(managedHome, "sessions");
    const pending = [sessionsRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const resolvedDirectory = await realpath(directory).catch(() => null);
      if (
        !resolvedDirectory ||
        !containedPath(managedHome, resolvedDirectory)
      ) {
        continue;
      }
      const entries = await readdir(resolvedDirectory, {
        withFileTypes: true
      }).catch(() => []);
      for (const entry of entries) {
        const candidate = resolve(resolvedDirectory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        visitedFiles += 1;
        if (visitedFiles > maximumTranscriptFiles) {
          throw new Error("ManagedConversationRuntimeDiscoveryCapacityError");
        }
        const candidateStat = await stat(candidate);
        if (!candidateStat.isFile() || candidateStat.size > 512 * 1024 * 1024) {
          continue;
        }
        const metadata = await readSessionMetadata(candidate).catch(() => null);
        const sessionId =
          typeof metadata?.session_id === "string"
            ? metadata.session_id
            : typeof metadata?.id === "string"
              ? metadata.id
              : null;
        if (sessionId !== input.providerThreadId) continue;
        matches.push({
          managedHome,
          transcriptPath: candidate,
          providerCliVersion:
            typeof metadata?.cli_version === "string"
              ? metadata.cli_version
              : null,
          projectPath:
            typeof metadata?.cwd === "string" && metadata.cwd.trim()
              ? metadata.cwd
              : null
        });
      }
    }
  }
  if (matches.length > 1) {
    throw new Error("ManagedConversationRuntimeDiscoveryConflictError");
  }
  return matches[0] ?? null;
};
