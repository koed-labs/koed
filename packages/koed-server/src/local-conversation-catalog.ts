import { createHash } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveKoedServerPaths } from "./paths.js";

/** Public, path-free summary of a locally discovered AI-client conversation. */
export interface LocalConversationSource {
  sourceId: string;
  provider: "codex" | "claude-code" | "pi";
  title: string;
  activityAt: string;
  projectId?: string;
  projectName?: string;
}

export interface LocalConversationCatalogPage {
  items: LocalConversationSource[];
  nextCursor: string | null;
  providers: Record<"codex" | "claude-code" | "pi", LocalSourceStatus>;
  truncated: boolean;
}

export interface LocalSourceStatus {
  status:
    | "available"
    | "unavailable"
    | "invalid"
    | "partial"
    | "limited"
    | "not_requested";
  /** Stable, non-sensitive code; filesystem paths and error text are omitted. */
  code?:
    | "source_root_missing"
    | "source_root_invalid"
    | "discovery_limit_reached"
    | "source_identity_invalid";
}

export interface ListLocalConversationSourcesOptions {
  limit?: number;
  cursor?: string;
  provider?: LocalConversationSource["provider"];
  env?: NodeJS.ProcessEnv;
  /** Bypass the process-local completed scan cache and refresh it on success. */
  refresh?: boolean;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const CATALOG_CACHE_TTL_MS = 30_000;
const MAX_CATALOG_CACHE_SCOPES = 6;
const MAX_DISCOVERED_ENTRIES = 50_000;
const MAX_DISCOVERED_FILES = 20_000;
const MAX_HEADER_BYTES = 64 * 1024;
const HEADER_READ_CHUNK_BYTES = 4 * 1024;
const CLAUDE_IDENTITY_MAX_RECORDS = 2_000;
const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CatalogSnapshot = {
  items: LocalConversationSource[];
  providers: LocalConversationCatalogPage["providers"];
  truncated: boolean;
};
type CatalogCacheEntry = { snapshot: CatalogSnapshot; expiresAt: number };

const completedCatalogScans = new Map<string, CatalogCacheEntry>();
const inFlightCatalogScans = new Map<string, Promise<CatalogSnapshot>>();

type Provider = LocalConversationSource["provider"];
type Candidate = LocalConversationSource & {
  privatePath: string;
  privateCwd?: string;
  privateRepositoryUrl?: string;
};
type HeaderRecord = { record: Record<string, unknown>; stats: Stats };
type Cursor = { activityAt: string; sourceId: string; version: 1 };
type RootSpec = { provider: Provider; paths: string[]; extensions: string[] };
type RegisteredProjectIdentity = {
  localProjectId: string;
  displayName: string;
};

type LocalGitIdentity = {
  commonDirectory: string;
  projectRoot?: string;
  originUrl?: string;
};

const homeDirectory = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.HOME?.trim() || os.homedir());

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const normalizedAbsolutePath = (value: string): string =>
  path.resolve(value.trim());

