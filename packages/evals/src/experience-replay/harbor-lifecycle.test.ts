import { access, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCoordinatorHarborLifecycle,
  startHarborLifecycleServer,
  type HarborLifecycleServer
} from "./harbor-lifecycle.js";

const open: HarborLifecycleServer[] = [];

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((server) => server.close()));
});

const send = async (
  server: HarborLifecycleServer,
  event: string,
  overrides: Record<string, unknown> = {}
): Promise<boolean> => {
  const token = server.processEnvironment.KOED_HARBOR_LIFECYCLE_TOKEN;
  if (!token) throw new Error("missing lifecycle token");
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(server.socketPath);
    let response = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => (response += chunk.toString("utf8")));
    socket.once("end", () => {
      try {
        resolve(
          (JSON.parse(response) as { accepted: boolean }).accepted === true
        );
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () =>
      socket.end(
        `${JSON.stringify({
          schema_version: "koed-harbor-lifecycle-v1",
          token,
          attempt_kind: "source",
          event,
          trial_id: "trial-one",
          task_name: "task-one",
          timestamp: "2026-08-12T00:00:00.000Z",
          ...overrides
        })}\n`
      )
    );
  });
};

describe("Harbor lifecycle acknowledgement", () => {
  it("uses a private socket and acknowledges an ordered completed trial", async () => {
    const events: string[] = [];
    const server = await startHarborLifecycleServer({
      attemptKind: "source",
      callbacks: {
        onAgentStarted: async ({ event }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push(event);
        },
        onAgentEnded: ({ event }) => {
          events.push(event);
        },
        onTrialEnded: ({ event }) => {
          events.push(event);
        }
      }
    });
    open.push(server);
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    await expect(send(server, "agent_started")).resolves.toBe(true);
    await expect(send(server, "agent_ended")).resolves.toBe(true);
    await expect(send(server, "trial_ended")).resolves.toBe(true);
    expect(() => server.assertComplete()).not.toThrow();
    expect(events).toEqual(["agent_started", "agent_ended", "trial_ended"]);
    const socketPath = server.socketPath;
    await server.close();
    open.splice(open.indexOf(server), 1);
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts cancellation as a terminal acknowledged state", async () => {
    const server = await startHarborLifecycleServer({ attemptKind: "source" });
    open.push(server);
    expect(await send(server, "agent_started")).toBe(true);
    expect(await send(server, "trial_cancelled")).toBe(true);
    expect(() => server.assertComplete()).not.toThrow();
  });

  it("rejects wrong tokens, attempts, cross-trial identity and late events", async () => {
    const server = await startHarborLifecycleServer({ attemptKind: "source" });
    open.push(server);
    expect(await send(server, "agent_started", { token: "wrong" })).toBe(false);
    expect(await send(server, "agent_started")).toBe(true);
    expect(await send(server, "agent_ended", { attempt_kind: "replay" })).toBe(
      false
    );
    expect(await send(server, "agent_ended", { trial_id: "other" })).toBe(
      false
    );
    expect(await send(server, "agent_ended")).toBe(true);
    expect(await send(server, "trial_ended")).toBe(true);
    expect(await send(server, "trial_ended")).toBe(false);
  });

  it("activates and journals at agent start, then revokes exactly once", async () => {
    const order: string[] = [];
    const activate = vi.fn();
    const revoke = vi.fn();
    activate.mockImplementation(() => order.push("activate"));
    const append = vi.fn(async () => {
      order.push("journal");
    });
    const callbacks = createCoordinatorHarborLifecycle({
      attemptId: "attempt-one",
      executionGeneration: 2,
      journal: { append: append as never },
      activateCredential: activate,
      revokeCredential: revoke
    });
    const server = await startHarborLifecycleServer({
      attemptKind: "replay",
      callbacks
    });
    open.push(server);
    expect(
      await send(server, "agent_started", { attempt_kind: "replay" })
    ).toBe(true);
    expect(activate).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({
      type: "attempt_state",
      attemptId: "attempt-one",
      executionGeneration: 2,
      state: "agent_started"
    });
    expect(order).toEqual(["journal", "activate"]);
    expect(await send(server, "agent_ended", { attempt_kind: "replay" })).toBe(
      true
    );
    expect(await send(server, "trial_ended", { attempt_kind: "replay" })).toBe(
      true
    );
    expect(revoke).toHaveBeenCalledOnce();
  });
});
