import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recurringAgentTasksClient,
  recurringTaskClientAlias
} from "./recurring-agent-tasks-client";

const agentId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const occurrenceId = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";
const now = "2026-10-15T10:00:00.000Z";

const task = {
  id: taskId,
  agentId,
  title: "Morning review",
  prompt: "Review the open work and report blockers.",
  schedule: { kind: "interval" as const, everyMinutes: 60, anchorAt: now },
  context: { projectId: null, contextKind: "independent" as const },
  execution: {
    provider: "codex" as const,
    aiClientInstanceId: "codex-instance",
    targetDeviceId: "device-one",
    model: "gpt-6-sol",
    reasoningEffort: null,
    permissionMode: "supervised" as const
  },
  status: "paused" as const,
  revision: 1,
  nextRunAt: null,
  lastRunAt: null,
  lastErrorCode: null,
  createdAt: now,
  updatedAt: now
};

const occurrence = {
  id: occurrenceId,
  taskId,
  taskRevision: 1,
  trigger: "manual" as const,
  scheduledAt: now,
  status: "reserved" as const,
  conversationId,
  messageId: null,
  deliveryId: null,
  executionId: null,
  errorCode: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recurring Agent task client", () => {
  it("sends the local or hosted AI Client alias for the chosen target mode", () => {
    const instance = {
      instanceId: "local-instance",
      hostedInstanceId: "hosted-publication"
    };

    expect(recurringTaskClientAlias(instance, false)).toBe("local-instance");
    expect(recurringTaskClientAlias(instance, true)).toBe("hosted-publication");
    expect(recurringTaskClientAlias({ instanceId: "local-only" }, true)).toBe(
      "local-only"
    );
  });

  it("lists owner tasks through the scoped Studio gateway", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ tasks: [task] }));
    await expect(recurringAgentTasksClient.list(agentId)).resolves.toEqual([
      task
    ]);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      `/studio-api/personal-agents/${agentId}/recurring-tasks?limit=10`
    );
  });

  it("loads bounded task pages with the UUID cursor", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ tasks: [task], nextCursor: taskId }));

    await expect(
      recurringAgentTasksClient.listPage(agentId, occurrenceId)
    ).resolves.toEqual({ tasks: [task], nextCursor: taskId });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      `/studio-api/personal-agents/${agentId}/recurring-tasks?limit=10&before=${occurrenceId}`
    );
  });

  it("uses CSRF for local writes and preserves the owner-selected execution snapshot", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input) === "/studio-api/github/session")
          return Response.json({ csrfToken: "studio-csrf" });
        expect(String(input)).toBe(
          `/studio-api/personal-agents/${agentId}/recurring-tasks`
        );
        expect(new Headers(init?.headers).get("x-studio-csrf")).toBe(
          "studio-csrf"
        );
        const body = JSON.parse(String(init?.body));
        expect(body.execution).toEqual(task.execution);
        expect(body.requestId).toBe(requestId);
        return Response.json({ task }, { status: 201 });
      });

    await expect(
      recurringAgentTasksClient.create(agentId, {
        title: task.title,
        prompt: task.prompt,
        schedule: task.schedule,
        context: task.context,
        execution: task.execution,
        requestId
      })
    ).resolves.toEqual(task);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the hosted routes without a local CSRF lookup", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/studio/agents" }
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ task }));
    await expect(recurringAgentTasksClient.get(taskId)).resolves.toEqual(task);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/v1/recurring-agent-tasks/${taskId}`
    );
  });

  it("keeps control, manual-run idempotency, and bounded history on their scoped routes", async () => {
    const paths: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const path = String(input);
        if (path.endsWith("/studio-api/github/session"))
          return Response.json({ csrfToken: "csrf" });
        paths.push(path);
        if (path.endsWith("/control")) return Response.json({ task });
        if (path.endsWith("/run-now")) return Response.json({ occurrence });
        return Response.json({ occurrences: [occurrence], nextCursor: null });
      });

    await recurringAgentTasksClient.control(taskId, {
      action: "resume",
      expectedRevision: 1,
      activationConsent: true
    });
    await recurringAgentTasksClient.runNow(taskId, requestId, 1);
    await recurringAgentTasksClient.occurrences(taskId, occurrenceId);

    expect(paths).toEqual([
      `/studio-api/recurring-agent-tasks/${taskId}/control`,
      `/studio-api/recurring-agent-tasks/${taskId}/run-now`,
      `/studio-api/recurring-agent-tasks/${taskId}/occurrences?limit=50&before=${occurrenceId}`
    ]);
    const runBody = JSON.parse(String(fetchMock.mock.calls.at(-2)?.[1]?.body));
    expect(runBody).toEqual({ requestId, expectedRevision: 1 });
  });

  it("does not surface arbitrary upstream error text or accept an invalid cursor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: "/Users/private/provider/credential leaked" },
        { status: 503 }
      )
    );
    await expect(recurringAgentTasksClient.get(taskId)).rejects.toThrow(
      "Recurring tasks are unavailable right now."
    );
    await expect(
      recurringAgentTasksClient.occurrences(taskId, "not-a-uuid")
    ).rejects.toThrow("history cursor is invalid");
  });
});
