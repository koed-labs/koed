import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  associate: vi.fn(),
  older: vi.fn(async () => 0),
  overrides: vi.fn(async () => ({ mapped: 0, ambiguous: 0 })),
  end: vi.fn(async () => undefined),
  warn: vi.fn()
}));

type TestState = {
  pending: Array<{
    externalSessionId: string;
    confirmedSeparate?: boolean;
    confirmationId?: string;
  }>;
  history: Array<{ projectId?: string }>;
};
type TestCatalog = {
  projects: Array<{
    localProjectId: string;
    path: { cwd: string; projectRoot: string | null };
    git?: { remoteAliases: [] };
  }>;
};
type AssociationCall = {
  externalSessionId: string;
  verifiedNewLinkedCheckout: boolean;
  commonDirHash: string | null;
  hasMovedCheckoutCandidate: boolean;
  confirmedSeparate?: boolean;
  confirmationVersion?: number;
};
const readTestState = (file: string): TestState =>
  JSON.parse(readFileSync(file, "utf8")) as TestState;
const associationCalls = (): Array<[AssociationCall]> =>
  mocks.associate.mock.calls as Array<[AssociationCall]>;

vi.mock("@koed/db", () => ({
  createDbPool: () => ({ end: mocks.end }),
  createProjectRepository: () => ({
    associateVerifiedCapturedSession: mocks.associate,
    associateOlderSessions: mocks.older,
    backfillLegacyProjectOverrides: mocks.overrides
  })
}));
vi.mock("./logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@koed/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@koed/shared")>();
  return {
    ...original,
    readDesktopLocalCredentialAuthorization: () => ({
      ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }),
    inspectDeviceIdentityAtKoedHome: () => ({
      health: "healthy",
      deviceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    })
  };
});

import { deriveLocalProjectId } from "@koed/shared";
import { createLocalProjectAssociationService } from "./local-project-association.js";

