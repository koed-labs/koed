import { describe, expect, it } from "vitest";
import {
  floatingKinActivitySchema,
  floatingKinEvidenceSchema,
  floatingKinSummaryRequestSchema,
  floatingKinSummarySchema
} from "./floating-kin.js";

const sessionId = "f7a5ecbb-8fcd-465c-b02a-0dfcf1eb2437";
const occurredAt = "2026-11-18T15:01:00.000Z";
const source = {
  id: "375d7375-6008-4f6c-9cc5-f9df2ff51dac",
  sessionId,
  kind: "conversation_item",
  occurredAt
};
const activity = {
  sessionId,
  projectId: null,
  client: "pi",
  lastActivityAt: occurredAt
};

describe("Floating Kin contracts", () => {
  it("only accepts fixed actions and a Captured Session target", () => {
    const request = { sessionId, action: "conversation" };
    expect(floatingKinSummaryRequestSchema.parse(request)).toEqual(request);
    const project = { sessionId, action: "project", projectId: source.id };
    expect(floatingKinSummaryRequestSchema.parse(project)).toEqual(project);
    expect(
      floatingKinSummaryRequestSchema.safeParse({
        sessionId,
        action: "project"
      }).success
    ).toBe(false);
    expect(
      floatingKinSummaryRequestSchema.safeParse({
        ...request,
        prompt: "custom"
      }).success
    ).toBe(false);
    expect(
      floatingKinSummaryRequestSchema.safeParse({
        ...request,
        action: "resume"
      }).success
    ).toBe(false);
  });

  it("rejects extra activity metadata and non-timestamps", () => {
    const parse = (conversation: unknown) =>
      floatingKinActivitySchema.safeParse({
        conversations: [conversation],
        overflowCount: 0
      });
    expect(parse(activity).success).toBe(true);
    expect(parse({ ...activity, text: "private" }).success).toBe(false);
    expect(parse({ ...activity, lastActivityAt: "right now" }).success).toBe(
      false
    );
  });

  it("never accepts evidence text on Desktop citations", () => {
    expect(
      floatingKinEvidenceSchema.safeParse({
        items: [{ ...source, text: "evidence" }],
        truncated: false
      }).success
    ).toBe(true);
    const summary = {
      status: "answered",
      captured: "It finished checking the tests.",
      inferred: null,
      asOf: occurredAt,
      sources: [source],
      truncated: false,
      client: "pi",
      model: "assigned-model",
      effort: null
    };
    expect(floatingKinSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      floatingKinSummarySchema.safeParse({
        ...summary,
        sources: [{ ...source, text: "evidence" }]
      }).success
    ).toBe(false);
    expect(
      floatingKinSummarySchema.safeParse({ status: "timed_out" }).success
    ).toBe(true);
  });
});
