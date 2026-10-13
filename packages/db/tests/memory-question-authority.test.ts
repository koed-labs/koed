import { randomBytes } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryQuestionRepository } from "../src/memory-question-repository.js";
import { SharedMemoryAuthorizationError } from "../src/shared-memory-repository.js";
import type { MemoryAnswerTeamAuthority } from "../src/memory-answer-team-authority.js";

const mocks = vi.hoisted(() => ({
  assertAuthority: vi.fn(),
  decrypt: vi.fn(),
  persist: vi.fn()
}));
vi.mock("../src/memory-answer-team-authority.js", () => ({
  assertMemoryAnswerTeamAuthorityWithClient: mocks.assertAuthority
}));
vi.mock("../src/encrypted-payload-repository.js", () => ({
  decryptAuthorizedEncryptedFieldPayloadWithClient: mocks.decrypt,
  upsertEncryptedFieldPayloadWithClient: mocks.persist
}));

const authority: MemoryAnswerTeamAuthority = {
  version: 1,
  ownerUserId: "owner",
  recallBoundary: {
    teamId: "team-id",
    teamVersion: 1,
    teamWorkspaceId: "team",
    workspaceVersion: 1,
    membershipVersion: 1,
    workspaceAccessVersion: 1,
    userRowVersion: "1",
    shareGrantIds: []
  },
  grantFingerprints: []
};
const row = (id: string, teamAuthorization: unknown = null) => ({
  id,
  owner_user_id: "owner",
  visibility: "personal",
  origin: "mcp_memory_answer",
  retrieval_scope: "personal",
  team_workspace_id: teamAuthorization ? "team" : null,
  team_authorization: teamAuthorization,
  search_domain: "global",
  project_id: null,
  project_name: null,
  project_path: null,
  session_id: null,
  thread_id: null,
  thread_name: null,
  ask_thread_id: null,
  ask_turn_index: null,
  query: "[koed encrypted memory question]",
  answer_markdown: null,
  error_message: null,
  evidence: null,
  citations: null,
  retrieval: null,
  response: null,
  local_memory_worker: null,
  status: "answered",
  created_at: new Date(),
  updated_at: new Date(),
  answered_at: new Date(),
  attempt_count: 1
});
const setup = (rows: ReturnType<typeof row>[]) => {
  const query = vi.fn().mockResolvedValue({ rows });
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn()
  };
  const pool = { query, connect: vi.fn().mockResolvedValue(client) };
  const repository = createMemoryQuestionRepository(
    pool as unknown as pg.Pool,
    {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    }
  );
  return { repository, pool, client, query };
};

