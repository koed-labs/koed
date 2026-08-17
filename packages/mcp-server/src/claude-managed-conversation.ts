import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  forkSession as forkClaudeSession,
  query,
  type McpServerConfig,
  type PermissionMode,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SettingSource
} from "@anthropic-ai/claude-agent-sdk";

import {
  claudeAgentSdkEnvironment,
  resolveClaudeCodeExecutable
} from "./ai-client-runner.js";

export const CLAUDE_MANAGED_CONVERSATION_PROVIDER = "claude" as const;

type SafePermissionMode = Exclude<PermissionMode, "bypassPermissions">;

export interface ClaudeManagedConversationConfig {
  cwd: string;
  model: string;
  permissionMode: SafePermissionMode;
  env?: NodeJS.ProcessEnv;
  managedHome: string;
  clientName?: string;
  sessionId?: string;
  resumeSessionId?: string;
  tools?: Options["tools"];
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  settingSources?: SettingSource[];
  systemPrompt?: Options["systemPrompt"];
  maxTurns?: number;
}

export interface ClaudeManagedConversationIdentity {
  provider: typeof CLAUDE_MANAGED_CONVERSATION_PROVIDER;
  sessionId: string;
  model: string;
  cwd: string;
  executablePath: string;
  managedHome: string;
  resumed: boolean;
  forkedFromSessionId?: string;
}

export interface ClaudeManagedConversationResult {
  provider: typeof CLAUDE_MANAGED_CONVERSATION_PROVIDER;
  sessionId: string;
  model: string;
  text: string;
  providerEvents: SDKMessage[];
  result: SDKResultMessage;
}

export interface ClaudeManagedConversationStartResult {
  identity: ClaudeManagedConversationIdentity;
  initialResult?: ClaudeManagedConversationResult;
}

export interface ClaudeManagedConversationLocalSource {
  transcriptPath: string;
  managedHome: string;
}

export interface ForkedClaudeTranscript {
  sessionId: string;
  bytes: Buffer;
}

export class ClaudeManagedConversationCancelledError extends Error {
  constructor() {
    super("Claude managed conversation prompt was cancelled");
    this.name = "ClaudeManagedConversationCancelledError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PERMISSION_MODES = new Set<SafePermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto"
]);

const assertSessionId = (sessionId: string, label: string): void => {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`${label} must be a valid UUID`);
  }
};

const assertNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
};

