import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodePersonalAgentHistoryCursor,
  encodePersonalAgentHistoryCursor,
  mapPersonalAgentNativeHistoryRow,
  personalAgentNativeDeliveryState
} from "./personal-agent-native-history.js";

describe("Personal Agent native history projection", () => {
  it("round trips source-aware microsecond cursors and reads old Job cursors", () => {
    const cursor = {
      createdAt: "2026-10-14 10:30:00.123456+00",
      id: randomUUID(),
      source: "delivery" as const
    };

    expect(
      decodePersonalAgentHistoryCursor(encodePersonalAgentHistoryCursor(cursor))
    ).toEqual(cursor);
    expect(
      decodePersonalAgentHistoryCursor(
        Buffer.from(`${cursor.createdAt}\u0000${cursor.id}`).toString(
          "base64url"
        )
      )
    ).toEqual({ ...cursor, source: "job" });
  });

  it("projects real delivery outcomes to the existing history display shape", () => {
    const row = {
      id: randomUUID(),
      owner_user_id: randomUUID(),
      conversation_id: randomUUID(),
      command_id: randomUUID(),
      root_title: "Conversation title",
      project_id: "project-one",
      agent_id: randomUUID(),
      agent_version: 4,
      agent_name: "Historical name",
      status: "completed" as const,
      execution_id: randomUUID(),
      created_at: new Date("2026-10-14T10:00:00.000Z"),
      created_at_cursor: "2026-10-14 10:00:00+00",
      started_at: new Date("2026-10-14T10:00:01.000Z"),
      completed_at: new Date("2026-10-14T10:01:00.000Z"),
      updated_at: new Date("2026-10-14T10:01:00.000Z"),
      provider: "codex",
      model: "gpt-5.6",
      ai_client_instance_id: "codex.default",
      reasoning_effort: "high",
      permission_mode: "supervised" as const
    };

    const projected = mapPersonalAgentNativeHistoryRow(row, {
      goal: "Review the new routing behavior"
    });

    expect(projected).toMatchObject({
      id: row.id,
      ownerUserId: row.owner_user_id,
      conversationId: row.conversation_id,
      commandId: row.command_id,
      title: "Review the new routing behavior",
      projectId: "project-one",
      attribution: {
        kind: "agent",
        agentId: row.agent_id,
        agentVersion: 4
      },
      state: "succeeded",
      goal: "Review the new routing behavior",
      agentName: "Historical name",
      attempts: [],
      latestAttempt: null,
      executionSettings: {
        provider: "codex",
        model: "gpt-5.6",
        aiClientInstanceId: "codex.default",
        reasoningEffort: "high",
        permissionMode: "supervised"
      }
    });
    expect(projected).not.toHaveProperty("projectName");
    expect(personalAgentNativeDeliveryState("uncertain")).toBe("waiting");
    expect(personalAgentNativeDeliveryState("skipped")).toBe("canceled");
    expect(personalAgentNativeDeliveryState("blocked")).toBe("waiting");
    expect(personalAgentNativeDeliveryState("canceled")).toBe("canceled");
    expect(personalAgentNativeDeliveryState("failed")).toBe("failed");
    expect(personalAgentNativeDeliveryState("running")).toBe("running");
    expect(personalAgentNativeDeliveryState("queued")).toBe("queued");
    expect(personalAgentNativeDeliveryState("starting")).toBe("queued");
    const queued = mapPersonalAgentNativeHistoryRow(
      {
        ...row,
        status: "queued",
        started_at: null,
        completed_at: null
      },
      { goal: null }
    );
    expect(queued.attempts).toEqual([]);
    expect(queued.latestAttempt).toBeNull();
    expect(queued.executionSettings).toEqual(projected.executionSettings);
    for (const status of [
      "canceled",
      "skipped",
      "blocked",
      "uncertain"
    ] as const) {
      const unresolved = mapPersonalAgentNativeHistoryRow(
        { ...row, status },
        { goal: null }
      );
      expect(unresolved.state).not.toBe("succeeded");
      expect(unresolved.attempts).toEqual([]);
      expect(unresolved.latestAttempt).toBeNull();
    }
  });
});
