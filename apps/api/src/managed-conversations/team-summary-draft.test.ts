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
