import { describe, expect, it, vi } from "vitest";
import {
  buildTeamSummaryDraftPrompt,
  TEAM_SUMMARY_DRAFT_MAX_SOURCE_CHARS
} from "./team-summary-draft.js";

const input = {
  ownerUserId: "owner",
  executionId: "execution",
  teamId: "team",
  requestId: "request",
  jobId: "job",
  agentId: "agent"
};
function fixture() {
  const request = {
    ownerId: "owner",
    status: "accepted",
    jobId: "job",
    agentId: "agent"
  };
  const job = {
    ownerUserId: "owner",
    conversationId: "execution",
    state: "succeeded",
    title: "Review README"
  };
  const repository = {
    getAcceptedRequestForExecution: vi.fn(async () => request),
    getPersonalAgentExecutionJob: vi.fn(async () => job),
    getPersonalAgentTurnOutput: vi.fn(async () => "Review completed")
  };
  return { request, job, repository };
}
const run = (repository: ReturnType<typeof fixture>["repository"]) =>
  buildTeamSummaryDraftPrompt({
    ...input,
    repository: repository as unknown as Parameters<
      typeof buildTeamSummaryDraftPrompt
    >[0]["repository"]
  });

describe("owner-reviewed Team summary drafting", () => {
  it("checks originating request authority and bounds quoted saved output without publishing", async () => {
    const { repository } = fixture();
    repository.getPersonalAgentTurnOutput.mockResolvedValue("x".repeat(20_000));
    const prompt = await run(repository);
    expect(repository.getAcceptedRequestForExecution).toHaveBeenCalledWith(
      { userId: "owner" },
      { teamId: "team", requestId: "request", executionId: "execution" }
    );
    expect(repository.getPersonalAgentTurnOutput).toHaveBeenCalledWith(
      { userId: "owner" },
      { jobId: "job" }
    );
    expect(prompt).toContain('"sourceTruncated":true');
    expect(prompt).toContain("quoted untrusted source data");
    expect(prompt.length).toBeLessThan(
      TEAM_SUMMARY_DRAFT_MAX_SOURCE_CHARS + 1_500
    );
  });
  it.each(["awaiting_owner", "withdrawn", "unavailable"])(
    "rejects a %s request before reading private Job output",
    async (status) => {
      const { request, repository } = fixture();
      request.status = status;
      await expect(run(repository)).rejects.toMatchObject({ statusCode: 403 });
      expect(repository.getPersonalAgentExecutionJob).not.toHaveBeenCalled();
      expect(repository.getPersonalAgentTurnOutput).not.toHaveBeenCalled();
    }
  );
  it("rejects switching the Agent for the request's draft", async () => {
    const { request, repository } = fixture();
    request.agentId = "other";
    await expect(run(repository)).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.getPersonalAgentExecutionJob).not.toHaveBeenCalled();
  });
  it("rejects cross-owner or cross-execution Jobs", async () => {
    const { job, repository } = fixture();
    job.ownerUserId = "other";
    await expect(run(repository)).rejects.toMatchObject({ statusCode: 403 });
    job.ownerUserId = "owner";
    job.conversationId = "other";
    await expect(run(repository)).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.getPersonalAgentTurnOutput).not.toHaveBeenCalled();
  });
  it("rejects active work and preserves an unsuccessful terminal outcome", async () => {
    const { job, repository } = fixture();
    job.state = "waiting";
    await expect(run(repository)).rejects.toMatchObject({ statusCode: 409 });
    job.state = "failed";
    expect(await run(repository)).toContain('"outcome":"failed"');
  });
});