const roots: string[] = [];
afterEach(() => {
  mocks.associate.mockReset();
  mocks.older.mockClear();
  mocks.overrides.mockReset();
  mocks.overrides.mockResolvedValue({ mapped: 0, ambiguous: 0 });
  mocks.end.mockClear();
  mocks.warn.mockClear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const koedHome = mkdtempSync(path.join(os.tmpdir(), "hq201-association-"));
  roots.push(koedHome);
  const salt = "test-only-local-salt";
  const folders = ["alpha", "beta"].map((name) => {
    const created = path.join(koedHome, name);
    mkdirSync(created);
    const cwd = realpathSync(created);
    return { cwd, localProjectId: deriveLocalProjectId({ salt, cwd }) };
  });
  mkdirSync(path.join(koedHome, "config"));
  writeFileSync(
    path.join(koedHome, "config", "projects.json"),
    JSON.stringify({
      deviceSaltId: salt,
      projects: folders.map((folder) => ({
        schemaVersion: 1,
        localProjectId: folder.localProjectId,
        displayName: path.basename(folder.cwd),
        path: {
          cwd: folder.cwd,
          projectRoot: null,
          basename: path.basename(folder.cwd),
          localPathHash: "opaque"
        },
        packages: []
      }))
    })
  );
  const environment = {
    KOED_RUNTIME_MODE: "local-personal",
    MEMORY_API_URL: "http://127.0.0.1:8787",
    MEMORY_API_TOKEN: "local-test-token",
    DATABASE_URL: "postgres://local@127.0.0.1:5432/koed",
    KOED_HOME: koedHome
  };
  return { koedHome, folders, environment };
};

const testService = (input: ReturnType<typeof fixture>) => {
  const service = createLocalProjectAssociationService({
    koedHome: input.koedHome,
    environment: input.environment,
    captureClient: {
      apiUrl: input.environment.MEMORY_API_URL,
      apiToken: input.environment.MEMORY_API_TOKEN
    }
  })!;
  return {
    ...service,
    prepare: (
      candidate: Omit<
        Parameters<typeof service.prepare>[0],
        "requiredSourceOffset"
      >
    ) => service.prepare({ ...candidate, requiredSourceOffset: 0 }),
    complete: (
      sourceKind: "codex",
      externalSessionId: string,
      sessionId: string
    ) =>
      service.complete(sourceKind, externalSessionId, {
        id: randomUUID(),
        sessionId,
        externalSessionId,
        providerCursorOffset: 0
      })
  };
};

describe("local Project association durability", () => {
  it("reports ambiguous legacy overrides once without identity data", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = testService({ koedHome, folders, environment });
    mocks.associate.mockResolvedValue({
      state: "resolved",
      projectId: randomUUID(),
      sessionAssigned: true
    });
    mocks.overrides.mockResolvedValue({ mapped: 0, ambiguous: 2 });
    try {
      for (const externalSessionId of ["legacy-a", "legacy-b"]) {
        await service.prepare({
          sourceKind: "codex",
          externalSessionId,
          sourceProjectPath: folders[0]!.cwd,
          localProjectId: folders[0]!.localProjectId
        });
        await service.complete("codex", externalSessionId, randomUUID());
      }
      await service.replay();
      const diagnostics = mocks.warn.mock.calls.filter(
        ([data]) =>
          (data as { code?: string }).code ===
          "personal_project_legacy_override_ambiguous"
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.[0]).toEqual({
        code: "personal_project_legacy_override_ambiguous",
        ambiguousCount: 2,
        countCapped: false
      });
    } finally {
      await service.close();
    }
  });
  it("consumes a separate choice across every pending session for the same context", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = testService({ koedHome, folders, environment });
    const localProjectId = folders[0]!.localProjectId;
    const chosenProjectId = randomUUID();
    mocks.associate.mockImplementation(
      async (input: { confirmedSeparate?: boolean }) =>
        input.confirmedSeparate
          ? {
              state: "resolved",
              projectId: chosenProjectId,
              sessionAssigned: true
            }
          : { state: "unresolved", projectId: null, sessionAssigned: false }
    );
    try {
      for (const externalSessionId of ["pending-a", "pending-b"]) {
        expect(
          await service.prepare({
            sourceKind: "codex",
            externalSessionId,
            sourceProjectPath: folders[0]!.cwd,
            localProjectId
          })
        ).toBe(true);
        await service.complete("codex", externalSessionId, randomUUID());
      }
      await service.replay();
      await service.confirm({ localProjectId, choice: { separate: true } });
      const state = readTestState(
        path.join(koedHome, "config", "project-associations.json")
      );
      expect(state.history[0]).not.toHaveProperty("confirmedSeparate");
      expect(state.history[0]).not.toHaveProperty("confirmationId");
      expect(
        state.pending.every(
          (row) => !row.confirmedSeparate && !row.confirmationId
        )
      ).toBe(true);
      const choiceCalls = associationCalls().filter(
        ([row]) => row.confirmedSeparate
      );
      expect(choiceCalls.length).toBeGreaterThan(0);
      expect(
        new Set(
          choiceCalls.map(
            ([row]) =>
              (row as { confirmationVersion?: number }).confirmationVersion
          )
        )
      ).toEqual(new Set([1]));
      mocks.associate.mockClear();
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "after-deletion",
          sourceProjectPath: folders[0]!.cwd,
          localProjectId
        })
      ).toBe(true);
      await service.complete("codex", "after-deletion", randomUUID());
      await service.replay();
      expect(mocks.associate).toHaveBeenCalledWith(
        expect.not.objectContaining({ confirmedSeparate: true })
      );
    } finally {
      await service.close();
    }
  });
  it("requires the exact local capture client endpoint and token", () => {
    const { koedHome, environment } = fixture();
    expect(
      createLocalProjectAssociationService({
        koedHome,
        environment,
        captureClient: {
          apiUrl: "https://remote.example",
          apiToken: environment.MEMORY_API_TOKEN
        }
      })
    ).toBeNull();
    expect(
      createLocalProjectAssociationService({
        koedHome,
        environment,
        captureClient: {
          apiUrl: environment.MEMORY_API_URL,
          apiToken: "other-token"
        }
      })
    ).toBeNull();
  });

  it("serializes two watcher instances and retains pending records through a DB outage", async () => {
    const { koedHome, folders, environment } = fixture();
    const first = testService({ koedHome, folders, environment });
    const second = testService({ koedHome, folders, environment });
    const stateFile = path.join(
      koedHome,
      "config",
      "project-associations.json"
    );
    try {
      const prepared = await Promise.all([
        first.prepare({
          sourceKind: "codex",
          externalSessionId: "session-a",
          sourceProjectPath: folders[0]!.cwd,
          localProjectId: folders[0]!.localProjectId
        }),
        second.prepare({
          sourceKind: "codex",
          externalSessionId: "session-b",
          sourceProjectPath: folders[1]!.cwd,
          localProjectId: folders[1]!.localProjectId
        })
      ]);
      expect(prepared).toEqual([true, true]);
      const queued = readTestState(stateFile);
      expect(queued.pending.map((row) => row.externalSessionId).sort()).toEqual(
        ["session-a", "session-b"]
      );
      expect(queued.history).toHaveLength(2);

      mocks.associate.mockRejectedValueOnce(new Error("database unavailable"));
      mocks.associate.mockResolvedValue({
        state: "resolved",
        projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sessionAssigned: true
      });
      await Promise.all([
        first.complete(
          "codex",
          "session-a",
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        ),
        second.complete(
          "codex",
          "session-b",
          "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        )
      ]);
      await first.replay();
      await second.replay();
      const drained = readTestState(stateFile);
      expect(drained.pending).toHaveLength(0);
      expect(drained.history).toHaveLength(2);
      expect(
        drained.history.every(
          (row) => row.projectId === "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        )
      ).toBe(true);
      expect(mocks.overrides).toHaveBeenCalled();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("rejects uncatalogued or mismatched capture metadata without queuing identity work", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = testService({ koedHome, folders, environment });
    try {
      const other = path.join(koedHome, "uncatalogued");
      mkdirSync(other);
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "forged",
          sourceProjectPath: other,
          localProjectId: folders[0]!.localProjectId
        })
      ).toBe(false);
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "mismatched",
          sourceProjectPath: folders[0]!.cwd,
          localProjectId: folders[1]!.localProjectId
        })
      ).toBe(false);
      expect(mocks.associate).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("marks a new linked worktree verified only after prior checkout history identifies one Project", async () => {
    const { koedHome, folders, environment } = fixture();
    const base = folders[0]!.cwd;
    const linked = folders[1]!.cwd;
    execFileSync("git", ["init", "-q", base]);
    writeFileSync(path.join(base, "tracked.txt"), "fixture\n");
    execFileSync("git", ["-C", base, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      base,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "seed"
    ]);
    rmSync(linked, { recursive: true });
    execFileSync("git", [
      "-C",
      base,
      "worktree",
      "add",
      "-q",
      "-b",
      "linked",
      linked
    ]);
    const salt = "test-only-local-salt";
    const catalogFile = path.join(koedHome, "config", "projects.json");
    const catalog = JSON.parse(
      readFileSync(catalogFile, "utf8")
    ) as TestCatalog;
    for (const project of catalog.projects) {
      project.path.projectRoot = project.path.cwd;
      project.localProjectId = deriveLocalProjectId({
        salt,
        cwd: project.path.cwd,
        projectRoot: project.path.cwd
      });
      project.git = { remoteAliases: [] };
    }
    writeFileSync(catalogFile, JSON.stringify(catalog));
    const service = testService({ koedHome, folders, environment });
    mocks.associate.mockResolvedValue({
      state: "resolved",
      projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sessionAssigned: true
    });
    try {
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "base",
          sourceProjectPath: base,
          localProjectId: catalog.projects[0]!.localProjectId
        })
      ).toBe(true);
      await service.complete(
        "codex",
        "base",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      );
      await service.replay();
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "linked",
          sourceProjectPath: linked,
          localProjectId: catalog.projects[1]!.localProjectId
        })
      ).toBe(true);
      await service.complete(
        "codex",
        "linked",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      );
      await service.replay();
      const linkedCall = associationCalls().find(
        ([row]) => row.externalSessionId === "linked"
      )?.[0];
      expect(linkedCall?.verifiedNewLinkedCheckout).toBe(true);
      expect(linkedCall?.commonDirHash).toBeTruthy();
      expect(linkedCall?.commonDirHash).toBe(
        associationCalls()[0]?.[0].commonDirHash
      );
    } finally {
      await service.close();
    }
  });

  it("replays a durable captured context after its local folder disappears", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = testService({ koedHome, folders, environment });
    try {
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "moved-after-capture",
          sourceProjectPath: folders[0]!.cwd,
          localProjectId: folders[0]!.localProjectId
        })
      ).toBe(true);
      rmSync(folders[0]!.cwd, { recursive: true });
      mocks.associate.mockResolvedValue({
        state: "resolved",
        projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sessionAssigned: true
      });
      await service.complete(
        "codex",
        "moved-after-capture",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      );
      await service.replay();
      expect(mocks.associate).toHaveBeenCalledWith(
        expect.objectContaining({
          externalSessionId: "moved-after-capture",
          localProjectId: folders[0]!.localProjectId
        })
      );
      const state = readTestState(
        path.join(koedHome, "config", "project-associations.json")
      );
      expect(state.pending).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  it("requires confirmation for a moved main checkout without a remote", async () => {
    const { koedHome, folders, environment } = fixture();
    const original = folders[0]!.cwd;
    execFileSync("git", ["init", "-q", original]);
    writeFileSync(path.join(original, "tracked.txt"), "fixture\n");
    execFileSync("git", ["-C", original, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      original,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "seed"
    ]);
    const catalogFile = path.join(koedHome, "config", "projects.json");
    const catalog = JSON.parse(
      readFileSync(catalogFile, "utf8")
    ) as TestCatalog;
    const entry = catalog.projects[0]!;
    entry.path.projectRoot = original;
    entry.git = { remoteAliases: [] };
    writeFileSync(catalogFile, JSON.stringify(catalog));
    const service = testService({ koedHome, folders, environment });
    mocks.associate.mockResolvedValue({
      state: "resolved",
      projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sessionAssigned: true
    });
    try {
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "original",
          sourceProjectPath: original,
          localProjectId: entry.localProjectId
        })
      ).toBe(true);
      await service.complete("codex", "original", randomUUID());
      await service.replay();
      const movedPath = path.join(koedHome, "moved-main");
      renameSync(original, movedPath);
      const moved = realpathSync(movedPath);
      entry.path.cwd = moved;
      entry.path.projectRoot = moved;
      entry.localProjectId = deriveLocalProjectId({
        salt: "test-only-local-salt",
        cwd: moved,
        projectRoot: moved
      });
      writeFileSync(catalogFile, JSON.stringify(catalog));
      mocks.associate.mockResolvedValue({
        state: "unresolved",
        projectId: null,
        sessionAssigned: false,
        reason: "moved_checkout"
      });
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "moved",
          sourceProjectPath: moved,
          localProjectId: entry.localProjectId
        })
      ).toBe(true);
      await service.complete("codex", "moved", randomUUID());
      await service.replay();
      const movedCall = associationCalls().find(
        ([row]) => row.externalSessionId === "moved"
      )?.[0];
      expect(movedCall?.hasMovedCheckoutCandidate).toBe(true);
      expect(movedCall?.verifiedNewLinkedCheckout).toBe(false);
      const state = readTestState(
        path.join(koedHome, "config", "project-associations.json")
      );
      expect(
        state.pending.some((row) => row.externalSessionId === "moved")
      ).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("bounds each replay pass and rotates missing sessions so later captures are tried", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = testService({ koedHome, folders, environment });
    try {
      for (let index = 0; index < 9; index += 1) {
        expect(
          await service.prepare({
            sourceKind: "codex",
            externalSessionId: `missing-${index}`,
            sourceProjectPath: folders[0]!.cwd,
            localProjectId: folders[0]!.localProjectId
          })
        ).toBe(true);
      }
      const stateFile = path.join(
        koedHome,
        "config",
        "project-associations.json"
      );
      const accepted = JSON.parse(readFileSync(stateFile, "utf8")) as {
        pending: Array<{ sessionId?: string; artifactId?: string }>;
      };
      for (const pending of accepted.pending) {
        pending.sessionId = randomUUID();
        pending.artifactId = randomUUID();
      }
      writeFileSync(stateFile, JSON.stringify(accepted));
      mocks.associate.mockResolvedValue({
        state: "session_missing",
        projectId: null,
        sessionAssigned: false
      });
      await service.replay();
      expect(mocks.associate).toHaveBeenCalledTimes(8);
      await service.replay();
      expect(
        associationCalls().some(
          ([row]) => row.externalSessionId === "missing-8"
        )
      ).toBe(true);
      const state = readTestState(
        path.join(koedHome, "config", "project-associations.json")
      );
      expect(state.pending).toHaveLength(9);
    } finally {
      await service.close();
    }
  });

  it("discards a policy-blocked capture without creating candidate history", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = testService({ koedHome, folders, environment });
    try {
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: "blocked",
          sourceProjectPath: folders[0]!.cwd,
          localProjectId: folders[0]!.localProjectId
        })
      ).toBe(true);
      await service.discardBlocked("codex", "blocked");
      const state = readTestState(
        path.join(koedHome, "config", "project-associations.json")
      );
      expect(state.pending).toHaveLength(0);
      expect(state.history).toHaveLength(0);
      expect(mocks.associate).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("does not replay before an accepted frontier and consumes a one-time separate choice", async () => {
    const { koedHome, folders, environment } = fixture();
    const service = createLocalProjectAssociationService({
      koedHome,
      environment,
      captureClient: {
        apiUrl: environment.MEMORY_API_URL,
        apiToken: environment.MEMORY_API_TOKEN
      }
    })!;
    const externalSessionId = "pending-acceptance";
    const localProjectId = folders[0]!.localProjectId;
    try {
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId,
          sourceProjectPath: folders[0]!.cwd,
          localProjectId,
          requiredSourceOffset: 12
        })
      ).toBe(true);
      await service.replay();
      expect(mocks.associate).not.toHaveBeenCalled();
      await service.complete("codex", externalSessionId, {
        id: randomUUID(),
        sessionId: randomUUID(),
        externalSessionId,
        providerCursorOffset: 11
      });
      await service.replay();
      expect(mocks.associate).not.toHaveBeenCalled();
      mocks.associate.mockResolvedValue({
        state: "unresolved",
        projectId: null,
        sessionAssigned: false
      });
      await service.complete("codex", externalSessionId, {
        id: randomUUID(),
        sessionId: randomUUID(),
        externalSessionId,
        providerCursorOffset: 12
      });
      await service.replay();
      expect(mocks.associate).toHaveBeenCalledWith(
        expect.objectContaining({
          minimumProviderCursorOffset: 12
        })
      );
      mocks.associate.mockResolvedValue({
        state: "resolved",
        projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sessionAssigned: true
      });
      await service.confirm({ localProjectId, choice: { separate: true } });
      const state = readTestState(
        path.join(koedHome, "config", "project-associations.json")
      );
      expect(state.pending).toHaveLength(0);
      expect(state.history[0]).not.toHaveProperty("confirmedSeparate");
      expect(state.history[0]).not.toHaveProperty("confirmationId");
      mocks.associate.mockClear();
      const next = "after-choice";
      expect(
        await service.prepare({
          sourceKind: "codex",
          externalSessionId: next,
          sourceProjectPath: folders[0]!.cwd,
          localProjectId,
          requiredSourceOffset: 0
        })
      ).toBe(true);
      await service.complete("codex", next, {
        id: randomUUID(),
        sessionId: randomUUID(),
        externalSessionId: next,
        providerCursorOffset: 0
      });
      await service.replay();
      expect(mocks.associate).toHaveBeenCalledWith(
        expect.not.objectContaining({ confirmedSeparate: true })
      );
    } finally {
      await service.close();
    }
  });
});
