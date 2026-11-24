import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureDeviceIdentity,
  hintsForConversation,
  resolveKoedServerPaths
} from "@koed-labs/server";
import {
  inspectDeviceIdentityAtKoedHome,
  normalizeGitRemoteUrl
} from "@koed-labs/shared";
import {
  createProjectCommands,
  type ProjectCommandsDeps
} from "./project-commands.js";
import {
  createProjectManagementValidationApi,
  validationId,
  validationOwner
} from "../project-management-validation-api.js";

vi.mock("@koed-labs/server", async (original) => ({
  ...(await original<typeof import("@koed-labs/server")>()),
  hintsForConversation: vi.fn()
}));

vi.mock("@koed-labs/shared", async (original) => ({
  ...(await original<typeof import("@koed-labs/shared")>()),
  inspectDeviceIdentityAtKoedHome: vi.fn()
}));

const sessionId = validationId(108);
const folder = {
  ownerUserId: validationOwner,
  folderId: "same-id",
  originatingDeploymentId: "deployment",
  originatingDeviceId: "device",
  originatingProfileId: "profile",
  directoryIncarnationId: "reviewed"
};
const input = { sessionId, kind: "worktree-parent", folder };
const candidate = {
  tier: "medium",
  kind: "worktree-parent",
  folder,
  score: 4,
  reasons: []
} satisfies NonNullable<
  Awaited<ReturnType<typeof hintsForConversation>>
>[number];
const score = vi.mocked(hintsForConversation);
const repository = {
  kind: "portable_repository",
  key: "remote",
  root: "/work/branch",
  branch: null,
  reason: "origin",
  checkoutId: null,
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/owner/repo"
} as const;
const gitCandidate = {
  tier: "medium",
  kind: "repository",
  directory: "/work/branch",
  repositoryKey: repository.key,
  score: 4,
  reasons: [
    { code: "recorded-cwd", outcome: "agrees" },
    { code: "local-directory", outcome: "agrees" },
    { code: "origin-device", outcome: "unavailable" },
    { code: "directory-birthtime", outcome: "agrees" },
    { code: "git-directory-birthtime", outcome: "agrees" },
    { code: "directory-remote", outcome: "agrees" }
  ]
} satisfies NonNullable<
  Awaited<ReturnType<typeof hintsForConversation>>
>[number];

function setup(
  knownFolders = [folder],
  evidence: Record<string, unknown> = {}
) {
  const { contexts } = createProjectManagementValidationApi();
  const request = vi.fn(async (_path: string, init?: RequestInit) => ({
    ...(JSON.parse(String(init?.body)).proposedFolders ? { knownFolders } : {}),
    ownerUserId: validationOwner,
    evidence: [
      {
        sessionId,
        folderAssignment: contexts.get(sessionId)!.folder,
        recordedCwd: "/work/branch",
        firstConversationAt: null,
        recordedRemoteFingerprint: null,
        capturedOnThisDevice: true,
        gitRevision: 3,
        ...evidence
      }
    ]
  }));
  const commands = createProjectCommands({
    personalRequest: request,
    paths: { koedHome: "/koed-home" },
    lookup: {}
  } as unknown as ProjectCommandsDeps);
  return {
    request,
    confirm: commands.confirmFolderHint,
    hints: commands.folderHints
  };
}

function setupGitReview({
  target = repository,
  startedAt = "2024-01-01T00:00:00.000Z",
  paths,
  importAuthority
}: {
  target?: { key: string; root: string };
  startedAt?: string;
  paths?: ProjectCommandsDeps["paths"];
  importAuthority?: { deploymentId: string; deviceId: string };
} = {}) {
  const fixture = createProjectManagementValidationApi();
  const context = fixture.contexts.get(sessionId)!;
  const evidence = {
    sessionId,
    folderAssignment: context.folder,
    recordedCwd: target.root,
    firstConversationAt: startedAt,
    recordedRemoteFingerprint: null,
    capturedOnThisDevice: false,
    gitInferenceEligibility: true,
    recordingDeviceProvenance: importAuthority
      ? "assumed-local-import"
      : "unknown",
    importAuthority: importAuthority && {
      ...importAuthority,
      artifactId: validationId(910),
      importSourceId: validationId(911),
      startedAt
    },
    gitRevision: 1
  };
  const request = vi.fn(
    async (path: string, _init?: RequestInit, _scope?: string) => {
      if (path.endsWith("/folder-hint-evidence")) {
        return { ownerUserId: validationOwner, evidence: [evidence] };
      }
      return {
        context,
        preview: {
          reviewId: validationId(900),
          axis: "git",
          expectedVersion: 1,
          before: context,
          after: {
            ...context,
            git: {
              ...context.git,
              correction: {
                state: "corrected",
                value: { state: "known", value: { ...repository, ...target } },
                revisionId: validationId(901)
              },
              revision: 2
            }
          },
          projects: [],
          inferenceIntent: importAuthority
            ? "assumed-local-import"
            : "user-confirmed-unknown"
        }
      };
    }
  );
  const commands = () =>
    createProjectCommands({
      personalRequest: request,
      paths,
      lookup: vi.fn()
    } as unknown as ProjectCommandsDeps);
  return {
    evidence,
    request,
    manage: commands().manageSourceContext,
    hints: commands().folderHints,
    restart: () => commands().manageSourceContext
  };
}

