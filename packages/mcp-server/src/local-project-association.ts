import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import properLockfile from "proper-lockfile";
import {
  createDbPool,
  createProjectRepository,
  type VerifiedLocalProjectContext
} from "@koed/db";
import {
  deriveLocalProjectId,
  hmacProjectValue,
  inspectDeviceIdentityAtKoedHome,
  readDesktopLocalCredentialAuthorization,
  type ProjectMetadataV1
} from "@koed/shared";
import { logger } from "./logger.js";

interface LocalRecord extends Omit<
  VerifiedLocalProjectContext,
  "sessionId" | "artifactId" | "minimumProviderCursorOffset"
> {
  sessionId?: string;
  artifactId?: string;
  requiredSourceOffset: number;
  acceptedProviderCursorOffset?: number;
  gitDir: string | null;
  commonDir: string | null;
  gitDirIdentity: string | null;
  folderIdentity: string | null;
  folder: string;
  remoteFingerprints: string[];
  projectId?: string | null;
  confirmationId?: string;
  confirmationVersion?: number;
  confirmationFactsKey?: string;
  requiresConfirmation?: boolean;
  createdAt: string;
}

interface LocalState {
  version: 1;
  history: LocalRecord[];
  pending: LocalRecord[];
  completed: Array<{
    ownerUserId: string;
    deviceId: string;
    sourceKind: VerifiedLocalProjectContext["sourceKind"];
    externalSessionId: string;
    localProjectId: string;
    artifactId: string;
    providerCursorOffset: number;
  }>;
}

export interface LocalProjectAssociationService {
  prepare(input: {
    sourceKind: VerifiedLocalProjectContext["sourceKind"];
    externalSessionId: string;
    sourceProjectPath: string | undefined;
    localProjectId: string | undefined;
    requiredSourceOffset: number;
  }): Promise<boolean>;
  complete(
    sourceKind: VerifiedLocalProjectContext["sourceKind"],
    externalSessionId: string,
    artifact: {
      id: string;
      sessionId: string;
      externalSessionId: string;
      providerCursorOffset: number;
    }
  ): Promise<void>;
  discardBlocked(
    sourceKind: VerifiedLocalProjectContext["sourceKind"],
    externalSessionId: string
  ): Promise<void>;
  replay(): Promise<void>;
  isCompleted(input: {
    sourceKind: VerifiedLocalProjectContext["sourceKind"];
    externalSessionId: string;
    localProjectId: string;
    artifactId: string;
    providerCursorOffset: number;
  }): boolean;
  confirm(input: {
    localProjectId: string;
    choice: { projectId: string } | { separate: true };
  }): Promise<void>;
  close(): Promise<void>;
}

const localUrl = (raw: string | undefined): boolean => {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
};

const git = async (cwd: string, args: string[]): Promise<string | null> =>
  await new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 5_000 },
      (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      }
    );
  });

const emptyState = (): LocalState => ({
  version: 1,
  history: [],
  pending: [],
  completed: []
});

const confirmationFactsKey = (
  row: Pick<
    LocalRecord,
    | "localProjectId"
    | "folderHash"
    | "gitDirHash"
    | "commonDirHash"
    | "gitDirIdentity"
    | "folderIdentity"
  >
): string =>
  JSON.stringify([
    row.localProjectId,
    row.folderHash,
    row.gitDirHash,
    row.commonDirHash,
    row.gitDirIdentity,
    row.folderIdentity
  ]);

const readState = (file: string): LocalState => {
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LocalState>;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.history) ||
    !Array.isArray(parsed.pending)
  ) {
    throw new Error("Local Project association state is malformed");
  }
  return {
    ...parsed,
    completed: Array.isArray(parsed.completed) ? parsed.completed : []
  } as LocalState;
};