const canonicalProjectPath = async (value: string): Promise<string> => {
  const resolved = normalizedAbsolutePath(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
};

const readSmallRegularFile = async (
  filename: string,
  maxBytes: number
): Promise<string | undefined> => {
  try {
    const details = await lstat(filename);
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.size > maxBytes
    )
      return undefined;
    return await readFile(filename, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Return the shared Git directory for a real local checkout. Reading only
 * bounded Git metadata lets linked worktrees share identity without invoking
 * Git for every transcript or trusting the checkout's basename.
 */
const readLocalGitIdentity = async (
  cwd: string
): Promise<LocalGitIdentity | undefined> => {
  try {
    const resolvedCwd = await realpath(normalizedAbsolutePath(cwd));
    const cwdStats = await lstat(resolvedCwd);
    if (cwdStats.isSymbolicLink() || !cwdStats.isDirectory()) return undefined;
    const gitEntry = path.join(resolvedCwd, ".git");
    const gitStats = await lstat(gitEntry);
    if (gitStats.isSymbolicLink()) return undefined;

    let gitDirectory: string;
    if (gitStats.isDirectory()) gitDirectory = await realpath(gitEntry);
    else if (gitStats.isFile()) {
      const pointer = await readSmallRegularFile(gitEntry, 4_096);
      const match = pointer?.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!match) return undefined;
      gitDirectory = await realpath(path.resolve(resolvedCwd, match[1]!));
    } else return undefined;

    const commonDirectoryFile = path.join(gitDirectory, "commondir");
    const commonDirectoryValue = await readSmallRegularFile(
      commonDirectoryFile,
      4_096
    );
    const commonDirectory = commonDirectoryValue
      ? await realpath(path.resolve(gitDirectory, commonDirectoryValue.trim()))
      : gitDirectory;
    const config = await readSmallRegularFile(
      path.join(commonDirectory, "config"),
      64 * 1024
    );
    let inOriginSection = false;
    let originUrl: string | undefined;
    for (const line of config?.split(/\r?\n/) ?? []) {
      const section = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
      if (section) {
        inOriginSection = /^remote\s+"origin"$/i.test(section);
        continue;
      }
      if (!originUrl && inOriginSection)
        originUrl = line.match(/^\s*url\s*=\s*(\S.*?)\s*$/i)?.[1];
    }
    return {
      commonDirectory,
      ...(path.basename(commonDirectory) === ".git"
        ? { projectRoot: path.dirname(commonDirectory) }
        : {}),
      ...(originUrl ? { originUrl } : {})
    };
  } catch {
    return undefined;
  }
};

/** Read project identities without invoking the metadata store's migration/write path. */
const readRegisteredProjectIdentities = async (
  env: NodeJS.ProcessEnv
): Promise<Map<string, RegisteredProjectIdentity>> => {
  try {
    const registry = JSON.parse(
      await readFile(resolveKoedServerPaths(env).projectMetadataPath, "utf8")
    ) as unknown;
    if (!registry || typeof registry !== "object" || Array.isArray(registry))
      return new Map();
    const projects = (registry as { projects?: unknown }).projects;
    if (!Array.isArray(projects)) return new Map();

    const records: Array<{
      identity: RegisteredProjectIdentity;
      paths: Set<string>;
      root: string | null;
    }> = [];
    for (const value of projects) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const project = value as {
        localProjectId?: unknown;
        displayName?: unknown;
        path?: { cwd?: unknown; projectRoot?: unknown };
      };
      if (
        typeof project.localProjectId !== "string" ||
        !project.localProjectId.trim() ||
        typeof project.displayName !== "string" ||
        !project.displayName.trim() ||
        !project.path ||
        typeof project.path !== "object"
      )
        continue;
      const identity = {
        localProjectId: project.localProjectId.trim(),
        displayName: project.displayName.trim()
      };
      const registeredPaths = new Set<string>();
      for (const registeredPath of [
        project.path.cwd,
        project.path.projectRoot
      ]) {
        if (
          typeof registeredPath !== "string" ||
          !path.isAbsolute(registeredPath)
        )
          continue;
        registeredPaths.add(await canonicalProjectPath(registeredPath));
      }
      if (registeredPaths.size)
        records.push({
          identity,
          paths: registeredPaths,
          root:
            typeof project.path.projectRoot === "string" &&
            path.isAbsolute(project.path.projectRoot)
              ? await canonicalProjectPath(project.path.projectRoot)
              : typeof project.path.cwd === "string" &&
                  path.isAbsolute(project.path.cwd)
                ? await canonicalProjectPath(project.path.cwd)
                : null
        });
    }

    // A repeated local ID on unrelated registry records is corrupt or ambiguous.
    // Do not let either record cause unrelated source folders to merge.
    const recordsById = new Map<string, Set<number>>();
    for (const [index, record] of records.entries()) {
      const indexes =
        recordsById.get(record.identity.localProjectId) ?? new Set();
      indexes.add(index);
      recordsById.set(record.identity.localProjectId, indexes);
    }
    const ambiguousIds = new Set<string>();
    for (const [localProjectId, indexes] of recordsById) {
      const entries = [...indexes].map((index) => records[index]!);
      if (
        entries.some(
          (record, index) =>
            entries
              .slice(index + 1)
              .every((other) =>
                [...record.paths].some((registeredPath) =>
                  other.paths.has(registeredPath)
                )
              ) === false
        ) &&
        entries.length > 1
      )
        ambiguousIds.add(localProjectId);
    }

    const matches = new Map<string, RegisteredProjectIdentity | null>();
    // A selected folder owns its root. A legacy parent-project record may
    // retain that folder as its last cwd, but must not override that ownership.
    const exactRoots = new Set(
      records
        .filter((record) => !ambiguousIds.has(record.identity.localProjectId))
        .flatMap((record) => (record.root ? [record.root] : []))
    );
    for (const record of records) {
      if (ambiguousIds.has(record.identity.localProjectId)) continue;
      for (const key of record.paths) {
        if (key !== record.root && exactRoots.has(key)) continue;
        const existing = matches.get(key);
        if (existing === undefined) matches.set(key, record.identity);
        else if (
          existing === null ||
          existing.localProjectId !== record.identity.localProjectId ||
          existing.displayName !== record.identity.displayName
        )
          matches.set(key, null);
      }
    }
    return new Map(
      [...matches].filter(
        (entry): entry is [string, RegisteredProjectIdentity] =>
          entry[1] !== null
      )
    );
  } catch {
    // Local source discovery must continue if Koed metadata is absent or invalid.
    return new Map();
  }
};

/** Read optional Codex UI titles without invoking migrations or writes. */
const readCodexThreadTitles = async (
  env: NodeJS.ProcessEnv
): Promise<Map<string, string>> => {
  try {
    const codexHome = path.resolve(
      env.CODEX_HOME?.trim() || path.join(homeDirectory(env), ".codex")
    );
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(codexHome, "state_5.sqlite"), {
      readOnly: true,
      timeout: 100
    });
    try {
      const columns = new Set(
        database
          .prepare('PRAGMA table_info("threads")')
          .all()
          .map((row) => row.name)
      );
      if (!columns.has("id")) return new Map();
      const titleColumns = ["name", "title"].filter((column) =>
        columns.has(column)
      );
      if (titleColumns.length === 0) return new Map();
      const recencyColumn = ["updated_at", "modified_at", "created_at"].find(
        (column) => columns.has(column)
      );
      const selectedColumns = ["id", ...titleColumns]
        .map((column) =>
          column === "id"
            ? '"id"'
            : `CAST(substr(CAST("${column}" AS BLOB), 1, 512) AS TEXT) AS "${column}"`
        )
        .join(", ");
      const validIdPredicate =
        'typeof("id") = \'text\' AND length(CAST("id" AS BLOB)) BETWEEN 1 AND 512';
      const orderBy = recencyColumn ? `"${recencyColumn}" DESC` : "rowid DESC";
      let rows;
      try {
        rows = database
          .prepare(
            `SELECT ${selectedColumns} FROM "threads" WHERE ${validIdPredicate} ORDER BY ${orderBy} LIMIT ${MAX_DISCOVERED_FILES}`
          )
          .all();
      } catch {
        // A WITHOUT ROWID schema can still provide a bounded fallback query.
        rows = database
          .prepare(
            `SELECT ${selectedColumns} FROM "threads" WHERE ${validIdPredicate} LIMIT ${MAX_DISCOVERED_FILES}`
          )
          .all();
      }
      const titles = new Map<string, string>();
      for (const row of rows) {
        if (typeof row.id !== "string" || !row.id.trim()) continue;
        let title: string | undefined;
        for (const column of titleColumns) {
          const candidate = row[column];
          if (typeof candidate !== "string") continue;
          title = normalizeTitle(candidate);
          if (title) break;
        }
        if (title) titles.set(row.id, title);
      }
      return titles;
    } finally {
      database.close();
    }
  } catch {
    // Codex metadata is optional; unsupported runtimes and unreadable or
    // changing databases retain the transcript-derived title fallback.
    return new Map();
  }
};