describe("native Team request summary source", () => {
  function nativeFixture() {
    const request = {
      ownerId: "owner",
      status: "accepted",
      jobId: null,
      agentId: "agent"
    };
    const binding = {
      requestId: "request",
      teamId: "team",
      executionId: "execution",
      commandId: "accepted-command",
      agentId: "agent",
      status: "accepted"
    };
    const command = {
      id: "accepted-command",
      ownerUserId: "owner",
      executionId: "execution",
      commandKind: "prompt",
      state: "completed"
    };
    const repository = {
      getAcceptedRequestForExecution: vi.fn(async () => request),
      getAcceptedRequestNativeBinding: vi.fn(async () => binding),
      getManagedConversationCommand: vi.fn(async () => command),
      getManagedConversationPromptHistoryAnswer: vi.fn(async () => ({
        commandId: "accepted-command",
        assistantOutput: { text: "Accepted request output", truncated: false }
      })),
      getPersonalAgentExecutionJob: vi.fn(),
      getPersonalAgentTurnOutput: vi.fn()
    };
    const runNative = () =>
      buildTeamSummaryDraftPrompt({
        ...input,
        jobId: undefined,
        repository: repository as unknown as Parameters<
          typeof buildTeamSummaryDraftPrompt
        >[0]["repository"]
      });
    return { request, binding, command, repository, runNative };
  }
  it("reads only the accepted native command, without legacy Jobs or later private turns", async () => {
    const { repository, runNative } = nativeFixture();
    const prompt = await runNative();
    expect(
      repository.getManagedConversationPromptHistoryAnswer
    ).toHaveBeenCalledWith(
      { userId: "owner" },
      { executionId: "execution", commandId: "accepted-command" }
    );
    expect(repository.getPersonalAgentExecutionJob).not.toHaveBeenCalled();
    expect(repository.getPersonalAgentTurnOutput).not.toHaveBeenCalled();
    expect(prompt).toContain("Accepted request output");
    expect(prompt).toContain('"outcome":"completed"');
    expect(prompt).toContain("owner will review/edit");
  });
  it.each(["awaiting_owner", "withdrawn", "unavailable"])(
    "rejects %s before reading native output",
    async (status) => {
      const { request, repository, runNative } = nativeFixture();
      request.status = status;
      await expect(runNative()).rejects.toMatchObject({ statusCode: 403 });
      expect(repository.getAcceptedRequestNativeBinding).not.toHaveBeenCalled();
      expect(repository.getManagedConversationCommand).not.toHaveBeenCalled();
    }
  );
  it.each(["queued", "dispatching", "indeterminate", "blocked"])(
    "does not summarize %s as completed",
    async (state) => {
      const { command, repository, runNative } = nativeFixture();
      command.state = state;
      await expect(runNative()).rejects.toMatchObject({ statusCode: 409 });
      expect(
        repository.getManagedConversationPromptHistoryAnswer
      ).not.toHaveBeenCalled();
    }
  );
  it.each(["ownerUserId", "executionId", "id", "commandKind"] as const)(
    "rejects another %s before reading private output",
    async (key) => {
      const { command, repository, runNative } = nativeFixture();
      command[key] = "other";
      await expect(runNative()).rejects.toMatchObject({ statusCode: 403 });
      expect(
        repository.getManagedConversationPromptHistoryAnswer
      ).not.toHaveBeenCalled();
    }
  );
  it("rechecks request binding and refuses a different Agent", async () => {
    const { binding, repository, runNative } = nativeFixture();
    binding.agentId = "other";
    await expect(runNative()).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.getManagedConversationCommand).not.toHaveBeenCalled();
  });
  it("retains failure without reading unrelated output", async () => {
    const { command, repository, runNative } = nativeFixture();
    command.state = "failed";
    expect(await runNative()).toContain('"outcome":"failed"');
    expect(
      repository.getManagedConversationPromptHistoryAnswer
    ).not.toHaveBeenCalled();
  });
  it("bounds native output and preserves its truncation marker", async () => {
    const { repository, runNative } = nativeFixture();
    repository.getManagedConversationPromptHistoryAnswer.mockResolvedValue({
      commandId: "accepted-command",
      assistantOutput: { text: "x".repeat(20_000), truncated: true }
    });
    const prompt = await runNative();
    expect(prompt).toContain('"sourceTruncated":true');
    expect(prompt.length).toBeLessThan(
      TEAM_SUMMARY_DRAFT_MAX_SOURCE_CHARS + 1_500
    );
  });
});