describe("Memory Question frozen Team authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.decrypt.mockResolvedValue({ plaintext: "authorized history" });
  });

  it("denies Team-bound detail to credentials without Team access before decryption", async () => {
    const { repository, pool } = setup([row("team-question", authority)]);
    await expect(
      repository.getMemoryQuestion({ userId: "owner" }, "team-question")
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("checks frozen authority before detail expansion and retains its locks during decryption", async () => {
    const { repository, client } = setup([row("team-question", authority)]);
    await repository.getMemoryQuestion(
      { userId: "owner", allowTeam: true },
      "team-question"
    );
    expect(mocks.assertAuthority).toHaveBeenCalledWith(
      client,
      { userId: "owner", allowTeam: true },
      authority
    );
    expect(mocks.decrypt.mock.calls[0]![0]).toBe(client);
    expect(mocks.assertAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.decrypt.mock.invocationCallOrder[0]!
    );
    expect(client.query).toHaveBeenLastCalledWith("commit");
  });

  it("filters revoked Team results without suppressing Personal or legacy history", async () => {
    const { repository, query } = setup([]);
    query
      .mockResolvedValueOnce({
        rows: [row("revoked", authority), row("personal"), row("legacy")]
      })
      .mockResolvedValue({ rows: [] });
    mocks.assertAuthority.mockRejectedValue(
      new SharedMemoryAuthorizationError()
    );
    const listed = await repository.listMemoryQuestions(
      { userId: "owner", allowTeam: true },
      { query: "authorized" }
    );
    expect(listed.map((question) => question.id)).toEqual([
      "personal",
      "legacy"
    ]);
    expect(mocks.decrypt).toHaveBeenCalledTimes(2);
  });

  it("propagates unknown authorization failures without attempting decryption", async () => {
    const { repository } = setup([row("team-question", authority)]);
    mocks.assertAuthority.mockRejectedValue(new Error("database unavailable"));
    await expect(
      repository.listMemoryQuestions({ userId: "owner", allowTeam: true })
    ).rejects.toThrow("database unavailable");
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("overlaps Personal and Team hydration while preserving history order", async () => {
    const rows = [row("team", authority), row("personal"), row("legacy")];
    const { repository } = setup(rows);
    const releases = new Map<string, () => void>();
    let started!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.decrypt.mockImplementation(
      async (_client, _actor, _provider, reference: { sourceId: string }) => {
        await new Promise<void>((resolve) => {
          releases.set(reference.sourceId, resolve);
          if (releases.size === rows.length) started();
        });
        return { plaintext: reference.sourceId };
      }
    );
    const listing = repository.listMemoryQuestions(
      { userId: "owner", allowTeam: true },
      { limit: rows.length }
    );
    await allStarted;
    releases.get("legacy")!();
    releases.get("personal")!();
    releases.get("team")!();
    expect((await listing).map((question) => question.id)).toEqual([
      "team",
      "personal",
      "legacy"
    ]);
  });

  it("bounds active history hydrations on large pages", async () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(`question-${index}`, index % 2 ? authority : null)
    );
    const { repository } = setup(rows);
    let active = 0;
    let peak = 0;
    mocks.decrypt.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { plaintext: "history" };
    });
    const listed = await repository.listMemoryQuestions(
      { userId: "owner", allowTeam: true },
      { limit: rows.length }
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(listed.map((question) => question.id)).toEqual(
      rows.map((question) => question.id)
    );
  });

  it("propagates decryption failures after settling concurrent hydration", async () => {
    const { repository } = setup([row("broken"), row("valid", authority)]);
    let validFinished = false;
    mocks.decrypt.mockImplementation(
      async (_client, _actor, _provider, reference: { sourceId: string }) => {
        if (reference.sourceId === "broken") throw new Error("payload corrupt");
        await new Promise((resolve) => setTimeout(resolve, 0));
        validFinished = true;
        return { plaintext: "history" };
      }
    );
    await expect(
      repository.listMemoryQuestions({ userId: "owner", allowTeam: true })
    ).rejects.toThrow("payload corrupt");
    expect(validFinished).toBe(true);
  });

  it("writes final questions through the caller transaction and returns their identity", async () => {
    const { repository, client } = setup([]);
    client.query.mockResolvedValueOnce({ rows: [row("final")] });
    expect(
      await repository.createFinalMemoryQuestionWithClient(
        client as unknown as pg.PoolClient,
        { userId: "owner" },
        {
          idempotencyKey: "task-final",
          query: "question",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "answer"
        }
      )
    ).toEqual({ id: "final" });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.persist.mock.calls.every((call) => call[0] === client)).toBe(
      true
    );
  });

  it.each([true, false])(
    "rejects an idempotent final question belonging to a different Team boundary with strict option %s",
    async (strictIdempotencyBoundary) => {
      const { repository, client } = setup([]);
      client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [row("existing", authority)] });
      await expect(
        repository.createFinalMemoryQuestionWithClient(
          client as unknown as pg.PoolClient,
          { userId: "owner" },
          {
            idempotencyKey: "task-final",
            query: "question",
            searchDomain: "global",
            status: "answered",
            answerMarkdown: "answer"
          },
          { strictIdempotencyBoundary }
        )
      ).rejects.toThrow("idempotency boundary does not match");
      expect(mocks.persist).not.toHaveBeenCalled();
    }
  );

  it("revalidates the current authority for an idempotent Team final question", async () => {
    const { repository, client } = setup([]);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row("existing", authority)] });
    mocks.assertAuthority
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SharedMemoryAuthorizationError());
    await expect(
      repository.createFinalMemoryQuestionWithClient(
        client as unknown as pg.PoolClient,
        { userId: "owner" },
        {
          idempotencyKey: "task-final",
          teamWorkspaceId: "team",
          query: "question",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "answer"
        },
        { teamAuthority: authority }
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("preserves legacy final-question retries while keeping task completion workspace-bound", async () => {
    const legacy = { ...row("legacy-final"), team_workspace_id: "legacy-team" };
    const { repository, client } = setup([legacy]);
    const input = {
      idempotencyKey: "legacy-final",
      query: "retry payload",
      searchDomain: "global" as const,
      status: "error" as const,
      errorMessage: "retry outcome"
    };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [legacy] });
    expect(
      await repository.createFinalMemoryQuestion({ userId: "owner" }, input)
    ).toMatchObject({ id: "legacy-final", teamWorkspaceId: "legacy-team" });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [legacy] });
    await expect(
      repository.createFinalMemoryQuestionWithClient(
        client as unknown as pg.PoolClient,
        { userId: "owner" },
        input
      )
    ).rejects.toThrow("idempotency boundary does not match");
  });

  it.each([
    { query: "different query" },
    { project_id: "different-project" },
    { session_id: "different-session" },
    { search_domain: "session" },
    { answer_markdown: "forged answer" }
  ])("rejects mismatched task history content: %j", async (changed) => {
    const existing = {
      ...row("existing"),
      query: "question",
      answer_markdown: "answer",
      ...changed
    };
    const { repository, client } = setup([]);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existing] });
    await expect(
      repository.createFinalMemoryQuestionWithClient(
        client as unknown as pg.PoolClient,
        { userId: "owner" },
        {
          idempotencyKey: "task-final",
          query: "question",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "answer"
        }
      )
    ).rejects.toThrow("idempotency content does not match");
  });

  it("reuses matching encrypted final content within the caller's transaction", async () => {
    const existing = {
      ...row("existing"),
      answer_markdown: "[koed encrypted memory question]"
    };
    const { repository, client } = setup([]);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existing] });
    mocks.decrypt.mockImplementation(
      async (
        _client,
        _actor,
        _provider,
        reference: { sourceColumn: string }
      ) => ({
        plaintext: reference.sourceColumn === "query" ? "question" : "answer"
      })
    );
    expect(
      await repository.createFinalMemoryQuestionWithClient(
        client as unknown as pg.PoolClient,
        { userId: "owner" },
        {
          idempotencyKey: "task-final",
          query: "question",
          searchDomain: "global",
          status: "answered",
          answerMarkdown: "answer"
        }
      )
    ).toEqual({ id: "existing" });
    expect(mocks.decrypt.mock.calls.every((call) => call[0] === client)).toBe(
      true
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