const writeState = (file: string, state: LocalState): void => {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  const directoryDescriptor = openSync(directory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
};

const catalogProject = (
  koedHome: string,
  sourceProjectPath: string | undefined,
  localProjectId: string | undefined
): { salt: string; project: ProjectMetadataV1 } | null => {
  if (!sourceProjectPath || !localProjectId) return null;
  let catalog: { deviceSaltId?: unknown; projects?: unknown };
  try {
    catalog = JSON.parse(
      readFileSync(path.join(koedHome, "config", "projects.json"), "utf8")
    ) as typeof catalog;
  } catch {
    return null;
  }
  if (
    typeof catalog.deviceSaltId !== "string" ||
    !Array.isArray(catalog.projects)
  )
    return null;
  const normalized = path.resolve(sourceProjectPath);
  const matches = catalog.projects.filter(
    (candidate): candidate is ProjectMetadataV1 => {
      if (!candidate || typeof candidate !== "object") return false;
      const project = candidate as Partial<ProjectMetadataV1>;
      return (
        project.localProjectId === localProjectId &&
        typeof project.path?.cwd === "string" &&
        (path.resolve(project.path.cwd) === normalized ||
          (typeof project.path.projectRoot === "string" &&
            path.resolve(project.path.projectRoot) === normalized))
      );
    }
  );
  return matches.length === 1
    ? { salt: catalog.deviceSaltId, project: matches[0]! }
    : null;
};

const checkoutFacts = async (
  catalog: { salt: string; project: ProjectMetadataV1 },
  history: LocalRecord[]
): Promise<Omit<
  LocalRecord,
  | "ownerUserId"
  | "deviceId"
  | "sourceKind"
  | "externalSessionId"
  | "createdAt"
  | "requiredSourceOffset"
> | null> => {
  const catalogFolder = path.resolve(
    catalog.project.path.projectRoot ?? catalog.project.path.cwd
  );
  let folder: string;
  let folderIdentity: string | null;
  try {
    folder = realpathSync(catalogFolder);
    const folderStat = statSync(folder);
    if (!folderStat.isDirectory()) return null;
    folderIdentity =
      folderStat.dev > 0 && folderStat.ino > 0
        ? `${folderStat.dev}:${folderStat.ino}`
        : null;
  } catch {
    return null;
  }
  const [rootValue, gitDirValue, commonDirValue, worktreesValue] =
    await Promise.all([
      git(folder, ["rev-parse", "--show-toplevel"]),
      git(folder, ["rev-parse", "--git-dir"]),
      git(folder, ["rev-parse", "--git-common-dir"]),
      git(folder, ["worktree", "list", "--porcelain"])
    ]);
  const root = rootValue ? path.resolve(rootValue) : null;
  if (!root || !gitDirValue || !commonDirValue || !worktreesValue) {
    if (catalog.project.git) return null;
    const derivedId = deriveLocalProjectId({
      salt: catalog.salt,
      cwd: catalogFolder
    });
    if (derivedId !== catalog.project.localProjectId) return null;
    return {
      localProjectId: derivedId,
      displayName: catalog.project.displayName,
      commonDirHash: null,
      gitDirHash: null,
      folderHash: hmacProjectValue(catalog.salt, catalogFolder),
      gitDir: null,
      commonDir: null,
      gitDirIdentity: null,
      folderIdentity,
      folder: catalogFolder,
      remoteFingerprints: [],
      verifiedNewLinkedCheckout: false,
      hasRemoteCandidate: false,
      hasMovedCheckoutCandidate: false
    };
  }
  if (root !== folder) return null;
  const gitDir = path.resolve(folder, gitDirValue);
  const commonDir = path.resolve(folder, commonDirValue);
  let gitDirIdentity: string | null = null;
  try {
    const identity = statSync(gitDir);
    if (identity.dev > 0 && identity.ino > 0)
      gitDirIdentity = `${identity.dev}:${identity.ino}`;
  } catch {
    return null;
  }
  const memberFolders = new Set(
    worktreesValue
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice(9)))
  );
  const isMainCheckout =
    gitDir === path.join(folder, ".git") && commonDir === gitDir;
  if (!memberFolders.has(folder) && !isMainCheckout) return null;
  const derivedId = deriveLocalProjectId({
    salt: catalog.salt,
    projectRoot: root,
    cwd: root
  });
  if (derivedId !== catalog.project.localProjectId) return null;
  const groupHistory = history.filter(
    (row) => row.commonDir === commonDir && row.gitDir && row.projectId
  );
  const knownCheckout = groupHistory.some((row) => row.gitDir === gitDir);
  const eligible = groupHistory.filter(
    (row) =>
      row.gitDir !== gitDir &&
      memberFolders.has(row.folder) &&
      row.folder !== folder
  );
  const uniqueProjects = new Set(eligible.map((row) => row.projectId));
  const remoteFingerprints = (catalog.project.git?.remoteAliases ?? [])
    .map((remote) => remote.fingerprint)
    .filter((fingerprint) => typeof fingerprint === "string");
  const hasRemoteCandidate = history.some(
    (row) =>
      row.commonDir !== commonDir &&
      row.remoteFingerprints?.some((fingerprint) =>
        remoteFingerprints.includes(fingerprint)
      )
  );
  const hasMovedCheckoutCandidate = Boolean(
    gitDirIdentity &&
    history.some(
      (row) => row.gitDirIdentity === gitDirIdentity && row.folder !== folder
    )
  );
  return {
    localProjectId: derivedId,
    displayName: catalog.project.displayName,
    commonDirHash: hmacProjectValue(catalog.salt, commonDir),
    gitDirHash: hmacProjectValue(catalog.salt, gitDir),
    folderHash: hmacProjectValue(catalog.salt, folder),
    gitDir,
    commonDir,
    gitDirIdentity,
    folderIdentity,
    folder,
    remoteFingerprints,
    verifiedNewLinkedCheckout:
      !knownCheckout && uniqueProjects.size === 1 && eligible.length > 0,
    hasRemoteCandidate,
    hasMovedCheckoutCandidate
  };
};

