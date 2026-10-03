import { describe, expect, it } from "vitest";
import {
  classifyHomeNotification,
  isTeamMessageNotificationCandidate,
  studioNotificationCopy,
  studioNotificationIntentSchema
} from "./studio-notifications.js";

describe("Studio notification contract", () => {
  const base = {
    version: 1 as const,
    source: "home" as const,
    accountScope: "opaque-scope",
    backendId: null,
    sourceEventId: "runtime:agent-1",
    sourceRevision: "v4"
  };

  it("accepts only content-free source references", () => {
    expect(studioNotificationIntentSchema.parse(base)).toEqual(base);
    expect(
      studioNotificationIntentSchema.safeParse({ ...base, title: "private" })
        .success
    ).toBe(false);
    expect(
      studioNotificationIntentSchema.safeParse({
        ...base,
        source: "team_overview",
        messageId: undefined
      }).success
    ).toBe(false);
  });

  it("classifies only high-signal Home records", () => {
    expect(
      classifyHomeNotification({
        source: "managed_runtime_item",
        kind: "question",
        state: "blocked"
      })
    ).toBe("agent_input");
    expect(
      classifyHomeNotification({
        source: "managed_runtime_item",
        kind: "approval",
        state: "review"
      })
    ).toBe("agent_approval");
    expect(
      classifyHomeNotification({
        source: "personal_agent_job",
        kind: "intervention",
        state: "blocked"
      })
    ).toBe("agent_job_failed");
    expect(
      classifyHomeNotification({
        source: "managed_execution",
        kind: "intervention",
        state: "blocked"
      })
    ).toBeNull();
    expect(
      classifyHomeNotification({
        source: "personal_agent_job",
        kind: "job_review",
        state: "review"
      })
    ).toBeNull();
  });

  it("leaves Team messages as candidates until main rechecks the message", () => {
    expect(
      isTeamMessageNotificationCandidate({
        source: "message_attention",
        kind: "message",
        state: "recent"
      })
    ).toBe(true);
    expect(
      isTeamMessageNotificationCandidate({
        source: "team_job_outcome",
        kind: "job_outcome",
        state: "recent"
      })
    ).toBe(false);
  });

  it("uses fixed generic copy without event content", () => {
    expect(studioNotificationCopy("agent_input")).toEqual({
      title: "Koed Studio",
      body: "An Agent needs your input."
    });
    expect(studioNotificationCopy("mention").body).toBe("You were mentioned.");
  });
});