const normalizedLimit = (value: number | undefined): number =>
  Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

const rootsFor = (env: NodeJS.ProcessEnv): RootSpec[] => {
  const home = homeDirectory(env);
  const configuredCodexRoots = env.MEMORY_CODEX_TRANSCRIPT_ROOTS?.split(
    path.delimiter
  )
    .map((root) => root.trim())
    .filter(Boolean);
  const codexHome = path.resolve(
    env.CODEX_HOME?.trim() || path.join(home, ".codex")
  );
  return [
    {
      provider: "codex",
      paths: configuredCodexRoots?.length
        ? configuredCodexRoots.map((root) => path.resolve(root))
        : [
            path.join(codexHome, "sessions"),
            path.join(codexHome, "archived_sessions")
          ],
      extensions: [".jsonl"]
    },
    {
      provider: "claude-code",
      paths: [
        path.join(
          path.resolve(
            env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude")
          ),
          "projects"
        )
      ],
      extensions: [".jsonl"]
    },
    {
      provider: "pi",
      paths: [
        ...(env.PI_CODING_AGENT_SESSION_DIR?.trim()
          ? [path.resolve(env.PI_CODING_AGENT_SESSION_DIR.trim())]
          : []),
        path.join(
          path.resolve(
            env.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent")
          ),
          "sessions"
        )
      ],
      extensions: [".jsonl"]
    }
  ];
};

const catalogScopeKey = (
  provider: Provider | undefined,
  env: NodeJS.ProcessEnv
): string => {
  const codexHome = path.resolve(
    env.CODEX_HOME?.trim() || path.join(homeDirectory(env), ".codex")
  );
  return hash(
    JSON.stringify({
      provider: provider ?? null,
      roots: rootsFor(env)
        .filter((root) => !provider || root.provider === provider)
        .map((root) => [root.provider, root.paths, root.extensions]),
      projectRegistryPath: resolveKoedServerPaths(env).projectMetadataPath,
      codexStatePath:
        !provider || provider === "codex"
          ? path.join(codexHome, "state_5.sqlite")
          : null
    })
  );
};

const rememberCatalogSnapshot = (
  key: string,
  snapshot: CatalogSnapshot
): void => {
  completedCatalogScans.delete(key);
  completedCatalogScans.set(key, {
    snapshot,
    expiresAt: Date.now() + CATALOG_CACHE_TTL_MS
  });
  while (completedCatalogScans.size > MAX_CATALOG_CACHE_SCOPES) {
    const oldestKey = completedCatalogScans.keys().next().value;
    if (oldestKey === undefined) break;
    completedCatalogScans.delete(oldestKey);
  }
};

const sourceId = (provider: Provider, externalId: string): string =>
  `${provider}:${encodeURIComponent(externalId)}`;

const isContainedPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const noFollowFlag =
  process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const openFlags = fsConstants.O_RDONLY | noFollowFlag;

const readContainedDirectory = async (
  directory: string,
  canonicalRoot: string
): Promise<Dirent[] | undefined> => {
  const beforeOpen = await lstat(directory);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isDirectory())
    return undefined;
  const resolvedBeforeOpen = await realpath(directory);
  if (!isContainedPath(canonicalRoot, resolvedBeforeOpen)) return undefined;
  const handle = await open(
    directory,
    openFlags | (fsConstants.O_DIRECTORY ?? 0)
  );
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isDirectory() ||
      !sameFileIdentity(beforeOpen, openedStats)
    )
      return undefined;
    const resolvedAfterOpen = await realpath(directory);
    if (
      resolvedAfterOpen !== resolvedBeforeOpen ||
      !isContainedPath(canonicalRoot, resolvedAfterOpen)
    )
      return undefined;
    const entries = await readdir(directory, { withFileTypes: true });
    const afterReadStats = await lstat(directory);
    const resolvedAfterRead = await realpath(directory);
    if (
      afterReadStats.isSymbolicLink() ||
      !sameFileIdentity(openedStats, afterReadStats) ||
      resolvedAfterRead !== resolvedBeforeOpen ||
      !isContainedPath(canonicalRoot, resolvedAfterRead)
    )
      return undefined;
    return entries;
  } finally {
    await handle.close();
  }
};