const claudeManagedHome = (env: NodeJS.ProcessEnv): string => {
  const configured = path.resolve(
    env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? os.homedir(), ".claude")
  );
  let canonical: string;
  try {
    canonical = fs.realpathSync(configured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Claude config home does not exist: ${configured}. Create it or set CLAUDE_CONFIG_DIR to an existing directory.`,
        { cause: error }
      );
    }
    throw new Error(
      `Claude config home could not be canonicalized: ${configured}`,
      {
        cause: error
      }
    );
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`Claude config home is not a directory: ${canonical}`);
  }
  return canonical;
};

const claudeSessionStoreHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.KOED_CLAUDE_SESSION_STORE_DIR ?? claudeManagedHome(env));

const managedClaudeRoot = (env: NodeJS.ProcessEnv): string =>
  path.join(
    path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed")),
    "run",
    "managed-claude"
  );

const MANAGED_CLAUDE_MARKER = ".koed-managed-claude-home";
const MANAGED_CLAUDE_LEASES = ".leases";
const MANAGED_CLAUDE_LEASE_KEY = ".lease-key";
const MANAGED_CLAUDE_LEASE_VERSION = 2;
const MANAGED_CLAUDE_HEARTBEAT_MS = 5_000;
const MANAGED_CLAUDE_STALE_MS = 30_000;

type ManagedClaudeLeaseState = "preparing" | "retained";

interface ManagedClaudeLeaseIdentity {
  version: typeof MANAGED_CLAUDE_LEASE_VERSION;
  kind: "koed-managed-claude-home";
  homeId: string;
  ownerId: string;
  ownerPid: number;
  createdAt: string;
  state: ManagedClaudeLeaseState;
}

interface ManagedClaudeMarker extends ManagedClaudeLeaseIdentity {
  signature: string;
}

interface ManagedClaudeLease extends ManagedClaudeLeaseIdentity {
  heartbeatAt: string;
  signature: string;
}

interface ActiveManagedClaudeLease {
  identity: ManagedClaudeLeaseIdentity;
  interval: ReturnType<typeof setInterval>;
}

const activeManagedClaudeLeases = new Map<string, ActiveManagedClaudeLease>();

const leaseIdentityJson = (identity: ManagedClaudeLeaseIdentity): string =>
  JSON.stringify({
    version: identity.version,
    kind: identity.kind,
    homeId: identity.homeId,
    ownerId: identity.ownerId,
    ownerPid: identity.ownerPid,
    createdAt: identity.createdAt,
    state: identity.state
  });

const leaseSignature = (
  key: Buffer,
  identity: ManagedClaudeLeaseIdentity,
  heartbeatAt?: string
): string =>
  createHmac("sha256", key)
    .update(leaseIdentityJson(identity))
    .update(heartbeatAt === undefined ? "" : `\n${heartbeatAt}`)
    .digest("hex");

const signatureMatches = (actual: unknown, expected: string): boolean => {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
};

const managedClaudeLeaseRoot = (root: string): string =>
  path.join(root, MANAGED_CLAUDE_LEASES);

const managedClaudeLeasePath = (root: string, homeId: string): string =>
  path.join(managedClaudeLeaseRoot(root), `${homeId}.json`);

const readRegularFile = (target: string): Buffer => {
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(
      `Managed Claude lease path is not a regular file: ${target}`
    );
  }
  return fs.readFileSync(target);
};

const initializeManagedClaudeRoot = (
  env: NodeJS.ProcessEnv
): { root: string; key: Buffer } => {
  const root = managedClaudeRoot(env);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(managedClaudeLeaseRoot(root), { recursive: true, mode: 0o700 });
  fs.chmodSync(managedClaudeLeaseRoot(root), 0o700);
  const keyPath = path.join(root, MANAGED_CLAUDE_LEASE_KEY);
  try {
    fs.writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = readRegularFile(keyPath);
  if (key.byteLength !== 32) {
    throw new Error("Managed Claude lease key is invalid");
  }
  return { root: fs.realpathSync(root), key };
};

const atomicWriteJson = (target: string, value: unknown): void => {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

const signedMarker = (
  key: Buffer,
  identity: ManagedClaudeLeaseIdentity
): ManagedClaudeMarker => ({
  ...identity,
  signature: leaseSignature(key, identity)
});

const signedLease = (
  key: Buffer,
  identity: ManagedClaudeLeaseIdentity,
  heartbeatAt = new Date().toISOString()
): ManagedClaudeLease => ({
  ...identity,
  heartbeatAt,
  signature: leaseSignature(key, identity, heartbeatAt)
});

const parseLeaseIdentity = (
  value: unknown
): ManagedClaudeLeaseIdentity | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== MANAGED_CLAUDE_LEASE_VERSION ||
    candidate.kind !== "koed-managed-claude-home" ||
    typeof candidate.homeId !== "string" ||
    !UUID_PATTERN.test(candidate.homeId) ||
    typeof candidate.ownerId !== "string" ||
    !UUID_PATTERN.test(candidate.ownerId) ||
    typeof candidate.ownerPid !== "number" ||
    !Number.isSafeInteger(candidate.ownerPid) ||
    candidate.ownerPid <= 0 ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    (candidate.state !== "preparing" && candidate.state !== "retained")
  ) {
    return null;
  }
  return candidate as unknown as ManagedClaudeLeaseIdentity;
};

const verifiedManagedClaudeLease = (
  target: string,
  root: string,
  key: Buffer,
  leasePath = managedClaudeLeasePath(
    root,
    path.basename(target).replace(/^session-/, "")
  )
): {
  resolved: string;
  identity: ManagedClaudeLeaseIdentity;
  lease: ManagedClaudeLease;
} => {
  const resolved = fs.realpathSync(target);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to use an unmanaged Claude home");
  }
  const markerValue = JSON.parse(
    readRegularFile(path.join(resolved, MANAGED_CLAUDE_MARKER)).toString("utf8")
  ) as unknown;
  const markerIdentity = parseLeaseIdentity(markerValue);
  if (!markerIdentity) throw new Error("Managed Claude home marker is invalid");
  const marker = markerValue as ManagedClaudeMarker;
  if (
    !signatureMatches(marker.signature, leaseSignature(key, markerIdentity))
  ) {
    throw new Error("Managed Claude home marker signature is invalid");
  }
  const leaseValue = JSON.parse(
    readRegularFile(leasePath).toString("utf8")
  ) as unknown;
  const leaseIdentity = parseLeaseIdentity(leaseValue);
  const lease = leaseValue as ManagedClaudeLease;
  if (
    !leaseIdentity ||
    path.basename(resolved) !== `session-${markerIdentity.homeId}` ||
    leaseIdentityJson(markerIdentity) !== leaseIdentityJson(leaseIdentity) ||
    typeof lease.heartbeatAt !== "string" ||
    !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
    !signatureMatches(
      lease.signature,
      leaseSignature(key, leaseIdentity, lease.heartbeatAt)
    )
  ) {
    throw new Error("Managed Claude home lease is invalid");
  }
  return { resolved, identity: markerIdentity, lease };
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const stopManagedClaudeHeartbeat = (resolved: string): void => {
  const active = activeManagedClaudeLeases.get(resolved);
  if (!active) return;
  clearInterval(active.interval);
  activeManagedClaudeLeases.delete(resolved);
};

const startManagedClaudeHeartbeat = (
  resolved: string,
  root: string,
  key: Buffer,
  identity: ManagedClaudeLeaseIdentity
): void => {
  stopManagedClaudeHeartbeat(resolved);
  const beat = (): void => {
    try {
      const active = activeManagedClaudeLeases.get(resolved);
      if (!active || active.identity.ownerId !== identity.ownerId) return;
      atomicWriteJson(
        managedClaudeLeasePath(root, identity.homeId),
        signedLease(key, active.identity)
      );
    } catch {
      stopManagedClaudeHeartbeat(resolved);
    }
  };
  const interval = setInterval(beat, MANAGED_CLAUDE_HEARTBEAT_MS);
  interval.unref?.();
  activeManagedClaudeLeases.set(resolved, { identity, interval });
};

export const cleanupAbandonedManagedClaudeHomes = (
  env: NodeJS.ProcessEnv = process.env,
  options: {
    now?: number;
    staleAfterMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {}
): string[] => {
  const { root, key } = initializeManagedClaudeRoot(env);
  const removed: string[] = [];
  for (const entry of fs.readdirSync(managedClaudeLeaseRoot(root), {
    withFileTypes: true
  })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !entry.name.endsWith(".json")
    )
      continue;
    const homeId = entry.name.slice(0, -5);
    const target = path.join(root, `session-${homeId}`);
    let verified: ReturnType<typeof verifiedManagedClaudeLease>;
    try {
      verified = verifiedManagedClaudeLease(target, root, key);
    } catch {
      continue;
    }
    const active = activeManagedClaudeLeases.get(verified.resolved);
    const stale =
      (options.now ?? Date.now()) - Date.parse(verified.lease.heartbeatAt) >=
      (options.staleAfterMs ?? MANAGED_CLAUDE_STALE_MS);
    if (
      verified.identity.state !== "preparing" ||
      active?.identity.ownerId === verified.identity.ownerId ||
      !stale ||
      (options.isProcessAlive ?? processIsAlive)(verified.identity.ownerPid)
    ) {
      continue;
    }
    const leasePath = managedClaudeLeasePath(root, verified.identity.homeId);
    const reapPath = `${leasePath}.reaping-${randomUUID()}`;
    try {
      fs.renameSync(leasePath, reapPath);
    } catch {
      continue;
    }
    let reaped = false;
    try {
      const claimed = verifiedManagedClaudeLease(target, root, key, reapPath);
      const claimedStale =
        (options.now ?? Date.now()) - Date.parse(claimed.lease.heartbeatAt) >=
        (options.staleAfterMs ?? MANAGED_CLAUDE_STALE_MS);
      if (
        claimed.identity.state === "preparing" &&
        claimedStale &&
        !(options.isProcessAlive ?? processIsAlive)(claimed.identity.ownerPid)
      ) {
        fs.rmSync(claimed.resolved, { recursive: true, force: true });
        reaped = true;
        removed.push(claimed.resolved);
      }
    } catch {
      // A concurrently renewed or changed identity is not safe to reap.
    } finally {
      if (!reaped && !fs.existsSync(leasePath)) {
        try {
          fs.renameSync(reapPath, leasePath);
        } catch {
          // Another owner won the lease; leave its record untouched.
        }
      }
      fs.rmSync(reapPath, { force: true });
    }
  }
  return removed;
};

export const prepareManagedClaudeHome = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  cleanupAbandonedManagedClaudeHomes(env);
  const { root, key } = initializeManagedClaudeRoot(env);
  const homeId = randomUUID();
  const target = path.join(root, `session-${homeId}`);
  fs.mkdirSync(target, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  try {
    const identity: ManagedClaudeLeaseIdentity = {
      version: MANAGED_CLAUDE_LEASE_VERSION,
      kind: "koed-managed-claude-home",
      homeId,
      ownerId: randomUUID(),
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      state: "preparing"
    };
    atomicWriteJson(
      path.join(target, MANAGED_CLAUDE_MARKER),
      signedMarker(key, identity)
    );
    atomicWriteJson(
      managedClaudeLeasePath(root, homeId),
      signedLease(key, identity)
    );
    fs.mkdirSync(path.join(target, "projects"), { mode: 0o700 });
    const resolved = fs.realpathSync(target);
    startManagedClaudeHeartbeat(resolved, root, key, identity);
    return resolved;
  } catch (error) {
    stopManagedClaudeHeartbeat(target);
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(managedClaudeLeasePath(root, homeId), { force: true });
    throw error;
  }
};

export const destroyManagedClaudeHome = (
  target: string,
  env: NodeJS.ProcessEnv = process.env
): void => {
  const { root, key } = initializeManagedClaudeRoot(env);
  const verified = verifiedManagedClaudeLease(target, root, key);
  const active = activeManagedClaudeLeases.get(verified.resolved);
  if (
    active?.identity.ownerId !== verified.identity.ownerId &&
    processIsAlive(verified.identity.ownerPid)
  ) {
    throw new Error("Refusing to remove an active managed Claude home");
  }
  stopManagedClaudeHeartbeat(verified.resolved);
  fs.rmSync(verified.resolved, { recursive: true, force: true });
  fs.rmSync(managedClaudeLeasePath(root, verified.identity.homeId), {
    force: true
  });
};

export const retainManagedClaudeHome = (
  target: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const { root, key } = initializeManagedClaudeRoot(env);
  const verified = verifiedManagedClaudeLease(target, root, key);
  const active = activeManagedClaudeLeases.get(verified.resolved);
  if (active?.identity.ownerId !== verified.identity.ownerId) {
    throw new Error(
      "Refusing to retain a managed Claude home not owned by this process"
    );
  }
  const identity = { ...verified.identity, state: "retained" as const };
  atomicWriteJson(
    path.join(verified.resolved, MANAGED_CLAUDE_MARKER),
    signedMarker(key, identity)
  );
  atomicWriteJson(
    managedClaudeLeasePath(root, identity.homeId),
    signedLease(key, identity)
  );
  startManagedClaudeHeartbeat(verified.resolved, root, key, identity);
  return verified.resolved;
};

export const releaseManagedClaudeHomeLease = (
  target: string,
  env: NodeJS.ProcessEnv = process.env
): void => {
  const { root, key } = initializeManagedClaudeRoot(env);
  const verified = verifiedManagedClaudeLease(target, root, key);
  const active = activeManagedClaudeLeases.get(verified.resolved);
  if (active?.identity.ownerId !== verified.identity.ownerId) {
    throw new Error(
      "Refusing to release a managed Claude home not owned by this process"
    );
  }
  stopManagedClaudeHeartbeat(verified.resolved);
};

export const reuseManagedClaudeHome = (
  target: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const { root, key } = initializeManagedClaudeRoot(env);
  const verified = verifiedManagedClaudeLease(target, root, key);
  const current = activeManagedClaudeLeases.get(verified.resolved);
  if (current?.identity.ownerId === verified.identity.ownerId) {
    return verified.resolved;
  }
  if (
    verified.identity.ownerPid !== process.pid &&
    processIsAlive(verified.identity.ownerPid)
  ) {
    throw new Error("Refusing to reuse an active managed Claude home");
  }
  const identity: ManagedClaudeLeaseIdentity = {
    ...verified.identity,
    ownerId: randomUUID(),
    ownerPid: process.pid,
    state: "retained"
  };
  atomicWriteJson(
    path.join(verified.resolved, MANAGED_CLAUDE_MARKER),
    signedMarker(key, identity)
  );
  atomicWriteJson(
    managedClaudeLeasePath(root, identity.homeId),
    signedLease(key, identity)
  );
  startManagedClaudeHeartbeat(verified.resolved, root, key, identity);
  return verified.resolved;
};

const parseTranscriptEntries = (bytes: Uint8Array): SessionStoreEntry[] => {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0 || buffer.at(-1) !== 0x0a) {
    throw new Error("Claude fork transcript must be non-empty complete JSONL");
  }
  return buffer
    .toString("utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const value = JSON.parse(line) as unknown;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).type !== "string"
      ) {
        throw new Error("Claude fork transcript contains an invalid entry");
      }
      return value as SessionStoreEntry;
    });
};

const transcriptMatches = (
  managedHome: string,
  sessionId: string
): string[] => {
  const projectsRoot = fs.realpathSync(path.join(managedHome, "projects"));
  const expectedName = `${sessionId}.jsonl`;
  const matches: string[] = [];
  for (const project of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const candidate = path.join(projectsRoot, project.name, expectedName);
    try {
      const canonical = fs.realpathSync(candidate);
      const file = fs.lstatSync(canonical);
      if (
        file.isFile() &&
        !file.isSymbolicLink() &&
        canonical.startsWith(`${projectsRoot}${path.sep}`)
      ) {
        matches.push(canonical);
      }
    } catch {
      // This project directory does not contain the requested session.
    }
  }
  return matches;
};

const sessionStoreProjectDirectory = (
  managedHome: string,
  projectKey: string
): string =>
  path.join(
    managedHome,
    "projects",
    createHash("sha256").update(projectKey).digest("hex")
  );

export const createManagedClaudeSessionStore = (
  managedHome: string
): SessionStore => {
  const canonicalHome = fs.realpathSync(managedHome);
  const projectsRoot = path.join(canonicalHome, "projects");
  fs.mkdirSync(projectsRoot, { recursive: true, mode: 0o700 });
  const transcriptFor = (key: SessionKey, create: boolean): string | null => {
    assertSessionId(key.sessionId, "Claude SessionStore session ID");
    if (key.subpath !== undefined) {
      throw new Error("Claude managed SessionStore subpaths are unsupported");
    }
    const matches = transcriptMatches(canonicalHome, key.sessionId);
    if (matches.length > 1) {
      throw new Error(
        `Claude session ${key.sessionId} resolves to multiple transcripts`
      );
    }
    if (matches[0]) return matches[0];
    if (!create) return null;
    const project = sessionStoreProjectDirectory(canonicalHome, key.projectKey);
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    return path.join(project, `${key.sessionId}.jsonl`);
  };
  return {
    append(key, entries) {
      if (entries.length === 0) return Promise.resolve();
      const transcript = transcriptFor(key, true);
      if (!transcript)
        throw new Error("Claude managed transcript path is missing");
      if (fs.existsSync(transcript)) {
        const info = fs.lstatSync(transcript);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error("Claude managed transcript is not a regular file");
        }
      }
      fs.appendFileSync(
        transcript,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      fs.chmodSync(transcript, 0o600);
      return Promise.resolve();
    },
    load(key) {
      const transcript = transcriptFor(key, false);
      return Promise.resolve(
        transcript ? parseTranscriptEntries(fs.readFileSync(transcript)) : null
      );
    }
  };
};

export const forkClaudeTranscript = async (input: {
  parentSessionId: string;
  cwd: string;
  transcriptBytes: Uint8Array;
}): Promise<ForkedClaudeTranscript> => {
  assertSessionId(input.parentSessionId, "Claude fork parent session ID");
  const parentEntries = parseTranscriptEntries(input.transcriptBytes);
  const output: {
    childKey?: SessionKey;
    childEntries: SessionStoreEntry[];
  } = { childEntries: [] };
  const store: SessionStore = {
    append(key, entries) {
      if (key.sessionId === input.parentSessionId) {
        throw new Error("Claude Agent SDK attempted to mutate the fork parent");
      }
      if (key.subpath !== undefined) {
        return Promise.resolve();
      }
      if (output.childKey && output.childKey.sessionId !== key.sessionId) {
        throw new Error("Claude Agent SDK produced multiple fork identities");
      }
      output.childKey = { ...key };
      output.childEntries = [
        ...output.childEntries,
        ...structuredClone(entries)
      ];
      return Promise.resolve();
    },
    load(key) {
      if (
        key.sessionId === input.parentSessionId &&
        key.subpath === undefined
      ) {
        return Promise.resolve(structuredClone(parentEntries));
      }
      if (
        output.childKey?.sessionId === key.sessionId &&
        output.childKey.subpath === key.subpath
      ) {
        return Promise.resolve(structuredClone(output.childEntries));
      }
      return Promise.resolve(null);
    }
  };
  const fork = await forkClaudeSession(input.parentSessionId, {
    dir: fs.realpathSync(input.cwd),
    sessionStore: store
  });
  assertSessionId(fork.sessionId, "Claude fork session ID");
  if (fork.sessionId === input.parentSessionId) {
    throw new Error("Claude Agent SDK fork did not create a distinct session");
  }
  if (
    output.childKey?.sessionId !== fork.sessionId ||
    output.childEntries.length === 0
  ) {
    throw new Error("Claude Agent SDK did not produce a complete fork");
  }
  return {
    sessionId: fork.sessionId,
    bytes: Buffer.from(
      `${output.childEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8"
    )
  };
};

