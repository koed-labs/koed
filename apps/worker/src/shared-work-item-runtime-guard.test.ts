import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { guardLocalSharedWorkItemRepository } from "./shared-work-item-runtime-guard.js";

const executionId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const commandId = "00000000-0000-4000-8000-000000000003";

const setup = (shared: boolean, allowed: boolean) => {
  const command = {
    id: commandId,
    executionId,
    leaseToken: "lease",
    execution: { id: executionId }
  };
  const claim = vi.fn(async () => [command]);
  const fail = vi.fn(async () => ({ updated: true }));
  const renew = vi.fn(async () => true);
  const complete = vi.fn(async () => ({ updated: true }));
  const listCandidates = vi.fn(
    async () => [] as Array<{ executionId: string; commandId: string }>
  );
  const send = vi.fn(
    async (
      url: URL
    ): Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }> => ({
      ok: allowed,
      status: allowed ? 200 : 409,
      json: async () =>
        url.pathname.endsWith("shared-progress")
          ? { published: allowed }
          : { allowed }
    })
  );
  const repository = {
    getSharedWorkItemDispatchForExecution: vi.fn(async () =>
      shared ? { teamWorkItemId: "item", teamBackendId: "team" } : null
    ),
    claimManagedConversationCommands: claim,
    failManagedConversationCommand: fail,
    renewManagedConversationCommandLease: renew,
    completeManagedConversationCommand: complete,
    listSharedDispatchProgressCandidates: listCandidates,
    getManagedConversationCommand: vi.fn(async () => command),
    getManagedConversationExecution: vi.fn(async () => ({ id: executionId }))
  } as unknown as MemorySourceRepository;
  const createGuard = () =>
    guardLocalSharedWorkItemRepository({
      repository,
      ownerUserId,
      apiUrl: "http://127.0.0.1:3300/",
      koedHome: "/unused",
      fetch: send as unknown as typeof fetch,
      resolveDesktopCredential: (() => ({
        authorization: "Koed-Desktop test",
        operationFamilies: ["managed_execution", "personal_collaboration_write"]
      })) as never,
      resolveTeamCredential: (() => ({
        authorization: "Koed-Device team",
        operationFamilies: ["team_workspace_write"]
      })) as never
    });
  const guarded = createGuard();
  return {
    guarded,
    createGuard,
    claim,
    fail,
    renew,
    complete,
    send,
    listCandidates
  };
};

describe("embedded shared Work Item runner fence", () => {
  it("terminally rejects a revoked claim before any command reaches the AI client", async () => {
    const state = setup(true, false);
    const commands = await state.guarded.claimManagedConversationCommands({
      runnerId: "runner",
      deploymentId: "deployment",
      deviceId: "device",
      leaseMs: 30_000
    });
    expect(commands).toEqual([]);
    expect(state.fail).toHaveBeenCalledWith({
      commandId,
      leaseToken: "lease",
      state: "failed",
      errorCode: "SharedDispatchAuthorityUnavailable"
    });
    await expect(
      state.guarded.renewManagedConversationCommandLease({
        commandId,
        executionId,
        leaseToken: "lease",
        runnerId: "runner",
        leaseMs: 30_000
      })
    ).rejects.toThrow("SharedDispatchAuthorityUnavailable");
    expect(state.renew).not.toHaveBeenCalled();
    await expect(
      state.guarded.completeManagedConversationCommand({
        commandId,
        leaseToken: "lease",
        result: {}
      } as never)
    ).rejects.toThrow("SharedDispatchAuthorityUnavailable");
    expect(state.complete).not.toHaveBeenCalled();
  });

  it("allows exact current Team attempt and leaves ordinary Personal dispatch offline independent", async () => {
    const shared = setup(true, true);
    expect(
      await shared.guarded.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      })
    ).toHaveLength(1);
    expect(shared.send).toHaveBeenCalledTimes(2);
    const personal = setup(false, false);
    expect(
      await personal.guarded.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      })
    ).toHaveLength(1);
    expect(personal.send).not.toHaveBeenCalled();
  });

  it("replays only durable terminal public metadata after a worker restart", async () => {
    const state = setup(true, true);
    state.claim.mockResolvedValue([]);
    state.listCandidates.mockResolvedValue([{ executionId, commandId }]);
    const restarted = state.createGuard();
    expect(
      await restarted.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      })
    ).toEqual([]);
    expect(state.listCandidates).toHaveBeenCalledWith(
      { userId: ownerUserId },
      expect.objectContaining({ limit: 25 })
    );
    expect(state.send).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ commandId })
      })
    );
    expect(state.claim).toHaveBeenCalledOnce();
  });

  it("does not repeatedly publish a definitively revoked old attempt", async () => {
    const state = setup(true, true);
    state.claim.mockResolvedValue([]);
    state.listCandidates.mockResolvedValue([{ executionId, commandId }]);
    state.send.mockImplementation(async (url: URL) =>
      url.pathname.endsWith("shared-progress")
        ? { ok: false, status: 409, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ allowed: true }) }
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await state.guarded.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      });
      now.mockReturnValue(31_000);
      await state.guarded.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      });
      expect(state.listCandidates).toHaveBeenCalledTimes(2);
      expect(
        state.send.mock.calls.filter(([url]) =>
          url.pathname.endsWith("shared-progress")
        )
      ).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("retries transient Team read failures during durable recovery", async () => {
    const state = setup(true, true);
    state.claim.mockResolvedValue([]);
    state.listCandidates.mockResolvedValue([{ executionId, commandId }]);
    let offline = true;
    state.send.mockImplementation(async (url: URL) =>
      url.pathname.endsWith("shared-progress")
        ? {
            ok: !offline,
            status: offline ? 503 : 200,
            json: async () => ({ published: !offline })
          }
        : { ok: true, status: 200, json: async () => ({ allowed: true }) }
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await state.guarded.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      });
      offline = false;
      now.mockReturnValue(31_000);
      await state.guarded.claimManagedConversationCommands({
        runnerId: "runner",
        deploymentId: "deployment",
        deviceId: "device",
        leaseMs: 30_000
      });
      expect(
        state.send.mock.calls.filter(([url]) =>
          url.pathname.endsWith("shared-progress")
        )
      ).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });
});