const readFirstRecord = async (
  filename: string,
  canonicalRoot: string,
  options: {
    maxRecords?: number;
    matches?: (record: Record<string, unknown>) => boolean;
  } = {}
): Promise<HeaderRecord | undefined> => {
  const beforeOpen = await lstat(filename);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) return undefined;
  const resolvedBeforeOpen = await realpath(filename);
  if (!isContainedPath(canonicalRoot, resolvedBeforeOpen)) return undefined;
  const handle = await open(filename, openFlags);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || !sameFileIdentity(beforeOpen, openedStats))
      return undefined;
    const resolvedAfterOpen = await realpath(filename);
    if (
      resolvedAfterOpen !== resolvedBeforeOpen ||
      !isContainedPath(canonicalRoot, resolvedAfterOpen)
    )
      return undefined;
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    let length = 0;
    let recordStart = 0;
    let recordsRead = 0;
    const maxRecords = options.maxRecords ?? 1;
    const matches = options.matches ?? (() => true);
    while (length < buffer.length) {
      const readLength = Math.min(
        HEADER_READ_CHUNK_BYTES,
        buffer.length - length
      );
      const { bytesRead } = await handle.read(
        buffer,
        length,
        readLength,
        length
      );
      if (bytesRead === 0) break;
      const availableLength = length + bytesRead;
      let newline = buffer.indexOf(0x0a, recordStart);
      while (newline >= 0 && newline < availableLength) {
        try {
          const parsed: unknown = JSON.parse(
            buffer.subarray(recordStart, newline).toString("utf8")
          );
          recordsRead += 1;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return undefined;
          const record = parsed as Record<string, unknown>;
          if (matches(record)) {
            const afterReadStats = await handle.stat();
            if (
              !sameFileIdentity(openedStats, afterReadStats) ||
              openedStats.size !== afterReadStats.size ||
              openedStats.mtimeMs !== afterReadStats.mtimeMs
            )
              return undefined;
            return { record, stats: afterReadStats };
          }
          if (recordsRead >= maxRecords) return undefined;
          recordStart = newline + 1;
          newline = buffer.indexOf(0x0a, recordStart);
        } catch {
          return undefined;
        }
      }
      length = availableLength;
    }
    return undefined;
  } finally {
    await handle.close();
  }
};

const stringField = (
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const normalizeTitle = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length > 100
    ? `${characters.slice(0, 99).join("").trimEnd()}…`
    : normalized;
};

const codexPromptText = (
  record: Record<string, unknown>
): string | undefined => {
  const payload =
    record.payload &&
    typeof record.payload === "object" &&
    !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : undefined;
  if (
    record.type === "event_msg" &&
    payload?.type === "user_message" &&
    typeof payload.message === "string"
  )
    return payload.message;

  const item =
    record.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "user"
      ? payload
      : undefined;
  if (!item) return undefined;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object" || Array.isArray(block))
        return "";
      const value = block as Record<string, unknown>;
      return value.type === "input_text" || value.type === "text"
        ? typeof value.text === "string"
          ? value.text
          : ""
        : "";
    })
    .filter(Boolean)
    .join(" ");
  return text || undefined;
};

const environmentContextOnly =
  /^(?:<environment_context\b[^>]*>[\s\S]*?<\/environment_context>\s*)+$/i;

const codexUserFacingPrompt = (message: string): string | undefined => {
  let text = message.replace(/\r\n?/g, "\n").trim();

  // Codex may prepend repository instructions and local runtime context to
  // the actual request. Skip these only when they form a recognized leading
  // wrapper, leaving ordinary user-authored text untouched.
  text = text.replace(
    /^(?:<recommended_plugins\b[^>]*>[\s\S]*?<\/recommended_plugins>\s*)+/i,
    ""
  );
  text = text.replace(
    /^#{0,6}\s*AGENTS\.md instructions for [^\n]+\n[\s\S]*?<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i,
    ""
  );
  text = text.replace(
    /^(?:<environment_context\b[^>]*>[\s\S]*?<\/environment_context>\s*)+/i,
    ""
  );
  text = text.trim();
  if (!text) return undefined;

  const lines = text.split("\n");
  let offset = 0;
  let contextStart: number | undefined;
  for (const line of lines) {
    if (/^#{0,6}\s*Context from my IDE setup:\s*$/i.test(line)) {
      const prefix = text.slice(0, offset).trim();
      if (!prefix || environmentContextOnly.test(prefix)) contextStart = offset;
      break;
    }
    offset += line.length + 1;
  }
  if (contextStart !== undefined) {
    const wrapped = text.slice(contextStart);
    const requestHeaders = [
      ...wrapped.matchAll(/^#{0,6}\s*My request for Codex:\s*$/gim)
    ];
    const requestHeader = requestHeaders.at(-1);
    const ideContext = requestHeader
      ? wrapped.slice(0, requestHeader.index).trim()
      : "";
    if (
      requestHeader &&
      /(^|\n)#{0,6}\s*(Active file|Open tabs|Selected text|Selected file):/im.test(
        ideContext
      )
    ) {
      const requestStart = requestHeader.index! + requestHeader[0].length;
      text = wrapped.slice(requestStart).trim();
    }
  }
  return text || undefined;
};