export const resolveClaudeManagedConversationSource = (
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): ClaudeManagedConversationLocalSource => {
  assertSessionId(sessionId, "Claude session ID");
  const managedHome = fs.realpathSync(claudeSessionStoreHome(env));
  const matches = transcriptMatches(managedHome, sessionId);
  const transcriptPath = matches[0];
  if (matches.length !== 1 || !transcriptPath) {
    throw new Error(
      matches.length === 0
        ? `Claude transcript was not found for session ${sessionId}`
        : `Claude session ${sessionId} resolves to multiple transcripts`
    );
  }
  const info = fs.statSync(transcriptPath);
  if (!info.isFile()) {
    throw new Error(`Claude transcript is not a file: ${transcriptPath}`);
  }
  return {
    transcriptPath,
    managedHome
  };
};

const resultText = (result: SDKResultMessage): string => {
  if (result.subtype !== "success" || result.is_error) {
    const detail =
      "errors" in result && result.errors.length > 0
        ? result.errors.join("; ")
        : `Claude Agent SDK returned ${result.subtype}`;
    throw new Error(detail);
  }
  return result.structured_output === undefined
    ? result.result
    : JSON.stringify(result.structured_output);
};

/**
 * A fail-closed, Agent-SDK-only Claude conversation suitable for local workers.
 * Each prompt is a bounded SDK query against one explicitly managed session ID.
 */
