import { afterEach, describe, expect, it, vi } from "vitest";
import {
  personalAgentsHttpAdapter,
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

afterEach(() => {
  vi.restoreAllMocks();
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

  it("rejects unsupported composite model selections before a write", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      personalAgentsHttpAdapter.create({ ...values, preferredModel: null })
    ).rejects.toThrow("Choose a supported model");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
