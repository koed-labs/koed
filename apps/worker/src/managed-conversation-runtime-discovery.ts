import { open, readdir, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const maximumTranscriptFiles = 16_384;
const maximumSessionMetadataBytes = 1024 * 1024;

export type DiscoveredManagedConversationRuntime = {
  codexHome: string;
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

export const discoverManagedConversationRuntime = async (input: {
  codexHome: string;
  providerThreadId: string;
}): Promise<DiscoveredManagedConversationRuntime | null> => {
  const codexHome = await realpath(resolve(input.codexHome)).catch(() => null);
  if (!codexHome) return null;
  const sessionsRoot = await realpath(resolve(codexHome, "sessions")).catch(
    () => null
  );
  if (!sessionsRoot || !containedPath(codexHome, sessionsRoot)) return null;
  const matches: DiscoveredManagedConversationRuntime[] = [];
  let visitedFiles = 0;
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const resolvedDirectory = await realpath(directory).catch(() => null);
    if (
      !resolvedDirectory ||
      (resolvedDirectory !== sessionsRoot &&
        !containedPath(sessionsRoot, resolvedDirectory))
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
      // Codex includes the thread UUID in every rollout filename. Filter on
      // that stable identity before opening transcript content so recovery
      // stays cheap even when CODEX_HOME contains years of large sessions.
      if (!entry.name.includes(input.providerThreadId)) continue;
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
        codexHome,
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
  if (matches.length > 1) {
    throw new Error("ManagedConversationRuntimeDiscoveryConflictError");
  }
  return matches[0] ?? null;
};