const fallbackTitle = (
  provider: Provider,
  externalId: string,
  activityAt: string
): string => {
  const providerLabel =
    provider === "claude-code"
      ? "Claude Code"
      : provider === "codex"
        ? "Codex"
        : "Pi";
  return `${providerLabel} conversation · ${activityAt.slice(0, 10)} · ${hash(
    sourceId(provider, externalId)
  ).slice(0, 7)}`;
};

const metadataFor = async (
  provider: Provider,
  filename: string,
  canonicalRoot: string,
  codexTitles: ReadonlyMap<string, string>
): Promise<
  | {
      externalId: string;
      title?: string;
      projectKey?: string;
      projectName?: string;
      repositoryUrl?: string;
      stats: Stats;
    }
  | undefined
> => {
  if (provider === "claude-code") {
    const id = path.basename(filename, ".jsonl");
    if (!CLAUDE_SESSION_ID.test(id)) return undefined;
    const header = await readFirstRecord(filename, canonicalRoot, {
      maxRecords: CLAUDE_IDENTITY_MAX_RECORDS,
      matches: (record) => stringField(record, "sessionId") === id
    });
    const metadata = header?.record;
    if (!header || stringField(metadata, "sessionId") !== id) return undefined;
    const rawCwd = stringField(metadata, "cwd");
    const cwd = rawCwd && path.isAbsolute(rawCwd) ? rawCwd : undefined;
    return {
      externalId: id,
      stats: header.stats,
      ...(cwd
        ? {
            projectKey: `cwd:${cwd}`,
            projectName: path.basename(cwd) || undefined
          }
        : {})
    };
  }

  if (provider === "pi") {
    const headerRecord = await readFirstRecord(filename, canonicalRoot);
    const header = headerRecord?.record;
    if (
      !headerRecord ||
      header?.type !== "session" ||
      header.version !== 3 ||
      typeof header.id !== "string" ||
      !header.id.trim()
    )
      return undefined;
    const rawCwd =
      typeof header.cwd === "string" && header.cwd.trim()
        ? header.cwd.trim()
        : undefined;
    const cwd = rawCwd && path.isAbsolute(rawCwd) ? rawCwd : undefined;
    return {
      externalId: header.id,
      stats: headerRecord.stats,
      title: normalizeTitle(stringField(header, "title")),
      ...(cwd
        ? {
            projectKey: `cwd:${cwd}`,
            projectName: path.basename(cwd) || "Project"
          }
        : {})
    };
  }

  const header = await readFirstRecord(filename, canonicalRoot);
  const envelope = header?.record;
  // Codex metadata is in a session_meta record. Inspect at most the first
  // bounded record, and never retain or return its arbitrary fields.
  const payload =
    envelope?.payload &&
    typeof envelope.payload === "object" &&
    !Array.isArray(envelope.payload)
      ? (envelope.payload as Record<string, unknown>)
      : envelope;
  if (
    !header ||
    (envelope?.type !== "session_meta" && payload?.type !== "session_meta")
  )
    return undefined;
  const id =
    stringField(payload, "id") ??
    stringField(envelope, "session_id") ??
    path.basename(filename, ".jsonl");
  if (!id) return undefined;
  const transcriptTitle = normalizeTitle(
    stringField(payload, "title") ?? stringField(payload, "name")
  );
  let title = transcriptTitle;
  if (!title) {
    const prompt = await readFirstRecord(filename, canonicalRoot, {
      maxRecords: 100,
      matches: (record) => {
        const text = codexPromptText(record);
        return Boolean(text && codexUserFacingPrompt(text));
      }
    });
    const promptText = prompt ? codexPromptText(prompt.record) : undefined;
    title = normalizeTitle(
      promptText ? codexUserFacingPrompt(promptText) : undefined
    );
  }
  title = codexTitles.get(id) ?? title;
  const rawCwd = stringField(payload, "cwd");
  const cwd = rawCwd && path.isAbsolute(rawCwd) ? rawCwd : undefined;
  const git =
    payload?.git &&
    typeof payload.git === "object" &&
    !Array.isArray(payload.git)
      ? (payload.git as Record<string, unknown>)
      : undefined;
  const repositoryUrl = stringField(git, "repository_url");
  return {
    externalId: id,
    stats: header.stats,
    title,
    ...(repositoryUrl ? { repositoryUrl: repositoryUrl.slice(0, 2_048) } : {}),
    ...(cwd
      ? {
          projectKey: `cwd:${cwd}`,
          projectName: path.basename(cwd) || "Project"
        }
      : {})
  };
};

