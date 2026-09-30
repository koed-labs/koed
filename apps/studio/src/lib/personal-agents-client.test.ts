import { afterEach, describe, expect, it, vi } from "vitest";
import {
  personalAgentsHttpAdapter,
  personalAgentDraftKey,
  uniqueAgentCloneName,
  type PersonalAgent
} from "./personal-agents-client";

const agent: PersonalAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  name: "Bob",
  role: "reviewer",
  soul: "Custom soul",
  lifecycle: "active",
  defaultProvider: "codex",
  defaultModel: "gpt-5.6",
  defaultReasoningEffort: "high",
  currentVersion: 3,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  retiredAt: null,
  projects: [],
  runningNow: [],
  jobs: [],
  highlights: [],
  stats: { projects: 0, runningNow: 0, jobsLogged: 0 },
  jobsHasMore: false,
  jobsNextCursor: null,
  activityLoaded: true,
  sourceTemplateId: null,
  sourceTemplateVersion: null
};

const values = {
  name: "Bob",
  role: "reviewer",
  soul: "Custom soul",
  preferredModel: "codex:gpt-5.6",
  preferredEffort: "high",
  sourceTemplateId: null,
  sourceTemplateVersion: null,
  avatar: { seed: 7, spec: { seed: 7 }, image: "data:image/png;base64,bob" }
};

