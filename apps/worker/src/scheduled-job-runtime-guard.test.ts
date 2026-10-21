import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { readDesktopLocalCredentialAuthorization } from "@koed/shared";
import { guardLocalScheduledJobRepository } from "./scheduled-job-runtime-guard.js";

vi.mock("@koed/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@koed/shared")>()),
  readDesktopLocalCredentialAuthorization: vi.fn()
}));

const readCredential = vi.mocked(readDesktopLocalCredentialAuthorization);
const command = {
  id: "11111111-1111-4111-8111-111111111111",
  leaseToken: "current-lease"
};
const repository = (scheduled: boolean) => {
  const fail = vi.fn(async () => true);
  const claim = vi.fn(
    async (input: { allowedScheduledCommandIds?: string[] }) =>
      !scheduled || input.allowedScheduledCommandIds?.includes(command.id)
        ? [command]
        : []
  );
  const has = vi.fn(async () => scheduled);
  const repo = {
    claimManagedConversationCommands: claim,
    listQueuedScheduledJobCommands: vi.fn(async () =>
      scheduled ? [command.id] : []
    ),
    hasScheduledJobDispatchForCommand: has,
    failManagedConversationCommand: fail
  } as unknown as MemorySourceRepository;
  return { repo, fail, claim, has };
};

describe("Scheduled Job local runner gate", () => {
  it("rejects a remote scheduled claim without breaking ordinary Managed commands or sending a credential", async () => {
    readCredential.mockReturnValue({
      authorization: "Koed-Desktop secret",
      ownerUserId: "owner",
      operationFamilies: ["managed_execution", "personal_collaboration_write"]
    } as ReturnType<typeof readDesktopLocalCredentialAuthorization>);
    const state = repository(true);
    const send = vi.fn();
    const gated = guardLocalScheduledJobRepository({
      repository: state.repo,
      ownerUserId: "owner",
      apiUrl: "https://remote.example.test",
      koedHome: "/unused",
      fetch: send as unknown as typeof fetch
    });
    expect(
      await gated.claimManagedConversationCommands({
        ownerUserId: "owner",
        runnerId: "runner",
        deviceId: "device",
        deploymentId: "deployment",
        limit: 1,
        leaseMs: 30_000
      })
    ).toEqual([]);
    expect(state.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedScheduledCommandIds: []
      })
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("fails a revoked scheduled claim before returning it to the AI Client", async () => {
    readCredential.mockReturnValue({
      authorization: "Koed-Desktop secret",
      ownerUserId: "owner",
      operationFamilies: ["managed_execution", "personal_collaboration_write"]
    } as ReturnType<typeof readDesktopLocalCredentialAuthorization>);
    const state = repository(true);
    const send = vi.fn(async () => new Response("revoked", { status: 409 }));
    const gated = guardLocalScheduledJobRepository({
      repository: state.repo,
      ownerUserId: "owner",
      apiUrl: "http://127.0.0.1:4953/",
      koedHome: "/unused",
      fetch: send as unknown as typeof fetch
    });
    const claimed = await gated.claimManagedConversationCommands({
      ownerUserId: "owner",
      runnerId: "runner",
      deviceId: "device",
      deploymentId: "deployment",
      limit: 1,
      leaseMs: 30_000
    });
    expect(claimed).toEqual([]);
    expect(state.fail).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("terminates a claim if authority disappears between preflight and lease", async () => {
    readCredential.mockReturnValue({
      authorization: "Koed-Desktop secret",
      ownerUserId: "owner",
      operationFamilies: ["managed_execution", "personal_collaboration_write"]
    } as ReturnType<typeof readDesktopLocalCredentialAuthorization>);
    const state = repository(true);
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ allowed: true, scheduled: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(new Response("revoked", { status: 409 }));
    const gated = guardLocalScheduledJobRepository({
      repository: state.repo,
      ownerUserId: "owner",
      apiUrl: "http://127.0.0.1:4953/",
      koedHome: "/unused",
      fetch: send as typeof fetch
    });
    expect(
      await gated.claimManagedConversationCommands({
        ownerUserId: "owner",
        runnerId: "runner",
        deviceId: "device",
        deploymentId: "deployment",
        limit: 1,
        leaseMs: 30_000
      })
    ).toEqual([]);
    expect(state.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: command.id,
        leaseToken: command.leaseToken,
        errorCode: "ScheduledJobAuthorityUnavailable"
      })
    );
  });

  it("leaves an ordinary Personal command independent of the scheduler gate", async () => {
    readCredential.mockReturnValue(null);
    const state = repository(false);
    const send = vi.fn();
    const gated = guardLocalScheduledJobRepository({
      repository: state.repo,
      ownerUserId: "owner",
      apiUrl: "http://127.0.0.1:4953/",
      koedHome: "/unused",
      fetch: send as unknown as typeof fetch
    });
    const claimed = await gated.claimManagedConversationCommands({
      ownerUserId: "owner",
      runnerId: "runner",
      deviceId: "device",
      deploymentId: "deployment",
      limit: 1,
      leaseMs: 30_000
    });
    expect(claimed).toEqual([command]);
    expect(send).not.toHaveBeenCalled();
    expect(state.fail).not.toHaveBeenCalled();
  });

  it("denies renewal and late runtime writes while the scheduled command is still live", async () => {
    readCredential.mockReturnValue({
      authorization: "Koed-Desktop secret",
      ownerUserId: "owner",
      operationFamilies: ["managed_execution", "personal_collaboration_write"]
    } as ReturnType<typeof readDesktopLocalCredentialAuthorization>);
    const renew = vi.fn(async () => true);
    const put = vi.fn(async () => ({}));
    const repo = {
      hasActiveScheduledJobDispatchForExecution: vi.fn(async () => true),
      renewManagedConversationExecutionLease: renew,
      putManagedConversationRuntimeItem: put
    } as unknown as MemorySourceRepository;
    const send = vi.fn(
      async () => new Response("Team offline", { status: 503 })
    );
    const gated = guardLocalScheduledJobRepository({
      repository: repo,
      ownerUserId: "owner",
      apiUrl: "http://127.0.0.1:4953/",
      koedHome: "/unused",
      fetch: send as unknown as typeof fetch
    });
    await expect(
      gated.renewManagedConversationExecutionLease({
        executionId: command.id,
        runnerId: "runner",
        leaseMs: 30_000
      } as Parameters<
        MemorySourceRepository["renewManagedConversationExecutionLease"]
      >[0])
    ).rejects.toThrow("ScheduledJobRuntimeAuthorityUnavailable");
    await expect(
      gated.putManagedConversationRuntimeItem({ userId: "owner" }, {
        executionId: command.id
      } as Parameters<
        MemorySourceRepository["putManagedConversationRuntimeItem"]
      >[1])
    ).rejects.toThrow("ScheduledJobRuntimeAuthorityUnavailable");
    expect(renew).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