export class ClaudeManagedConversationSession {
  private readonly config: ClaudeManagedConversationConfig;
  private readonly executablePath: string;
  private readonly cwd: string;
  private readonly model: string;
  private readonly managedHome: string;
  private readonly sessionStore: SessionStore;
  private readonly sessionId: string;
  private readonly resumed: boolean;
  private readonly forkedFromSessionId?: string;
  private readonly sdkEnvironment: Record<string, string | undefined>;
  private turnQueue: Promise<void> = Promise.resolve();
  private activeAbortController: AbortController | null = null;
  private activeQuery: Query | null = null;
  private started = false;
  private submittedQuery = false;
  private closed = false;

  constructor(
    config: ClaudeManagedConversationConfig,
    internal?: { forkedFromSessionId?: string }
  ) {
    this.config = config;
    this.model = assertNonEmpty(config.model, "Claude model");
    if (!SAFE_PERMISSION_MODES.has(config.permissionMode)) {
      throw new Error(
        "Claude managed conversation permissionMode must be explicitly set to a non-bypassing mode"
      );
    }
    if (
      config.maxTurns !== undefined &&
      (!Number.isInteger(config.maxTurns) || config.maxTurns <= 0)
    ) {
      throw new Error("Claude managed conversation maxTurns must be positive");
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = fs.realpathSync(config.cwd);
    } catch {
      throw new Error(
        `Claude managed conversation cwd does not exist: ${config.cwd}`
      );
    }
    if (!fs.statSync(canonicalCwd).isDirectory()) {
      throw new Error(
        `Claude managed conversation cwd is not a directory: ${canonicalCwd}`
      );
    }
    this.cwd = canonicalCwd;

    const sourceEnvironment = config.env ?? process.env;
    this.executablePath = resolveClaudeCodeExecutable(sourceEnvironment);
    this.sdkEnvironment = claudeAgentSdkEnvironment(
      sourceEnvironment,
      config.clientName ?? "claude-managed-conversation"
    );
    this.sdkEnvironment.CLAUDE_CONFIG_DIR =
      claudeManagedHome(sourceEnvironment);
    this.managedHome = fs.realpathSync(config.managedHome);
    this.sessionStore = createManagedClaudeSessionStore(this.managedHome);
    if (this.sdkEnvironment.ANTHROPIC_API_KEY !== undefined) {
      throw new Error(
        "Claude managed conversation environment must not contain ANTHROPIC_API_KEY"
      );
    }

    if (
      config.sessionId !== undefined &&
      config.resumeSessionId !== undefined
    ) {
      throw new Error(
        "Claude managed conversation cannot start and resume the same session"
      );
    }
    if (config.resumeSessionId !== undefined) {
      assertSessionId(config.resumeSessionId, "Claude resume session ID");
      this.sessionId = config.resumeSessionId;
      this.resumed = true;
    } else if (config.sessionId !== undefined) {
      assertSessionId(config.sessionId, "Claude session ID");
      this.sessionId = config.sessionId;
      this.resumed = false;
    } else {
      this.sessionId = randomUUID();
      this.resumed = false;
    }
    if (internal?.forkedFromSessionId !== undefined) {
      assertSessionId(
        internal.forkedFromSessionId,
        "Claude fork parent session ID"
      );
      this.forkedFromSessionId = internal.forkedFromSessionId;
    }
  }