const optionalDefaults = {
  ...values,
  preferredModel: null,
  preferredEffort: null
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("personal agents HTTP adapter", () => {
  it("writes explicit defaults, bounded avatar JSON, request ID, and version", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input).endsWith("/studio-api/github/session")) {
          return Response.json({ csrfToken: "csrf" });
        }
        expect(String(input)).toBe("/studio-api/personal-agents/Bob");
        expect(init?.method).toBe("PATCH");
        expect(new Headers(init?.headers).get("x-studio-csrf")).toBe("csrf");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          name: "Bob",
          role: "reviewer",
          soulInstructions: "Custom soul",
          defaultProvider: "codex",
          defaultModel: "gpt-5.6",
          defaultReasoningEffort: "high",
          expectedVersion: 3
        });
        expect(body.requestId).toBe("retry-safe-request");
        expect(JSON.parse(body.avatarReference)).toEqual({
          seed: values.avatar.seed,
          spec: values.avatar.spec
        });
        return Response.json({ agent });
      });

    await personalAgentsHttpAdapter.update("Bob", 3, values, {
      requestId: "retry-safe-request"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps independently unavailable counts and bounded history explicit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        agent,
        soulInstructions: agent.soul,
        stats: {
          totalJobs: 2,
          totalAttempts: 3,
          runningAttemptsPersisted: 1,
          runningAttemptsMayBeStale: true,
          runningAttemptsObservedAt: null,
          jobsHasMore: 1,
          projectsAvailable: false
        },
        projects: [],
        runningNow: [],
        jobs: [
          {
            id: "job-1",
            title: "Review",
            goal: "Review the billing implementation and report risks.",
            conversationId: "11111111-1111-4111-8111-111111111111",
            state: "succeeded",
            createdAt: "2026-09-20T12:00:00.000Z",
            updatedAt: "2026-09-20T12:05:00.000Z",
            attempts: [
              {
                id: "attempt-1",
                attemptNumber: 1,
                provider: "codex",
                model: "gpt-5.6",
                aiClientInstanceId: "instance-1",
                reasoningEffort: "high",
                status: "succeeded",
                outcome: "done",
                startedAt: "2026-09-20T12:00:00.000Z",
                completedAt: "2026-09-20T12:05:00.000Z"
              }
            ],
            latestAttempt: {
              id: "attempt-1",
              attemptNumber: 1,
              provider: "codex",
              model: "gpt-5.6",
              aiClientInstanceId: "instance-1",
              reasoningEffort: "high",
              status: "succeeded",
              outcome: "done",
              startedAt: "2026-09-20T12:00:00.000Z",
              completedAt: "2026-09-20T12:05:00.000Z"
            }
          }
        ],
        highlights: [],
        jobsHasMore: true,
        jobsNextCursor: "next-page"
      })
    );

    const result = await personalAgentsHttpAdapter.get(agent.id);
    expect(result.stats).toEqual({
      projects: null,
      runningNow: null,
      jobsLogged: 2
    });
    expect(result.jobsHasMore).toBe(true);
    expect(result.jobsNextCursor).toBe("next-page");
    expect(result.jobs[0]).toMatchObject({
      goal: "Review the billing implementation and report risks.",
      conversationId: "11111111-1111-4111-8111-111111111111",
      provider: "codex",
      model: "gpt-5.6",
      effort: "high",
      attempts: [
        expect.objectContaining({
          provider: "codex",
          model: "gpt-5.6",
          effort: "high",
          instanceId: "instance-1"
        })
      ]
    });
  });

  it("rejects malformed model selections before a write", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      personalAgentsHttpAdapter.create({ ...values, preferredModel: "broken" })
    ).rejects.toThrow("Choose a supported model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes optional model defaults as null and allows saved unavailable defaults", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/studio-api/github/session")) {
        return Response.json({ csrfToken: "csrf" });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ agent });
    });

    await personalAgentsHttpAdapter.create(optionalDefaults);
    await personalAgentsHttpAdapter.create({
      ...values,
      preferredModel: "offline:retired-model",
      preferredEffort: "high"
    });
    expect(bodies[0]).toMatchObject({
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null
    });
    expect(bodies[1]).toMatchObject({
      defaultProvider: "offline",
      defaultModel: "retired-model",
      defaultReasoningEffort: "high"
    });
  });

  it("restores a retired Agent through the versioned restore route", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/studio-api/github/session")) {
        return Response.json({ csrfToken: "csrf" });
      }
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ agent });
    });

    await personalAgentsHttpAdapter.restore("agent-id", 4, {
      requestId: "restore-request"
    });
    expect(calls).toEqual([
      {
        url: "/studio-api/personal-agents/agent-id/restore",
        body: { expectedVersion: 4, requestId: "restore-request" }
      }
    ]);
  });

  it("uses authenticated hosted routes for the complete Agent workflow", async () => {
    vi.stubGlobal("window", { location: { pathname: "/studio/agents" } });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.startsWith("/studio-api/")) {
          throw new Error("Hosted Studio must not call the local gateway.");
        }
        if (url === "/v1/managed-conversations/access") {
          return Response.json({
            user: { id: "hosted-owner" },
            backendId: "hosted-backend"
          });
        }
        if (url === "/v1/personal-agents") {
          return init?.method === "POST"
            ? Response.json({ agent })
            : Response.json({ agents: [agent] });
        }
        if (url === "/v1/personal-agents/capabilities") {
          return Response.json({ models: [] });
        }
        return Response.json({ agent });
      });

    await personalAgentsHttpAdapter.list();
    await personalAgentsHttpAdapter.get(agent.id);
    await personalAgentsHttpAdapter.capabilities();
    await personalAgentsHttpAdapter.create(values, { requestId: "create-id" });
    await personalAgentsHttpAdapter.update(agent.id, 3, values, {
      requestId: "update-id"
    });
    await personalAgentsHttpAdapter.retire(agent.id, 4, {
      requestId: "retire-id"
    });
    await personalAgentsHttpAdapter.restore(agent.id, 5, {
      requestId: "restore-id"
    });
    await expect(personalAgentsHttpAdapter.draftScope?.()).resolves.toEqual({
      ownerId: "hosted-owner",
      backendId: "hosted-backend"
    });

    const hostedPaths = calls
      .map(({ url }) => url)
      .filter((url) => url.startsWith("/v1/"));
    expect(hostedPaths).toEqual([
      "/v1/personal-agents",
      `/v1/personal-agents/${agent.id}`,
      "/v1/personal-agents/capabilities",
      "/v1/personal-agents",
      `/v1/personal-agents/${agent.id}`,
      `/v1/personal-agents/${agent.id}/retire`,
      `/v1/personal-agents/${agent.id}/restore`,
      "/v1/managed-conversations/access"
    ]);
    expect(calls.every(({ url }) => !url.startsWith("/studio-api/"))).toBe(
      true
    );
    for (const { url, init } of calls) {
      expect(init?.credentials).toBe("include");
      expect(init?.redirect).toBe("error");
      if (init?.method && init.method !== "GET") {
        expect(url.startsWith("/v1/")).toBe(true);
        expect(new Headers(init.headers).has("x-studio-csrf")).toBe(false);
        expect(new URL(url, "https://studio.example").origin).toBe(
          "https://studio.example"
        );
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("uses hosted Agent detail routes at the basePath root without a trailing slash", async () => {
    vi.stubGlobal("window", { location: { pathname: "/studio" } });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ agent }));

    await expect(personalAgentsHttpAdapter.get(agent.id)).resolves.toEqual(
      agent
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/personal-agents/${agent.id}`,
      expect.objectContaining({ credentials: "include", cache: "no-store" })
    );
  });

  it("reads the Agent name captured in each Job profile version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        agent,
        jobs: [
          {
            id: "job-1",
            title: "Review",
            state: "succeeded",
            createdAt: 1_700_000_000_000,
            agentName: "Historical Bob",
            attribution: { agentVersion: 2 }
          }
        ]
      })
    );
    const result = await personalAgentsHttpAdapter.get(agent.id);
    expect(result.jobs[0]).toMatchObject({
      agentName: "Historical Bob",
      agentVersion: 2
    });
  });
});

describe("Agent clone naming", () => {
  it("creates a unique editable copy name", () => {
    expect(uniqueAgentCloneName("Bob", ["Bob"])).toBe("Bob copy");
    expect(uniqueAgentCloneName("Bob", ["Bob copy", "BOB COPY 2"])).toBe(
      "Bob copy 3"
    );
  });
});

describe("personal agent draft scope", () => {
  it("uses authenticated owner and backend identity for the local key", () => {
    expect(
      personalAgentDraftKey(
        { ownerId: "user/1", backendId: "https://koed.local" },
        "edit:agent 1"
      )
    ).toBe(
      "koed.studio.personal-agent-draft.v1:https%3A%2F%2Fkoed.local:user%2F1:edit%3Aagent%201"
    );
    expect(personalAgentDraftKey(null, "create")).toBeNull();
  });

  it("resolves the authenticated draft scope through the Studio gateway", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ user: { id: "owner-1" }, backendId: "backend-1" })
    );
    await expect(personalAgentsHttpAdapter.draftScope?.()).resolves.toEqual({
      ownerId: "owner-1",
      backendId: "backend-1"
    });
    expect(fetch).toHaveBeenCalledWith(
      "/studio-api/managed-conversations/access",
      expect.objectContaining({ cache: "no-store" })
    );
  });
});