beforeEach(() => {
  score.mockReset();
  vi.mocked(inspectDeviceIdentityAtKoedHome).mockReset();
});

const guardedPreview = {
  reviewedDirectory: "/work/branch",
  sessionId,
  action: "preview",
  correction: {
    axis: "git",
    action: "set",
    repository,
    expectedVersion: 1,
    inferenceIntent: "user-confirmed-unknown"
  }
};

const expectedScopeKey = "a".repeat(64);
const assumedLocalPreview = {
  expectedScopeKey,
  sessionId,
  action: "preview",
  correction: {
    ...guardedPreview.correction,
    inferenceIntent: "assumed-local-import"
  }
};

const identifiableGitCandidate = {
  ...gitCandidate,
  directoryIncarnation: "reviewed-incarnation",
  gitCheckoutIncarnation: "reviewed-git-incarnation"
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const createGitCheckout = (cwd: string, remote: string) => {
  mkdirSync(cwd);
  git(cwd, "init", "-q");
  git(cwd, "remote", "add", "origin", remote);
};

async function setupLinkedCheckout(
  root: string,
  directory: string,
  replacement: string,
  remote: string
) {
  const seed = resolve(root, "seed");
  createGitCheckout(seed, remote);
  git(
    seed,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "initial",
    "--allow-empty"
  );
  git(seed, "worktree", "add", "--quiet", "--detach", directory);
  const gitDir = git(directory, "rev-parse", "--absolute-git-dir");
  const start =
    Math.ceil(
      Math.max(statSync(directory).birthtimeMs, statSync(gitDir).birthtimeMs)
    ) + 1;
  await setTimeout(25);
  const commonDir = resolve(root, "common");
  cpSync(resolve(seed, ".git"), commonDir, { recursive: true });
  cpSync(commonDir, replacement, { recursive: true });
  writeFileSync(resolve(gitDir, "commondir"), `${commonDir}\n`);
  expect(statSync(commonDir).birthtimeMs).toBeGreaterThan(start);
  return start;
}

async function setupReplaceableGitReview(
  root: string,
  assumedLocal = false,
  linked = false
) {
  const directory = resolve(root, "reviewed");
  const replacement = resolve(root, "replacement");
  const remote = "https://github.com/acme/history.git";
  if (!linked)
    for (const cwd of [directory, replacement]) createGitCheckout(cwd, remote);
  const start = linked
    ? await setupLinkedCheckout(root, directory, replacement, remote)
    : Date.now() + 1_000;
  const environment = { NODE_ENV: "test", KOED_HOME: resolve(root, "profile") };
  const paths = resolveKoedServerPaths(environment);
  const identity = await ensureDeviceIdentity(paths, { environment });
  const importAuthority = assumedLocal
    ? {
        deploymentId: identity.deploymentId!,
        deviceId: identity.deviceInstanceId!
      }
    : undefined;
  if (assumedLocal)
    vi.mocked(inspectDeviceIdentityAtKoedHome).mockReturnValue(identity);
  const target = {
    ...repository,
    root: directory,
    key: normalizeGitRemoteUrl(remote).fingerprint!
  };
  const { hintsForConversation: realScore } =
    await vi.importActual<typeof import("@koed-labs/server")>(
      "@koed-labs/server"
    );
  score.mockImplementation((paths, conversation, options) =>
    realScore(paths, conversation, {
      ...options,
      environment,
      now: () => start + 1_000
    })
  );
  return {
    ...setupGitReview({
      target,
      startedAt: new Date(start).toISOString(),
      paths,
      importAuthority
    }),
    directory,
    replacement,
    target
  };
}

describe("Git inference confirmation", () => {
  it("binds the assumed-local import to both current Desktop authority IDs", async () => {
    const importAuthority = { deploymentId: "deployment", deviceId: "device" };
    const { evidence, hints, manage, request } = setupGitReview({
      paths: { koedHome: "/koed-home" } as ProjectCommandsDeps["paths"],
      importAuthority
    });
    const identity = (deploymentId: string, deviceInstanceId: string) => {
      vi.mocked(inspectDeviceIdentityAtKoedHome).mockReturnValue({
        remoteOperationsAllowed: true,
        deploymentId,
        deviceInstanceId
      } as ReturnType<typeof inspectDeviceIdentityAtKoedHome>);
    };
    score.mockResolvedValue([identifiableGitCandidate]);
    identity("deployment", "other-device");
    await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject({
      hints: [{ recordingDeviceProvenance: "unknown" }]
    });
    await expect(manage(assumedLocalPreview)).rejects.toThrow(
      "no longer matches"
    );
    identity("deployment", "device");
    await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject({
      hints: [{ recordingDeviceProvenance: "assumed-local-import" }]
    });
    expect(score.mock.lastCall?.[1]).toMatchObject({ originDeviceId: null });
    await manage(assumedLocalPreview);
    const scopedCalls = request.mock.calls.slice(-2);
    expect(
      scopedCalls.map(([path, , scope]) => [path.split("/").at(-1), scope])
    ).toEqual([
      ["folder-hint-evidence", expectedScopeKey],
      ["reviews", expectedScopeKey]
    ]);
    expect(JSON.parse(scopedCalls[1]![1]!.body as string)).toMatchObject({
      localImportBasis: evidence.importAuthority
    });
    identity("other-deployment", "device");
    await expect(
      manage({
        sessionId,
        action: "apply",
        reviewId: validationId(900),
        expectedVersion: 1,
        expectedScopeKey
      })
    ).rejects.toThrow("no longer matches");
    expect(request.mock.calls.some(([path]) => path.endsWith("/apply"))).toBe(
      false
    );
  });

  it.each([
    "missing scope",
    "different scope",
    "artifactId",
    "importSourceId",
    "startedAt",
    "unchanged"
  ])(
    "requires the reviewed scope and import basis at apply: %s",
    async (change) => {
      const { evidence, manage, request } = setupGitReview({
        paths: { koedHome: "/koed-home" } as ProjectCommandsDeps["paths"],
        importAuthority: { deploymentId: "deployment", deviceId: "device" }
      });
      vi.mocked(inspectDeviceIdentityAtKoedHome).mockReturnValue({
        remoteOperationsAllowed: true,
        deploymentId: "deployment",
        deviceInstanceId: "device"
      } as ReturnType<typeof inspectDeviceIdentityAtKoedHome>);
      score.mockResolvedValue([identifiableGitCandidate]);
      await manage(assumedLocalPreview);
      if (
        change === "artifactId" ||
        change === "importSourceId" ||
        change === "startedAt"
      )
        evidence.importAuthority![change] =
          change === "startedAt"
            ? "2024-01-01T00:00:00.000001Z"
            : validationId(912);
      const apply = manage({
        action: "apply",
        sessionId,
        reviewId: validationId(900),
        expectedVersion: 1,
        expectedScopeKey:
          change === "missing scope"
            ? undefined
            : change === "different scope"
              ? "b".repeat(64)
              : expectedScopeKey
      });
      const applyCalls = () =>
        request.mock.calls.filter(([path]) => path.endsWith("/apply"));
      if (change === "unchanged") {
        await apply;
        expect(
          request.mock.calls.slice(-2).map(([, , scope]) => scope)
        ).toEqual([expectedScopeKey, expectedScopeKey]);
        expect(applyCalls()).toHaveLength(1);
      } else {
        await expect(apply).rejects.toThrow("no longer matches");
        expect(applyCalls()).toHaveLength(0);
      }
    }
  );

  it.each([{ repositoryKey: "changed" }, { directory: "/other/checkout" }])(
    "rechecks the exact repository against current evidence again at apply: %j",
    async (changed) => {
      const { manage, request } = setupGitReview();
      score
        .mockResolvedValueOnce([identifiableGitCandidate])
        .mockResolvedValueOnce([{ ...identifiableGitCandidate, ...changed }]);
      await expect(manage(guardedPreview)).resolves.toMatchObject({
        preview: { reviewId: validationId(900) }
      });
      await expect(
        manage({
          sessionId,
          action: "apply",
          reviewId: validationId(900),
          expectedVersion: 1
        })
      ).rejects.toThrow("no longer matches");
      expect(score).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.some(([path]) => path.endsWith("/apply"))).toBe(
        false
      );
    }
  );

  it.each([false, true])(
    "does not apply after a different checkout takes the reviewed path (assumed-local: %s)",
    async (assumedLocal) => {
      const parent = resolve(import.meta.dirname, "../../../../scratch");
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(resolve(parent, "git-review-"));
      try {
        const { manage, request, directory, replacement, target } =
          await setupReplaceableGitReview(root, assumedLocal);
        const preview = assumedLocal
          ? assumedLocalPreview
          : { ...guardedPreview, reviewedDirectory: directory };
        await manage({
          ...preview,
          correction: { ...preview.correction, repository: target }
        });
        renameSync(directory, resolve(root, "retired"));
        renameSync(replacement, directory);
        await expect(
          manage({
            sessionId,
            action: "apply",
            reviewId: validationId(900),
            expectedVersion: 1,
            ...(assumedLocal ? { expectedScopeKey } : {})
          })
        ).rejects.toThrow("no longer matches");
        expect(
          request.mock.calls.some(([path]) => path.endsWith("/apply"))
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "does not apply after same-remote Git metadata replacement (assumed-local: %s)",
    async (assumedLocal) => {
      const root = mkdtempSync(
        resolve(import.meta.dirname, "../../../../scratch/git-review-")
      );
      try {
        const { hints, manage, request, directory, replacement, target } =
          await setupReplaceableGitReview(root, assumedLocal);
        await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject(
          {
            hints: [
              expect.objectContaining({
                kind: "repository",
                gitInferenceEligibility: true
              })
            ]
          }
        );
        const preview = assumedLocal
          ? assumedLocalPreview
          : { ...guardedPreview, reviewedDirectory: directory };
        await manage({
          ...preview,
          correction: { ...preview.correction, repository: target }
        });
        renameSync(resolve(directory, ".git"), resolve(root, "retired-git"));
        renameSync(resolve(replacement, ".git"), resolve(directory, ".git"));
        await expect(
          manage({
            sessionId,
            action: "apply",
            reviewId: validationId(900),
            expectedVersion: 1,
            ...(assumedLocal ? { expectedScopeKey } : {})
          })
        ).rejects.toThrow("no longer matches");
        expect(
          request.mock.calls.some(([path]) => path.endsWith("/apply"))
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("rejects a same-remote swap of the linked worktree's common Git directory", async () => {
    const root = mkdtempSync(
      resolve(import.meta.dirname, "../../../../scratch/git-review-")
    );
    try {
      const { hints, manage, request, directory, replacement, target } =
        await setupReplaceableGitReview(root, true, true);
      const commonDir = git(
        directory,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      );
      const gitDir = git(directory, "rev-parse", "--absolute-git-dir");
      expect(commonDir).not.toBe(gitDir);
      const before = statSync(gitDir, { bigint: true });
      await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject({
        hints: [
          {
            kind: "repository",
            repositoryKey: target.key,
            gitInferenceEligibility: true
          }
        ]
      });
      await manage({
        ...assumedLocalPreview,
        correction: { ...assumedLocalPreview.correction, repository: target }
      });
      renameSync(commonDir, resolve(root, "retired-common"));
      renameSync(replacement, commonDir);
      expect(statSync(gitDir, { bigint: true }).ino).toBe(before.ino);
      await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject({
        hints: [
          {
            kind: "repository",
            repositoryKey: target.key,
            gitInferenceEligibility: true
          }
        ]
      });
      await expect(
        manage({
          sessionId,
          action: "apply",
          reviewId: validationId(900),
          expectedVersion: 1,
          expectedScopeKey
        })
      ).rejects.toThrow("no longer matches");
      expect(request.mock.calls.some(([path]) => path.endsWith("/apply"))).toBe(
        false
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not preview an approved checkout that moved to a different directory", async () => {
    const { manage, request } = setupGitReview();
    score.mockResolvedValue([
      { ...identifiableGitCandidate, directory: "/different/checkout" }
    ]);
    await expect(manage(guardedPreview)).rejects.toThrow("no longer matches");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["missing identity", "missing age", "new checkout"])(
    "keeps an assumed-local Git Anchor advisory with %s",
    async (problem) => {
      const { hints, manage, request } = setupGitReview({
        paths: { koedHome: "/koed-home" } as ProjectCommandsDeps["paths"],
        importAuthority: { deploymentId: "deployment", deviceId: "device" }
      });
      vi.mocked(inspectDeviceIdentityAtKoedHome).mockReturnValue({
        remoteOperationsAllowed: true,
        deploymentId: "deployment",
        deviceInstanceId: "device"
      } as ReturnType<typeof inspectDeviceIdentityAtKoedHome>);
      const outcome =
        problem === "missing age" ? "unavailable" : "does-not-agree";
      score.mockResolvedValue([
        problem === "missing identity"
          ? { ...gitCandidate, directoryIncarnation: "root-only" }
          : {
              ...identifiableGitCandidate,
              reasons: identifiableGitCandidate.reasons.map((reason) =>
                reason.code === "git-directory-birthtime"
                  ? { ...reason, outcome }
                  : reason
              )
            }
      ]);
      await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject({
        hints: [{ kind: "repository", gitInferenceEligibility: false }]
      });
      await expect(manage(assumedLocalPreview)).rejects.toThrow(
        "no longer matches"
      );
      expect(
        request.mock.calls.some(([path]) => path.endsWith("/reviews"))
      ).toBe(false);
    }
  );

  it("does not preview an otherwise eligible checkout without an incarnation marker", async () => {
    const { manage, request } = setupGitReview();
    score.mockResolvedValue([
      { ...gitCandidate, gitCheckoutIncarnation: "git-only" }
    ]);
    await expect(manage(guardedPreview)).rejects.toThrow("no longer matches");
    expect(request).toHaveBeenCalledOnce();
  });

  it("forwards a guarded apply only after matching fresh evidence", async () => {
    const { manage, request } = setupGitReview();
    score.mockResolvedValue([identifiableGitCandidate]);
    await manage(guardedPreview);
    await manage({
      sessionId,
      action: "apply",
      reviewId: validationId(900),
      expectedVersion: 1
    });
    expect(score).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([path]) => path.split("/").at(-1))).toEqual([
      "folder-hint-evidence",
      "reviews",
      "folder-hint-evidence",
      "apply"
    ]);
    expect(score.mock.calls[0]?.[1]).toMatchObject({
      originDeviceId: null,
      allowUnknownRepositoryCandidate: true
    });
  });

  it("does not forward a persisted review without a local preview receipt", async () => {
    const { manage, restart, request } = setupGitReview();
    score.mockResolvedValue([identifiableGitCandidate]);
    await manage(guardedPreview);
    await expect(
      restart()({
        sessionId,
        action: "apply",
        reviewId: validationId(900),
        expectedVersion: 1
      })
    ).rejects.toThrow("review is unavailable");
    expect(request.mock.calls.some(([path]) => path.endsWith("/apply"))).toBe(
      false
    );
  });

  it.each(["known-copy", undefined])(
    "rejects %s provenance before preview",
    async (provenance) => {
      const { evidence, manage, request } = setupGitReview();
      Object.assign(evidence, { recordingDeviceProvenance: provenance });
      await expect(manage(guardedPreview)).rejects.toThrow("no longer matches");
      expect(request).toHaveBeenCalledOnce();
      expect(score).not.toHaveBeenCalled();
    }
  );
});

describe("Folder hint confirmation", () => {
  it("rejects a fresh same-kind candidate with a different directory incarnation", async () => {
    const { confirm, request } = setup();
    score.mockResolvedValue([
      {
        ...candidate,
        reasons: [],
        folder: { ...folder, directoryIncarnationId: "replacement" }
      }
    ]);
    await expect(confirm(input)).rejects.toThrow("no longer matches");
    expect(request).toHaveBeenCalledTimes(1);
    expect(score).toHaveBeenCalledOnce();
  });

  it("rejects another kind even when its full Folder reference matches", async () => {
    const { confirm } = setup();
    score.mockResolvedValue([
      { ...candidate, reasons: [], kind: "registered" }
    ]);
    await expect(confirm(input)).rejects.toThrow("no longer matches");
  });

  it("rejects an exact local candidate with no matching server reference", async () => {
    const { confirm } = setup([
      { ...folder, directoryIncarnationId: "replacement" }
    ]);
    score.mockResolvedValue([candidate]);
    await expect(confirm(input)).rejects.toThrow("not recorded on the server");
  });

  it("confirms the exact reference without calling any write endpoint", async () => {
    const { confirm, request } = setup();
    score.mockResolvedValue([{ ...candidate, reasons: [] }]);
    await expect(confirm(input)).resolves.toEqual({ folder });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/v1/personal/sessions/folder-hint-evidence",
      expect.objectContaining({
        body: JSON.stringify({
          sessionIds: [sessionId],
          proposedFolders: [folder]
        })
      }),
      undefined
    );
  });
});

describe("Folder hint listing", () => {
  it("forwards the reviewed scope when saving manual organization", async () => {
    const fixture = createProjectManagementValidationApi();
    const edit = {
      expectedContext: fixture.contexts.get(sessionId)!,
      reviewedProjects: [{ projectId: validationId(1), expectedVersion: 1 }],
      memberships: [
        { projectId: validationId(1), direct: false, excluded: false }
      ],
      corrections: []
    };
    const expected = await fixture.api.manageSourceContext!({
      action: "organize",
      sessionId,
      edit
    });
    const request = vi.fn(async () => expected);
    const { manageSourceContext } = createProjectCommands({
      personalRequest: request,
      lookup: {}
    } as unknown as ProjectCommandsDeps);
    await manageSourceContext({
      action: "organize",
      sessionId,
      edit,
      expectedScopeKey
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/personal/sessions/${sessionId}/organization`,
      expect.objectContaining({ body: JSON.stringify(edit) }),
      expectedScopeKey
    );
  });

  it("only returns Folder candidates with an exact server-known reference", async () => {
    const { hints, request } = setup();
    const unknown = { ...folder, directoryIncarnationId: "registry-only" };
    score.mockResolvedValue([
      candidate,
      { ...candidate, kind: "registered", folder: unknown }
    ]);
    await expect(hints({ sessionIds: [sessionId] })).resolves.toEqual({
      hints: [{ ...candidate, sessionId, folderRevision: 1 }]
    });
    expect(
      request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    ).toEqual([
      { sessionIds: [sessionId] },
      { sessionIds: [sessionId], proposedFolders: [folder, unknown] }
    ]);
  });

  it("does not tell the local scorer that legacy replica absence proves recording device", async () => {
    const { hints } = setup();
    score.mockResolvedValue([candidate]);
    await hints({ sessionIds: [sessionId] });
    const conversation = score.mock.calls[0]?.[1];
    expect(conversation?.capturedOnThisDevice).not.toBe(true);
    expect(conversation?.originDeviceId).toBeNull();
  });

  it.each([
    ["deployment", "recording-device"],
    ["foreign-deployment", "known-copy"]
  ])(
    "binds declared recording provenance to the original Folder and current deployment %s",
    async (deploymentId, provenance) => {
      vi.mocked(inspectDeviceIdentityAtKoedHome).mockReturnValue({
        remoteOperationsAllowed: true,
        deploymentId,
        deviceInstanceId: folder.originatingDeviceId
      } as ReturnType<typeof inspectDeviceIdentityAtKoedHome>);
      const { hints } = setup([folder], {
        recordingDeviceProvenance: "recording-device",
        gitInferenceEligibility: true,
        gitRevision: 1,
        firstConversationAt: "2024-01-01T00:00:00.000Z",
        folderAssignment: {
          revision: 1,
          original: {
            state: "known",
            value: {
              reference: folder,
              normalizedPath: "/work/branch",
              capturedPath: "/work/branch"
            }
          },
          correction: { state: "original" }
        }
      });
      score.mockResolvedValue([identifiableGitCandidate]);
      await expect(hints({ sessionIds: [sessionId] })).resolves.toMatchObject({
        hints: [
          {
            recordingDeviceProvenance: provenance,
            gitInferenceEligibility: true
          }
        ]
      });
      expect(score.mock.calls[0]?.[1].originDeviceId).toBe(
        provenance === "recording-device" ? "device" : null
      );
    }
  );

  it("returns the scored Git revision without requesting Folder eligibility", async () => {
    const { hints, request } = setup();
    const anchor = {
      tier: "medium",
      kind: "repository",
      repositoryKey: "remote",
      score: 4,
      reasons: []
    } as const;
    score.mockResolvedValue([
      { ...anchor, reasons: [], directoryIncarnation: "local-only" }
    ]);
    await expect(hints({ sessionIds: [sessionId] })).resolves.toEqual({
      hints: [{ ...anchor, sessionId, gitRevision: 3 }]
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