  get identity(): ClaudeManagedConversationIdentity {
    return {
      provider: CLAUDE_MANAGED_CONVERSATION_PROVIDER,
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      executablePath: this.executablePath,
      managedHome: this.managedHome,
      resumed: this.resumed,
      ...(this.forkedFromSessionId
        ? { forkedFromSessionId: this.forkedFromSessionId }
        : {})
    };
  }

  async start(
    initialPrompt?: string
  ): Promise<ClaudeManagedConversationStartResult> {
    this.assertOpen();
    if (this.started) {
      if (initialPrompt !== undefined) {
        throw new Error(
          "Claude managed conversation has already started; use prompt()"
        );
      }
      return { identity: this.identity };
    }
    this.started = true;
    if (initialPrompt === undefined) {
      return { identity: this.identity };
    }
    return {
      identity: this.identity,
      initialResult: await this.prompt(initialPrompt)
    };
  }

  async prompt(prompt: string): Promise<ClaudeManagedConversationResult> {
    const normalizedPrompt = assertNonEmpty(prompt, "Claude prompt");
    this.assertOpen();
    if (!this.started) {
      await this.start();
    }
    const operation = this.turnQueue.then(() =>
      this.runPrompt(normalizedPrompt)
    );
    this.turnQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async runPrompt(
    prompt: string
  ): Promise<ClaudeManagedConversationResult> {
    this.assertOpen();
    const abortController = new AbortController();
    const shouldResume = this.resumed || this.submittedQuery;
    let stream: Query;
    try {
      stream = query({
        prompt,
        options: {
          abortController,
          cwd: this.cwd,
          env: this.sdkEnvironment,
          pathToClaudeCodeExecutable: this.executablePath,
          model: this.model,
          permissionMode: this.config.permissionMode,
          tools: this.config.tools ?? [],
          allowedTools: this.config.allowedTools ?? [],
          mcpServers: this.config.mcpServers ?? {},
          strictMcpConfig: true,
          settingSources: this.config.settingSources ?? [],
          sessionStore: this.sessionStore,
          persistSession: true,
          maxTurns: this.config.maxTurns ?? 1,
          includePartialMessages: false,
          forwardSubagentText: false,
          ...(this.config.systemPrompt === undefined
            ? {}
            : { systemPrompt: this.config.systemPrompt }),
          ...(shouldResume
            ? { resume: this.sessionId }
            : { sessionId: this.sessionId })
        }
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new ClaudeManagedConversationCancelledError();
      }
      throw error;
    }

    this.submittedQuery = true;
    this.activeAbortController = abortController;
    this.activeQuery = stream;
    const providerEvents: SDKMessage[] = [];
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of stream) {
        if (
          "session_id" in message &&
          typeof message.session_id === "string" &&
          message.session_id !== this.sessionId
        ) {
          stream.close();
          throw new Error(
            `Claude Agent SDK returned unexpected session ID ${message.session_id}`
          );
        }
        providerEvents.push(message);
        if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new ClaudeManagedConversationCancelledError();
      }
      try {
        stream.close();
      } catch {
        // Preserve the transport failure that interrupted the turn.
      }
      throw error;
    } finally {
      if (this.activeQuery === stream) {
        this.activeQuery = null;
        this.activeAbortController = null;
      }
    }

    if (!result) {
      throw new Error("Claude Agent SDK completed without a result message");
    }
    const model = Object.keys(result.modelUsage ?? {})[0] ?? this.model;
    return {
      provider: CLAUDE_MANAGED_CONVERSATION_PROVIDER,
      sessionId: this.sessionId,
      model,
      text: resultText(result),
      providerEvents,
      result
    };
  }