const makeCursor = (candidate: LocalConversationSource): string =>
  Buffer.from(
    JSON.stringify({
      activityAt: candidate.activityAt,
      sourceId: candidate.sourceId,
      version: 1
    } satisfies Cursor)
  ).toString("base64url");

const parseCursor = (value: string | undefined): Cursor | undefined => {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Cursor).version === 1 &&
      typeof (parsed as Cursor).activityAt === "string" &&
      Number.isFinite(Date.parse((parsed as Cursor).activityAt)) &&
      typeof (parsed as Cursor).sourceId === "string"
    )
      return parsed as Cursor;
  } catch {
    /* invalid cursor is reported by caller */
  }
  throw new Error("local_conversation_cursor_invalid");
};

const compareRecent = (
  left: LocalConversationSource,
  right: LocalConversationSource
): number =>
  right.activityAt.localeCompare(left.activityAt) ||
  left.sourceId.localeCompare(right.sourceId);

const isAfterCursor = (
  item: LocalConversationSource,
  cursor: Cursor
): boolean =>
  item.activityAt < cursor.activityAt ||
  (item.activityAt === cursor.activityAt && item.sourceId > cursor.sourceId);

/**
 * Discover locally stored Codex, Claude Code, and Pi session summaries.
 * Discovery is bounded per invocation (50k directory entries / 20k files),
 * follows no symlinks, reads bounded identity and early display-title records,
 * and never performs Koed ingestion. Cursor pages are recent-first with no age filter.
 */