export const createLocalProjectAssociationService = (input: {
  koedHome: string;
  captureClient: { apiUrl: string; apiToken: string | undefined } | null;
  environment?: NodeJS.ProcessEnv;
}): LocalProjectAssociationService | null => {
  const environment = input.environment ?? process.env;
  if (
    environment.KOED_RUNTIME_MODE !== "local-personal" ||
    !localUrl(environment.MEMORY_API_URL) ||
    !localUrl(environment.DATABASE_URL) ||
    !input.captureClient ||
    !environment.MEMORY_API_TOKEN ||
    input.captureClient.apiToken !== environment.MEMORY_API_TOKEN ||
    input.captureClient.apiUrl.replace(/\/+$/, "") !==
      environment.MEMORY_API_URL?.replace(/\/+$/, "") ||
    path.resolve(environment.KOED_HOME ?? "") !== path.resolve(input.koedHome)
  )
    return null;
  const owner = readDesktopLocalCredentialAuthorization(input.koedHome);
  const device = inspectDeviceIdentityAtKoedHome({
    koedHome: input.koedHome,
    environment
  });
  if (
    !owner?.ownerUserId ||
    device.health !== "healthy" ||
    !device.deviceInstanceId
  )
    return null;
  const ownerUserId = owner.ownerUserId;
  const deviceId = device.deviceInstanceId;
  const stateFile = path.join(
    input.koedHome,
    "config",
    "project-associations.json"
  );
  const lockTarget = path.join(
    input.koedHome,
    "config",
    "project-associations-lock"
  );
  const pool = createDbPool({
    connectionString: environment.DATABASE_URL,
    connectionTimeoutMillis: 1_500,
    queryTimeoutMillis: 3_000
  });
  const repository = createProjectRepository(pool);
  const ownedHistory = (state: LocalState): LocalRecord[] =>
    state.history.filter(
      (row) => row.ownerUserId === ownerUserId && row.deviceId === deviceId
    );
  let queue: Promise<unknown> = Promise.resolve();
  const withStateLock = async <T>(work: () => T | Promise<T>): Promise<T> => {
    mkdirSync(path.dirname(lockTarget), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(lockTarget, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
      )
        throw error;
    }
    const release = await properLockfile.lock(lockTarget, {
      realpath: false,
      stale: 120_000,
      update: 30_000,
      retries: {
        retries: 100,
        factor: 1,
        minTimeout: 25,
        maxTimeout: 100,
        randomize: true
      }
    });
    try {
      return await work();
    } finally {
      await release();
    }
  };
  const serialized = <T>(work: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(
      () => withStateLock(work),
      () => withStateLock(work)
    );
    queue = next.catch(() => undefined);
    return next;
  };
  let replayPromise: Promise<void> | null = null;
  let lastAmbiguousOverrideCount = 0;
  const replay = (): Promise<void> => {
    if (replayPromise) return replayPromise;
    replayPromise = (async () => {
      // Keep each pass bounded. Rotate unresolved work so a blocked capture or
      // unavailable Project does not starve newer, accepted captures.
      const candidates = await serialized(() =>
        readState(stateFile)
          .pending.filter(
            (row) =>
              row.ownerUserId === ownerUserId &&
              row.deviceId === deviceId &&
              Boolean(row.sessionId && row.artifactId)
          )
          .slice(0, 8)
      );
      for (const pending of candidates) {
        try {
          const history = await serialized(() =>
            ownedHistory(readState(stateFile))
          );
          const catalog = catalogProject(
            input.koedHome,
            pending.folder,
            pending.localProjectId
          );
          const refreshed = catalog
            ? await checkoutFacts(catalog, history)
            : null;
          // Capture-time facts remain valid for this captured session even if
          // the checkout has since moved or disappeared.
          const facts = refreshed ?? pending;
          const choiceMatchesFacts = Boolean(
            pending.confirmationId &&
            refreshed &&
            pending.confirmationFactsKey === confirmationFactsKey(refreshed)
          );
          const staleChoice = Boolean(
            pending.confirmationId && !choiceMatchesFacts
          );
          if (staleChoice) {
            await serialized(() => {
              const state = readState(stateFile);
              const current = state.pending.find(
                (row) =>
                  row.ownerUserId === ownerUserId &&
                  row.deviceId === deviceId &&
                  row.sourceKind === pending.sourceKind &&
                  row.externalSessionId === pending.externalSessionId
              );
              if (!current || current.confirmationId !== pending.confirmationId)
                return;
              if (refreshed) Object.assign(current, refreshed);
              current.requiresConfirmation = true;
              delete current.confirmationId;
              delete current.confirmationFactsKey;
              delete current.confirmedProjectId;
              delete current.confirmedSeparate;
              const historyRow = state.history.find(
                (row) =>
                  row.ownerUserId === ownerUserId &&
                  row.deviceId === deviceId &&
                  row.localProjectId === pending.localProjectId &&
                  row.confirmationId === pending.confirmationId
              );
              if (historyRow) {
                if (refreshed) Object.assign(historyRow, refreshed);
                historyRow.requiresConfirmation = true;
                delete historyRow.confirmationId;
                delete historyRow.confirmationFactsKey;
                delete historyRow.confirmedProjectId;
                delete historyRow.confirmedSeparate;
              }
              writeState(stateFile, state);
            });
          }
          const requiresConfirmation = Boolean(
            pending.requiresConfirmation || staleChoice
          );
          const result = await repository.associateVerifiedCapturedSession({
            sourceKind: pending.sourceKind,
            ownerUserId,
            deviceId,
            externalSessionId: pending.externalSessionId,
            localProjectId: pending.localProjectId,
            displayName: facts.displayName,
            commonDirHash: facts.commonDirHash,
            gitDirHash: facts.gitDirHash,
            folderHash: facts.folderHash,
            verifiedNewLinkedCheckout: facts.verifiedNewLinkedCheckout,
            hasRemoteCandidate: facts.hasRemoteCandidate,
            hasMovedCheckoutCandidate: facts.hasMovedCheckoutCandidate,
            ...(requiresConfirmation ? { requiresConfirmation: true } : {}),
            ...(!requiresConfirmation && pending.confirmedProjectId
              ? { confirmedProjectId: pending.confirmedProjectId }
              : {}),
            ...(!requiresConfirmation && pending.confirmedSeparate
              ? { confirmedSeparate: true }
              : {}),
            ...(!requiresConfirmation && pending.confirmationId
              ? { confirmationVersion: pending.confirmationVersion }
              : {}),
            sessionId: pending.sessionId!,
            artifactId: pending.artifactId!,
            minimumProviderCursorOffset: pending.requiredSourceOffset
          });
          if (result.state === "resolved") {
            const backfill =
              await repository.backfillLegacyProjectOverrides(ownerUserId);
            if (
              backfill.ambiguous > 0 &&
              backfill.ambiguous !== lastAmbiguousOverrideCount
            ) {
              logger.warn(
                {
                  code: "personal_project_legacy_override_ambiguous",
                  ambiguousCount: Math.min(backfill.ambiguous, 1_000),
                  countCapped: backfill.ambiguous > 1_000
                },
                "Ambiguous legacy Project overrides require review"
              );
            }
            lastAmbiguousOverrideCount = backfill.ambiguous;
            await serialized(() => {
              const state = readState(stateFile);
              const current = state.pending.find(
                (row) =>
                  row.ownerUserId === ownerUserId &&
                  row.deviceId === deviceId &&
                  row.sourceKind === pending.sourceKind &&
                  row.externalSessionId === pending.externalSessionId
              );
              const sameAttempt =
                current?.confirmationId === pending.confirmationId &&
                current?.artifactId === pending.artifactId &&
                current?.sessionId === pending.sessionId &&
                current?.requiredSourceOffset ===
                  pending.requiredSourceOffset &&
                current?.acceptedProviderCursorOffset ===
                  pending.acceptedProviderCursorOffset;
              if (
                sameAttempt &&
                result.sessionAssigned &&
                current?.artifactId &&
                current.acceptedProviderCursorOffset !== undefined
              ) {
                state.completed = state.completed.filter(
                  (row) =>
                    row.ownerUserId !== ownerUserId ||
                    row.deviceId !== deviceId ||
                    row.sourceKind !== pending.sourceKind ||
                    row.externalSessionId !== pending.externalSessionId
                );
                state.completed.push({
                  ownerUserId,
                  deviceId,
                  sourceKind: pending.sourceKind,
                  externalSessionId: pending.externalSessionId,
                  localProjectId: pending.localProjectId,
                  artifactId: current.artifactId,
                  providerCursorOffset: current.acceptedProviderCursorOffset
                });
              }
              if (sameAttempt)
                state.pending = state.pending.filter((row) => row !== current);
              if (pending.confirmationId) {
                for (const row of state.pending) {
                  if (
                    row.ownerUserId !== ownerUserId ||
                    row.deviceId !== deviceId ||
                    row.localProjectId !== pending.localProjectId ||
                    row.confirmationId !== pending.confirmationId
                  )
                    continue;
                  delete row.confirmationId;
                  delete row.confirmationFactsKey;
                  delete row.confirmedProjectId;
                  delete row.confirmedSeparate;
                }
              }
              const context = state.history.find(
                (row) =>
                  row.ownerUserId === ownerUserId &&
                  row.deviceId === deviceId &&
                  row.localProjectId === pending.localProjectId
              );
              if (
                context &&
                (!context.confirmationId ||
                  context.confirmationId === pending.confirmationId)
              ) {
                context.projectId = result.projectId;
                if (
                  context.confirmationId &&
                  context.confirmationId === pending.confirmationId
                ) {
                  delete context.confirmationId;
                  delete context.confirmationFactsKey;
                  delete context.confirmedProjectId;
                  delete context.confirmedSeparate;
                }
              }
              writeState(stateFile, state);
            });
          } else {
            await serialized(() => {
              const state = readState(stateFile);
              const index = state.pending.findIndex(
                (row) =>
                  row.ownerUserId === ownerUserId &&
                  row.deviceId === deviceId &&
                  row.sourceKind === pending.sourceKind &&
                  row.externalSessionId === pending.externalSessionId
              );
              if (index < 0) return;
              state.pending.push(state.pending.splice(index, 1)[0]!);
              writeState(stateFile, state);
            });
          }
        } catch {
          logger.warn(
            { code: "local_project_association_retry_pending" },
            "Local Project association will retry on the next watcher pass"
          );
        }
      }
    })().finally(() => {
      replayPromise = null;
    });
    return replayPromise;
  };
  return {
    isCompleted: (candidate) => {
      const state = readState(stateFile);
      if (
        state.pending.some(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.deviceId === deviceId &&
            row.sourceKind === candidate.sourceKind &&
            row.externalSessionId === candidate.externalSessionId
        )
      )
        return false;
      return state.completed.some(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.deviceId === deviceId &&
          row.sourceKind === candidate.sourceKind &&
          row.externalSessionId === candidate.externalSessionId &&
          row.localProjectId === candidate.localProjectId &&
          row.artifactId === candidate.artifactId &&
          row.providerCursorOffset === candidate.providerCursorOffset
      );
    },
    prepare: (candidate) =>
      serialized(async () => {
        if (
          !Number.isSafeInteger(candidate.requiredSourceOffset) ||
          candidate.requiredSourceOffset < 0
        )
          return false;
        const catalog = catalogProject(
          input.koedHome,
          candidate.sourceProjectPath,
          candidate.localProjectId
        );
        if (!catalog) return false;
        const state = readState(stateFile);
        const facts = await checkoutFacts(catalog, ownedHistory(state));
        if (!facts) return false;
        const existing = state.history.find(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.localProjectId === facts.localProjectId &&
            row.deviceId === deviceId
        );
        const sameConfirmationFacts = Boolean(
          existing?.confirmationId &&
          existing.confirmationFactsKey === confirmationFactsKey(facts)
        );
        const record: LocalRecord = {
          ...facts,
          ownerUserId,
          deviceId,
          sourceKind: candidate.sourceKind,
          externalSessionId: candidate.externalSessionId,
          requiredSourceOffset: candidate.requiredSourceOffset,
          ...(existing?.confirmationVersion
            ? { confirmationVersion: existing.confirmationVersion }
            : {}),
          createdAt: new Date().toISOString(),
          ...(sameConfirmationFacts && existing?.confirmedProjectId
            ? { confirmedProjectId: existing.confirmedProjectId }
            : {}),
          ...(sameConfirmationFacts && existing?.confirmedSeparate
            ? { confirmedSeparate: true }
            : {}),
          ...(sameConfirmationFacts && existing?.confirmationId
            ? {
                confirmationId: existing.confirmationId,
                confirmationFactsKey: existing.confirmationFactsKey
              }
            : {})
        };
        if (existing?.confirmationId && !sameConfirmationFacts)
          record.requiresConfirmation = true;
        else if (existing?.requiresConfirmation && !sameConfirmationFacts)
          record.requiresConfirmation = true;
        if (!existing) state.history.push(record);
        if (
          !state.pending.some(
            (row) =>
              row.ownerUserId === ownerUserId &&
              row.deviceId === deviceId &&
              row.sourceKind === record.sourceKind &&
              row.externalSessionId === record.externalSessionId
          )
        )
          state.pending.push(record);
        writeState(stateFile, state);
        return true;
      }),
    complete: async (sourceKind, externalSessionId, artifact) => {
      await serialized(() => {
        const state = readState(stateFile);
        const record = state.pending.find(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.deviceId === deviceId &&
            row.sourceKind === sourceKind &&
            row.externalSessionId === externalSessionId
        );
        if (!record) return;
        if (
          artifact.externalSessionId !== externalSessionId ||
          artifact.providerCursorOffset < record.requiredSourceOffset
        )
          return;
        record.sessionId = artifact.sessionId;
        record.artifactId = artifact.id;
        record.acceptedProviderCursorOffset = artifact.providerCursorOffset;
        writeState(stateFile, state);
      });
      void replay().catch(() => {
        logger.warn(
          { code: "local_project_association_retry_pending" },
          "Local Project association will retry on the next watcher pass"
        );
      });
    },
    discardBlocked: (sourceKind, externalSessionId) =>
      serialized(() => {
        const state = readState(stateFile);
        const blocked = state.pending.find(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.deviceId === deviceId &&
            row.sourceKind === sourceKind &&
            row.externalSessionId === externalSessionId
        );
        if (!blocked) return;
        state.pending = state.pending.filter((row) => row !== blocked);
        if (
          !state.pending.some(
            (row) =>
              row.ownerUserId === ownerUserId &&
              row.deviceId === deviceId &&
              row.localProjectId === blocked.localProjectId
          )
        ) {
          state.history = state.history.filter(
            (row) =>
              row.ownerUserId !== ownerUserId ||
              row.deviceId !== deviceId ||
              row.localProjectId !== blocked.localProjectId ||
              Boolean(row.projectId)
          );
        }
        writeState(stateFile, state);
      }),
    replay,
    confirm: async (choice) => {
      await replayPromise?.catch(() => undefined);
      await serialized(() => {
        const state = readState(stateFile);
        const history = state.history.filter(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.deviceId === deviceId &&
            row.localProjectId === choice.localProjectId
        );
        if (history.length !== 1)
          throw new Error("Local Project context is not uniquely known");
        const currentPending = state.pending.filter(
          (pending) =>
            pending.ownerUserId === ownerUserId &&
            pending.deviceId === deviceId &&
            pending.localProjectId === choice.localProjectId
        );
        const factsKey = confirmationFactsKey(
          currentPending.at(-1) ?? history[0]!
        );
        const confirmationId = randomUUID();
        const confirmationVersion = (history[0]!.confirmationVersion ?? 0) + 1;
        for (const row of [
          ...history,
          ...currentPending.filter(
            (pending) => confirmationFactsKey(pending) === factsKey
          )
        ]) {
          delete row.confirmedProjectId;
          delete row.confirmedSeparate;
          delete row.requiresConfirmation;
          row.confirmationId = confirmationId;
          row.confirmationVersion = confirmationVersion;
          row.confirmationFactsKey = factsKey;
          if ("separate" in choice.choice) row.confirmedSeparate = true;
          else row.confirmedProjectId = choice.choice.projectId;
        }
        writeState(stateFile, state);
      });
      await replay();
      await replay();
    },
    close: async () => {
      await queue;
      await replayPromise?.catch(() => undefined);
      await pool.end();
    }
  };
};
