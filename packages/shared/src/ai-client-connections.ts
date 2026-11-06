import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Koed reads an AI Client's conversations only while the User has connected
// it. Koed Server records which supported AI Clients are connected each time
// it checks their integrations; the Local AI Runtime starts and stops each
// client's Transcript Watcher and automatic history from this record.
export type AiClientConnectionId = "codex" | "claude" | "pi";

export const AI_CLIENT_CONNECTION_IDS: readonly AiClientConnectionId[] = [
  "codex",
  "claude",
  "pi"
];

export interface AiClientConnectionsRecord {
  version: 1;
  updatedAt: string;
  connected: Partial<Record<AiClientConnectionId, boolean>>;
}

export const aiClientConnectionsPath = (koedHome: string): string =>
  path.join(koedHome, "state", "ai-client-connections.json");

export const readAiClientConnections = (
  koedHome: string
): AiClientConnectionsRecord | null => {
  try {
    const value = JSON.parse(
      readFileSync(aiClientConnectionsPath(koedHome), "utf8")
    ) as Partial<AiClientConnectionsRecord>;
    if (
      value.version !== 1 ||
      typeof value.updatedAt !== "string" ||
      typeof value.connected !== "object" ||
      value.connected === null
    )
      return null;
    const connected: AiClientConnectionsRecord["connected"] = {};
    for (const id of AI_CLIENT_CONNECTION_IDS) {
      const flag = (value.connected as Record<string, unknown>)[id];
      if (typeof flag === "boolean") connected[id] = flag;
    }
    return { version: 1, updatedAt: value.updatedAt, connected };
  } catch {
    return null;
  }
};

/** Unknown until Koed Server has recorded the client, so nothing is read. */
export const isAiClientConnected = (
  record: AiClientConnectionsRecord | null,
  id: AiClientConnectionId
): boolean => record?.connected[id] === true;

/**
 * Records what an integration check observed. `undefined` means the check
 * could not tell (for example, it failed), which keeps the previous value so
 * a transient failure never starts or stops capture.
 */
export const recordAiClientConnections = (
  koedHome: string,
  observed: Partial<Record<AiClientConnectionId, boolean | undefined>>,
  now: Date = new Date()
): AiClientConnectionsRecord => {
  const previous = readAiClientConnections(koedHome);
  const connected = { ...previous?.connected };
  for (const id of AI_CLIENT_CONNECTION_IDS) {
    const flag = observed[id];
    if (typeof flag === "boolean") connected[id] = flag;
  }
  const unchanged =
    previous !== null &&
    AI_CLIENT_CONNECTION_IDS.every(
      (id) => previous.connected[id] === connected[id]
    );
  if (unchanged) return previous;
  const record: AiClientConnectionsRecord = {
    version: 1,
    updatedAt: now.toISOString(),
    connected
  };
  const target = aiClientConnectionsPath(koedHome);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return record;
};