const scanLocalConversationCatalog = async (
  options: Pick<ListLocalConversationSourcesOptions, "provider" | "env">
): Promise<CatalogSnapshot> => {
  const env = options.env ?? process.env;
  const registeredProjects = await readRegisteredProjectIdentities(env);
  const codexTitles =
    !options.provider || options.provider === "codex"
      ? await readCodexThreadTitles(env)
      : new Map<string, string>();
  const statuses: LocalConversationCatalogPage["providers"] = {
    codex: { status: "unavailable", code: "source_root_missing" },
    "claude-code": { status: "unavailable", code: "source_root_missing" },
    pi: { status: "unavailable", code: "source_root_missing" }
  };
  const candidates: Candidate[] = [];
  let visitedEntries = 0;
  let discoveredFiles = 0;
  let truncated = false;

  const rootSpecs = rootsFor(env);
  if (options.provider) {
    for (const rootSpec of rootSpecs) {
      if (rootSpec.provider !== options.provider)
        statuses[rootSpec.provider] = { status: "not_requested" };
    }
  }
  for (const rootSpec of rootSpecs.filter(
    (value) => !options.provider || value.provider === options.provider
  )) {
    if (
      visitedEntries >= MAX_DISCOVERED_ENTRIES ||
      discoveredFiles >= MAX_DISCOVERED_FILES
    ) {
      truncated = true;
      statuses[rootSpec.provider] = {
        status: "limited",
        code: "discovery_limit_reached"
      };
      continue;
    }
    for (const root of [...new Set(rootSpec.paths)]) {
      let rootStat;
      try {
        rootStat = await lstat(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        statuses[rootSpec.provider] = {
          status: "invalid",
          code: "source_root_invalid"
        };
        continue;
      }
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        statuses[rootSpec.provider] = {
          status: "invalid",
          code: "source_root_invalid"
        };
        continue;
      }
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
        const canonicalRootStats = await lstat(canonicalRoot);
        if (
          canonicalRootStats.isSymbolicLink() ||
          !canonicalRootStats.isDirectory() ||
          !sameFileIdentity(rootStat, canonicalRootStats)
        )
          throw new Error("local_source_root_changed");
      } catch {
        statuses[rootSpec.provider] = {
          status: "invalid",
          code: "source_root_invalid"
        };
        continue;
      }
      if (statuses[rootSpec.provider].status === "unavailable")
        statuses[rootSpec.provider] = { status: "available" };
      const directories: Array<{
        path: string;
        depth: number;
        priority: number;
      }> = [{ path: root, depth: 0, priority: rootStat.mtimeMs }];
      while (directories.length) {
        if (
          visitedEntries >= MAX_DISCOVERED_ENTRIES ||
          discoveredFiles >= MAX_DISCOVERED_FILES
        ) {
          truncated = true;
          statuses[rootSpec.provider] = {
            status: "limited",
            code: "discovery_limit_reached"
          };
          break;
        }
        directories.sort(
          (left, right) =>
            right.priority - left.priority ||
            right.path.localeCompare(left.path)
        );
        const directory = directories.shift()!;
        let entries;
        try {
          entries = await readContainedDirectory(directory.path, canonicalRoot);
        } catch {
          statuses[rootSpec.provider] = {
            status: "partial",
            code: "source_identity_invalid"
          };
          continue;
        }
        if (!entries) {
          statuses[rootSpec.provider] = {
            status: "partial",
            code: "source_identity_invalid"
          };
          continue;
        }
        // Newer names first helps Codex's timestamped YYYY/MM/DD tree when
        // the directory itself contains more entries than the scan budget.
        entries.sort((left, right) => right.name.localeCompare(left.name));
        const rankedEntries: Array<{
          entry: (typeof entries)[number];
          target: string;
          modifiedAt: number;
          kind: "directory" | "file" | "other";
        }> = [];
        for (const entry of entries) {
          visitedEntries += 1;
          if (visitedEntries > MAX_DISCOVERED_ENTRIES) {
            truncated = true;
            break;
          }
          if (entry.isSymbolicLink()) {
            statuses[rootSpec.provider] = {
              status: "partial",
              code: "source_identity_invalid"
            };
            continue;
          }
          const target = path.join(directory.path, entry.name);
          try {
            const details = await lstat(target);
            if (details.isSymbolicLink()) {
              statuses[rootSpec.provider] = {
                status: "partial",
                code: "source_identity_invalid"
              };
              continue;
            }
            const kind = details.isDirectory()
              ? "directory"
              : details.isFile() &&
                  rootSpec.extensions.some((extension) =>
                    entry.name.endsWith(extension)
                  )
                ? "file"
                : "other";
            rankedEntries.push({
              entry,
              target,
              modifiedAt: details.mtimeMs,
              kind
            });
          } catch {
            // Concurrently removed or inaccessible entries are skipped.
          }
        }
        rankedEntries.sort(
          (left, right) =>
            right.modifiedAt - left.modifiedAt ||
            right.entry.name.localeCompare(left.entry.name)
        );
        for (const ranked of rankedEntries) {
          if (ranked.kind === "directory") {
            if (directory.depth < 12)
              directories.push({
                path: ranked.target,
                depth: directory.depth + 1,
                priority: ranked.modifiedAt
              });
            continue;
          }
          if (ranked.kind !== "file") continue;
          if (discoveredFiles >= MAX_DISCOVERED_FILES) {
            truncated = true;
            statuses[rootSpec.provider] = {
              status: "limited",
              code: "discovery_limit_reached"
            };
            break;
          }
          discoveredFiles += 1;
          try {
            const identity = await metadataFor(
              rootSpec.provider,
              ranked.target,
              canonicalRoot,
              codexTitles
            );
            if (!identity) {
              statuses[rootSpec.provider] = {
                status: "partial",
                code: "source_identity_invalid"
              };
              continue;
            }
            const details = identity.stats;
            if (!Number.isFinite(details.mtimeMs)) continue;
            const sourceCwd = identity.projectKey?.startsWith("cwd:")
              ? identity.projectKey.slice("cwd:".length)
              : undefined;
            const activityAt = details.mtime.toISOString();
            candidates.push({
              sourceId: sourceId(rootSpec.provider, identity.externalId),
              provider: rootSpec.provider,
              title:
                normalizeTitle(identity.title) ??
                fallbackTitle(
                  rootSpec.provider,
                  identity.externalId,
                  activityAt
                ),
              activityAt,
              ...(identity.projectName
                ? { projectName: identity.projectName.slice(0, 100) }
                : {}),
              ...(sourceCwd ? { privateCwd: sourceCwd } : {}),
              ...(identity.repositoryUrl
                ? { privateRepositoryUrl: identity.repositoryUrl }
                : {}),
              privatePath: ranked.target
            });
          } catch {
            statuses[rootSpec.provider] = {
              status: "partial",
              code: "source_identity_invalid"
            };
          }
        }
        if (truncated) break;
      }
    }
  }

  const codexHome = path.resolve(
    env.CODEX_HOME?.trim() || path.join(homeDirectory(env), ".codex")
  );
  const trustedCodexWorktree = (cwd: string): boolean => {
    const relative = path.relative(path.join(codexHome, "worktrees"), cwd);
    const parts = relative.split(path.sep);
    return (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative) &&
      parts.length === 2 &&
      /^[a-z0-9_-]{1,64}$/i.test(parts[0]!) &&
      parts[1] !== "." &&
      parts[1] !== ".."
    );
  };
  const cwdInfo = new Map<
    string,
    { canonicalPath: string; git?: LocalGitIdentity }
  >();
  for (const cwd of new Set([
    ...candidates.flatMap((candidate) =>
      candidate.privateCwd ? [candidate.privateCwd] : []
    ),
    ...registeredProjects.keys()
  ])) {
    const normalized = normalizedAbsolutePath(cwd);
    const git = await readLocalGitIdentity(cwd);
    cwdInfo.set(normalized, {
      canonicalPath: await canonicalProjectPath(cwd),
      ...(git ? { git } : {})
    });
  }

  // Archived Codex sessions retain the old worktree cwd after Codex deletes
  // that checkout. Its repository URL can alias it to one unambiguous live
  // checkout with the same origin and worktree name. The special directory
  // layout and origin proof prevent basename-only merging.
  const codexRepositoryUrlsByProjectRoot = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.provider !== "codex" || !candidate.privateRepositoryUrl)
      continue;
    const info = candidate.privateCwd
      ? cwdInfo.get(normalizedAbsolutePath(candidate.privateCwd))
      : undefined;
    const projectRoot = info?.git?.projectRoot;
    if (!projectRoot) continue;
    const urls = codexRepositoryUrlsByProjectRoot.get(projectRoot) ?? new Set();
    urls.add(candidate.privateRepositoryUrl);
    codexRepositoryUrlsByProjectRoot.set(projectRoot, urls);
  }
  for (const info of cwdInfo.values()) {
    if (!info.git?.projectRoot || !info.git.originUrl) continue;
    const urls =
      codexRepositoryUrlsByProjectRoot.get(info.git.projectRoot) ?? new Set();
    urls.add(info.git.originUrl);
    codexRepositoryUrlsByProjectRoot.set(info.git.projectRoot, urls);
  }
  const archivedWorktreeAliases = new Map<string, string>();
  for (const candidate of candidates) {
    const cwd = candidate.privateCwd;
    const originUrl = candidate.privateRepositoryUrl;
    if (
      candidate.provider !== "codex" ||
      !cwd ||
      !originUrl ||
      !trustedCodexWorktree(normalizedAbsolutePath(cwd))
    )
      continue;
    const info = cwdInfo.get(normalizedAbsolutePath(cwd));
    if (info?.git) continue;
    const matchingProjectRoots = new Set<string>();
    for (const [
      projectRoot,
      repositoryUrls
    ] of codexRepositoryUrlsByProjectRoot) {
      if (
        repositoryUrls.has(originUrl) &&
        path.basename(projectRoot) === path.basename(cwd)
      )
        matchingProjectRoots.add(projectRoot);
    }
    if (matchingProjectRoots.size === 1)
      archivedWorktreeAliases.set(
        normalizedAbsolutePath(cwd),
        [...matchingProjectRoots][0]!
      );
  }

  for (const candidate of candidates) {
    const cwd = candidate.privateCwd;
    if (!cwd) continue;
    const normalized = normalizedAbsolutePath(cwd);
    const info = cwdInfo.get(normalized);
    const canonicalPath =
      info?.canonicalPath ?? (await canonicalProjectPath(cwd));
    const projectRoot =
      info?.git?.projectRoot ?? archivedWorktreeAliases.get(normalized);
    const registeredProject =
      registeredProjects.get(canonicalPath) ??
      (projectRoot ? registeredProjects.get(projectRoot) : undefined);
    const projectIdentity = `cwd:${projectRoot ?? canonicalPath}`;
    candidate.projectId =
      registeredProject?.localProjectId ??
      `local-project:${hash(projectIdentity)}`;
    if (registeredProject)
      candidate.projectName = registeredProject.displayName.slice(0, 100);
  }

  const candidatesBySourceId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = candidatesBySourceId.get(candidate.sourceId);
    if (
      !existing ||
      candidate.activityAt > existing.activityAt ||
      (candidate.activityAt === existing.activityAt &&
        candidate.privatePath.localeCompare(existing.privatePath) < 0)
    )
      candidatesBySourceId.set(candidate.sourceId, candidate);
  }
  const uniqueCandidates = [...candidatesBySourceId.values()];
  uniqueCandidates.sort(compareRecent);
  const items = uniqueCandidates.map(
    ({ sourceId, provider, title, activityAt, projectId, projectName }) => ({
      sourceId,
      provider,
      title,
      activityAt,
      ...(projectId === undefined ? {} : { projectId }),
      ...(projectName === undefined ? {} : { projectName })
    })
  );
  return { items, providers: statuses, truncated };
};