  async fork(): Promise<ClaudeManagedConversationSession> {
    this.assertOpen();
    await this.turnQueue;
    this.assertOpen();
    const parentSessionId = this.sessionId;
    const guardedStore: SessionStore = {
      load: (key) => this.sessionStore.load(key),
      append: (key, entries) => {
        if (key.sessionId === parentSessionId) {
          throw new Error(
            "Claude Agent SDK attempted to mutate the fork parent"
          );
        }
        return this.sessionStore.append(key, entries);
      }
    };
    const fork = await forkClaudeSession(parentSessionId, {
      dir: this.cwd,
      sessionStore: guardedStore
    });
    assertSessionId(fork.sessionId, "Claude fork session ID");
    if (fork.sessionId === parentSessionId) {
      throw new Error(
        "Claude Agent SDK fork did not create a distinct session"
      );
    }
    return new ClaudeManagedConversationSession(
      {
        ...this.config,
        env: {
          ...this.sdkEnvironment,
          KOED_CLAUDE_CODE_EXECUTABLE: this.executablePath
        },
        managedHome: this.managedHome,
        cwd: this.cwd,
        model: this.model,
        resumeSessionId: fork.sessionId
      },
      { forkedFromSessionId: this.sessionId }
    );
  }

  cancel(): void {
    this.activeAbortController?.abort();
    this.activeQuery?.close();
  }

  async waitForIdle(): Promise<void> {
    await this.turnQueue;
  }

  async closeAndWait(): Promise<void> {
    this.close();
    await this.turnQueue;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancel();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Claude managed conversation session is closed");
    }
  }
}
