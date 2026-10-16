import { projectSelectionLookupResponseSchema } from "@koed/shared/project-selection";
import { expect, it, vi } from "vitest";
import { normalizeGitRemoteUrl, type ProjectMetadataV1 } from "@koed/shared";
import { resolveKoedServerPaths } from "@koed-labs/server";
import { createProjectSelectionCommand } from "./project-selection-command.js";

const localProjectId = `lp_${"a".repeat(32)}`;
const association = {
  groupId: "group",
  associationId: "association",
  selectionId: "selection"
};
const remote = {
  ...normalizeGitRemoteUrl("https://example.test/team/project.git"),
  name: "origin"
};
const project: ProjectMetadataV1 = {
  schemaVersion: 1,
  discoveredAt: "2026-10-14T00:00:00.000Z",
  lastSeenAt: "2026-10-14T00:00:00.000Z",
  localProjectId,
  displayName: "Project",
  packages: [],
  path: {
    cwd: "/fixture/checkout",
    projectRoot: "/fixture/checkout",
    basename: "checkout",
    localPathHash: "hash"
  },
  repository: {
    kind: "portable_repository",
    key: remote.fingerprint,
    root: "/fixture/checkout",
    branch: "main",
    reason: "origin",
    checkoutId: "checkout",
    originatingDeviceId: "profile",
    selectedRemote: "origin",
    anchorDisplay: remote.display
  },
  git: {
    rootHash: "hash",
    commonDirHash: "hash",
    remotes: [remote],
    remoteAliases: [remote],
    branch: "main",
    headCommit: null,
    isWorktree: false,
    worktreeHash: null
  }
};
const fixture = (accepted = true) => {
  const state = {
    state: "selected",
    heads: ["r1"],
    anchorFingerprint: remote.fingerprint,
    revisions: [
      {
        revisionId: "r1",
        authorDeviceId: "device",
        replaces: [],
        operation: { kind: "set", anchorFingerprint: remote.fingerprint }
      }
    ]
  };
  const request = vi.fn(
    async (
      path: string,
      init?: RequestInit
    ): Promise<Record<string, unknown>> => {
      if (path.startsWith("/v1/memory/"))
        return {
          association: accepted
            ? {
                ...association,
                selection: {
                  state: "selected",
                  anchorFingerprint: remote.fingerprint
                }
              }
            : null
        };
      if (init?.method === "POST" || init?.method === "DELETE")
        return { selection: state, ok: true };
      return {
        associations: [
          {
            associationId: association.associationId,
            selectionId: association.selectionId,
            state
          }
        ]
      };
    }
  );
  const discover = vi.fn(async () => ({
    ok: true,
    state: "discovered" as const,
    message: "",
    project
  }));
  const setLookup = vi.fn(async () => undefined);
  const command = createProjectSelectionCommand({
    paths: resolveKoedServerPaths({ KOED_HOME: "/fixture/profile" }),
    request,
    lookup: async (checkout) =>
      projectSelectionLookupResponseSchema.parse(
        await request(
          `/v1/memory/repository-selection?${new URLSearchParams(checkout)}`
        )
      ),
    status: async () => ({ groups: [{ group_id: "group", state: "active" }] }),
    discover,
    setLookup,
    list: () => ({
      ok: true,
      state: "listed",
      message: "",
      projects: [project]
    }),
    randomId: () => "new_id"
  });
  return { command, request, discover, setLookup };
};

it("inspection never infers an association from an equal anchor", async () => {
  const { command, request, setLookup } = fixture(false);
  const result = await command({ operation: "inspect", localProjectId });
  expect(result.accepted).toBeNull();
  expect(result.associations[0]?.state.anchorFingerprint).toBe(
    remote.fingerprint
  );
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false
  );
  expect(setLookup).not.toHaveBeenCalled();
});
it("uses exact reviewed heads and only the current remote fingerprint when writing", async () => {
  const { command, request } = fixture();
  await command({
    operation: "set",
    localProjectId,
    expectedCheckoutId: "checkout",
    ...association,
    reviewedHeads: ["r1"],
    remoteName: "origin"
  });
  const written = request.mock.calls.find(
    ([path, init]) =>
      path === "/v1/pds/project-selections" && init?.method === "POST"
  );
  expect(JSON.parse(String(written?.[1]?.body))).toEqual({
    ...association,
    reviewedHeads: ["r1"],
    operation: { kind: "set", anchorFingerprint: remote.fingerprint }
  });
  expect(JSON.parse(String(written?.[1]?.body))).not.toHaveProperty(
    "selection"
  );
});
it("rejects checkout reuse, unaccepted editing, unavailable remotes and cross-group acceptance", async () => {
  const stale = fixture();
  await expect(
    stale.command({
      operation: "forget",
      localProjectId,
      expectedCheckoutId: "old_checkout"
    })
  ).rejects.toThrow("Checkout changed");
  expect(stale.request).not.toHaveBeenCalled();
  const unaccepted = fixture(false);
  await expect(
    unaccepted.command({
      operation: "set",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...association,
      reviewedHeads: ["r1"],
      remoteName: "origin"
    })
  ).rejects.toThrow("Accept this Project association");
  const missing = fixture();
  await expect(
    missing.command({
      operation: "create",
      localProjectId,
      expectedCheckoutId: "checkout",
      remoteName: "removed"
    })
  ).rejects.toThrow("current portable");
  await expect(
    missing.command({
      operation: "accept",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...association,
      groupId: "other"
    })
  ).rejects.toThrow("Group changed");
  expect(missing.setLookup).not.toHaveBeenCalled();
});
it("does not retry a stale reviewed resolution and keeps local forgetting separate from shared deletion", async () => {
  const stale = fixture();
  stale.request.mockImplementation(async (path, init) => {
    if (init?.method === "POST") throw new Error("Project selection changed");
    return path.startsWith("/v1/memory/")
      ? { association: { ...association, selection: null } }
      : { associations: [] };
  });
  await expect(
    stale.command({
      operation: "set",
      localProjectId,
      expectedCheckoutId: "checkout",
      ...association,
      reviewedHeads: ["r1"],
      remoteName: null
    })
  ).rejects.toThrow("changed");
  expect(
    stale.request.mock.calls.filter(([, init]) => init?.method === "POST")
  ).toHaveLength(1);
  const forget = fixture();
  await forget.command({
    operation: "forget",
    localProjectId,
    expectedCheckoutId: "checkout"
  });
  expect(
    forget.request.mock.calls.find(([, init]) => init?.method === "DELETE")?.[0]
  ).toBe("/v1/pds/project-associations/accept");
  expect(forget.setLookup).toHaveBeenCalledWith(expect.anything(), {
    localProjectId,
    expectedCheckoutId: "checkout",
    enabled: false
  });
  expect(
    forget.request.mock.calls.some(
      ([path, init]) =>
        path === "/v1/pds/project-selections" && init?.method === "POST"
    )
  ).toBe(false);
});