const getCatalogSnapshot = async (
  options: Pick<
    ListLocalConversationSourcesOptions,
    "provider" | "env" | "refresh"
  >
): Promise<CatalogSnapshot> => {
  const env = options.env ?? process.env;
  const key = catalogScopeKey(options.provider, env);
  const pending = inFlightCatalogScans.get(key);
  if (pending) return pending;

  const cached = completedCatalogScans.get(key);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) {
    completedCatalogScans.delete(key);
    completedCatalogScans.set(key, cached);
    return cached.snapshot;
  }

  let scan: Promise<CatalogSnapshot>;
  scan = Promise.resolve()
    .then(() =>
      scanLocalConversationCatalog({ provider: options.provider, env })
    )
    .then((snapshot) => {
      rememberCatalogSnapshot(key, snapshot);
      return snapshot;
    })
    .finally(() => {
      if (inFlightCatalogScans.get(key) === scan)
        inFlightCatalogScans.delete(key);
    });
  inFlightCatalogScans.set(key, scan);
  return scan;
};

export const listLocalConversationSources = async (
  options: ListLocalConversationSourcesOptions = {}
): Promise<LocalConversationCatalogPage> => {
  const cursor = parseCursor(options.cursor);
  const limit = normalizedLimit(options.limit);
  const snapshot = await getCatalogSnapshot(options);
  const ordered = snapshot.items.filter(
    (item) => !cursor || isAfterCursor(item, cursor)
  );
  const selected = ordered.slice(0, limit);
  // A cursor advances only through sources actually discovered. If the scan
  // is truncated after those sources are exhausted, return no cursor and let
  // `truncated` tell the caller that coverage is incomplete.
  const hasMore = ordered.length > selected.length;
  return {
    items: selected.map((item) => ({ ...item })),
    nextCursor:
      hasMore && selected.length > 0
        ? makeCursor(selected[selected.length - 1]!)
        : null,
    providers: {
      codex: { ...snapshot.providers.codex },
      "claude-code": { ...snapshot.providers["claude-code"] },
      pi: { ...snapshot.providers.pi }
    },
    truncated: snapshot.truncated
  };
};
