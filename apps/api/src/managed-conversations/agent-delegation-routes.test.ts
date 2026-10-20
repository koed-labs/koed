import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAgentDelegationRoutes } from "./agent-delegation-routes.js";

const ownerId = randomUUID();
vi.mock("./hq-auth.js", () => ({
  authenticateHqManagedWrite: vi.fn(async () => ({ id: ownerId }))
}));

const setup = (replay = false, cold = false) => {
  const projectId = randomUUID();
  const executionId = randomUUID();
  const childExecutionId = randomUUID();
  const agentId = randomUUID();
  const requestId = `agent-delegation:${randomUUID()}`;
  const runner = { deploymentId: randomUUID(), deviceId: randomUUID() };
  const parent = {
    id: executionId,
    projectId,
    executionGeneration: 3,
    state: "running",
    runnerDeploymentId: runner.deploymentId,
    runnerDeviceId: runner.deviceId
  };
  const child = {
    id: childExecutionId,
    projectId,
    executionGeneration: 1,
    provider: "codex",
    aiClientInstanceId: "codex.fixture",
    model: "gpt-test",
    permissionMode: "supervised",
    runnerDeploymentId: runner.deploymentId,
    runnerDeviceId: runner.deviceId
  };
  const previous = replay
    ? {
        projectId,
        parentExecutionId: cold ? null : executionId,
        parentExecutionGeneration: cold ? null : 3,
        childExecutionId,
        agentId
      }
    : null;
  const repository = {
    getManagedConversationExecution: vi.fn(async (_actor, id) =>
      id === executionId ? parent : child
    ),
    getManagedAgentDelegationByRequest: vi.fn(async () => previous),
    getManagedConversationRuntimeBinding: vi.fn(async () =>
      replay
        ? {
            deploymentId: runner.deploymentId,
            deviceId: runner.deviceId,
            executionGeneration: 1
          }
        : null
    ),
    createManagedConversation: vi.fn(async () => ({ execution: child })),
    upsertManagedConversationRuntimeBinding: vi.fn(async () => undefined),
    listManagedAgentDelegations: vi.fn(async () => [])
  };
  const agents = {
    list: vi.fn(async () => [
      {
        id: agentId,
        isChiefOfStaff: false,
        aiClientInstanceId: "codex.fixture",
        defaultModel: "gpt-test",
        defaultPermissionMode: "supervised"
      }
    ])
  };
  const launchInstances = vi.fn(async () => [
    {
      instanceId: "codex.fixture",
      driverId: "codex",
      ready: true,
      models: [{ id: "gpt-test" }]
    }
  ]);
  const assertSelection = vi.fn(async () => undefined);
  const localProjectExecutionPath = vi.fn(async () => "/private/project");
  const app = Fastify();
  registerAgentDelegationRoutes(app, {
    context: {
      config: { deploymentProfile: "developer" },
      requireRepository: () => repository
    },
    agents,
    writeRateLimit: async () => undefined,
    readRateLimit: async () => undefined,
    runnerIdentity: async () => runner,
    launchInstances,
    assertSelection,
    localProjectExecutionPath
  } as never);
  const send = (prompt = "Build the UI", targetAgentId = agentId) =>
    app.inject({
      method: "POST",
      url: `/v1/managed-conversations/${executionId}/delegate`,
      payload: {
        agentId: targetAgentId,
        executionGeneration: 3,
        requestId,
        prompt
      }
    });
  const sendCold = (prompt = "Build the UI", targetAgentId = agentId) =>
    app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/hq/delegate`,
      payload: { agentId: targetAgentId, requestId, prompt }
    });
  return {
    app,
    send,
    repository,
    agents,
    launchInstances,
    assertSelection,
    localProjectExecutionPath,
    childExecutionId,
    agentId,
    parent,
    requestId,
    sendCold,
    projectId
  };
};

describe("private Agent delegation route", () => {
  it("selects the owned Helper's configured AI Client and binds a new child", async () => {
    const f = setup();
    const result = await f.send();
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({
      executionId: f.childExecutionId,
      agentId: f.agentId,
      reused: false
    });
    expect(f.repository.createManagedConversation).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        provider: "codex",
        aiClientInstanceId: "codex.fixture",
        model: "gpt-test",
        initialPrompt: "Build the UI",
        agentDelegation: expect.objectContaining({
          agentId: f.agentId,
          requestId: f.requestId,
          parentExecutionGeneration: 3
        })
      })
    );
    expect(
      f.repository.upsertManagedConversationRuntimeBinding
    ).toHaveBeenCalledOnce();
    await f.app.close();
  });

  it("recovers an existing child after Agent configuration changes without relaunching it", async () => {
    const f = setup(true);
    f.agents.list.mockResolvedValue([]);
    f.launchInstances.mockResolvedValue([]);
    const result = await f.send();
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({
      executionId: f.childExecutionId,
      reused: true
    });
    expect(f.agents.list).not.toHaveBeenCalled();
    expect(f.launchInstances).not.toHaveBeenCalled();
    expect(f.assertSelection).not.toHaveBeenCalled();
    expect(
      f.repository.upsertManagedConversationRuntimeBinding
    ).not.toHaveBeenCalled();
    await f.app.close();
  });

  it("rejects a stale parent generation before a new child can start", async () => {
    const f = setup();
    f.parent.executionGeneration = 4;
    expect((await f.send()).statusCode).toBe(409);
    expect(f.repository.createManagedConversation).not.toHaveBeenCalled();
    await f.app.close();
  });

  it("launches a cold Helper child without looking up or starting a Chief execution", async () => {
    const f = setup(false, true);
    const result = await f.sendCold("Draft the agenda");
    expect(result.statusCode).toBe(202);
    expect(f.repository.getManagedConversationExecution).not.toHaveBeenCalled();
    expect(f.repository.createManagedConversation).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        projectId: f.projectId,
        initialPrompt: "Draft the agenda",
        agentDelegation: expect.objectContaining({
          parentExecutionId: null,
          parentExecutionGeneration: null
        })
      })
    );
    await f.app.close();
  });

  it("recovers the same cold child after the HQ handle later starts Chief", async () => {
    const f = setup(true, true);
    const result = await f.sendCold();
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({
      reused: true,
      executionId: f.childExecutionId
    });
    expect(f.repository.createManagedConversation).toHaveBeenCalledTimes(1);
    await f.app.close();
  });
});
