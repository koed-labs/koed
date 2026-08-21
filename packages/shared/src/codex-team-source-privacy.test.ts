import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PrivacyClassifiedField } from "./privacy-filter-contract.js";
import {
  CodexTeamSourcePrivacyError,
  prepareCodexTeamSourceRecord,
  reconstructCodexTeamSourceRecord,
  serializeCodexTeamSourceRecord
} from "./codex-team-source-privacy.js";

const classified = (
  fields: readonly { path: string; text: string }[],
  replacement: (path: string, text: string) => string
): PrivacyClassifiedField[] =>
  fields.map((field) => ({
    path: field.path,
    inputSha256: createHash("sha256").update(field.text).digest("hex"),
    inputByteLength: Buffer.byteLength(field.text, "utf8"),
    maskedText: replacement(field.path, field.text),
    spans: [],
    decodedTextMatchesInput: true
  }));

describe("Codex Team Conversation Source privacy", () => {
  it("classifies free-form message text and preserves protocol literals", () => {
    const record = {
      timestamp: "2026-08-12T12:00:00.000Z",
      type: "response_item",
      payload: {
        id: "item-1",
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Email me at alice@example.test" }
        ]
      }
    };
    const prepared = prepareCodexTeamSourceRecord({
      record,
      decodedSource: `${JSON.stringify(record)}\n`
    });
    expect(prepared.disposition).toBe("include");
    if (prepared.disposition !== "include") return;
    expect(prepared.fields).toEqual([
      {
        path: "/payload/content/0/text",
        text: "Email me at alice@example.test"
      }
    ]);
    const sanitized = reconstructCodexTeamSourceRecord({
      prepared,
      fields: classified(prepared.fields, () => "Email me at [PRIVATE_EMAIL]")
    });
    expect(sanitized).toEqual({
      ...record,
      payload: {
        ...record.payload,
        content: [{ type: "input_text", text: "Email me at [PRIVATE_EMAIL]" }]
      }
    });
    expect(serializeCodexTeamSourceRecord(sanitized).endsWith("\n")).toBe(true);
  });

  it("classifies nested tool arguments and output while retaining scalars", () => {
    const record = {
      type: "response_item",
      payload: {
        id: "call-1",
        type: "function_call",
        call_id: "call-1",
        name: "send_email",
        arguments: {
          to: "alice@example.test",
          retries: 2,
          enabled: true,
          optional: null,
          body: ["Call +44 7700 900123", 42]
        }
      }
    };
    const prepared = prepareCodexTeamSourceRecord({ record });
    expect(prepared.disposition).toBe("include");
    if (prepared.disposition !== "include") return;
    expect(prepared.fields.map((field) => field.path)).toEqual([
      "/payload/name",
      "/payload/arguments/to",
      "/payload/arguments/body/0"
    ]);
    const sanitized = reconstructCodexTeamSourceRecord({
      prepared,
      fields: classified(prepared.fields, (path, text) =>
        path.endsWith("/to")
          ? "[PRIVATE_EMAIL]"
          : path.endsWith("/body/0")
            ? "Call [PRIVATE_PHONE]"
            : text
      )
    }) as typeof record;
    expect(sanitized.payload.arguments).toMatchObject({
      to: "[PRIVATE_EMAIL]",
      retries: 2,
      enabled: true,
      optional: null,
      body: ["Call [PRIVATE_PHONE]", 42]
    });
  });

  it("never infers protocol literals from user-controlled nested keys", () => {
    const record = {
      type: "response_item",
      payload: {
        id: "call-1",
        type: "function_call",
        call_id: "call-1",
        arguments: {
          customer_id: "4111111111111111",
          account_uuid: "123e4567-e89b-12d3-a456-426614174000",
          status: "alice@example.test",
          nested: { type: "sk_live_secret" }
        }
      }
    };
    const prepared = prepareCodexTeamSourceRecord({ record });
    expect(prepared.disposition).toBe("include");
    if (prepared.disposition !== "include") return;
    expect(prepared.fields.map((field) => field.path)).toEqual([
      "/payload/arguments/customer_id",
      "/payload/arguments/account_uuid",
      "/payload/arguments/status",
      "/payload/arguments/nested/type"
    ]);
  });

  it("classifies malformed values at otherwise structural protocol paths", () => {
    const prepared = prepareCodexTeamSourceRecord({
      record: {
        type: "event_msg",
        timestamp: "4111111111111111",
        payload: { type: "task_started", turn_id: "4111111111111111" }
      }
    });
    expect(prepared.disposition).toBe("include");
    if (prepared.disposition !== "include") return;
    expect(prepared.fields.map((field) => field.path)).toEqual([
      "/timestamp",
      "/payload/turn_id"
    ]);
  });

  it("drops hidden reasoning, instruction-bearing records, and system roles", () => {
    expect(
      prepareCodexTeamSourceRecord({
        record: {
          type: "response_item",
          payload: { type: "reasoning", encrypted_content: "ciphertext" }
        }
      })
    ).toEqual({ disposition: "drop", reason: "hidden_reasoning" });
    expect(
      prepareCodexTeamSourceRecord({
        record: {
          type: "response_item",
          payload: { type: "message", role: "developer", content: [] }
        }
      })
    ).toEqual({ disposition: "drop", reason: "system_instructions" });
    expect(
      prepareCodexTeamSourceRecord({
        record: { type: "turn_context", payload: { cwd: "/private/path" } }
      })
    ).toEqual({ disposition: "drop", reason: "system_instructions" });
  });

  it("fails closed for unsupported source protocol records", () => {
    expect(() =>
      prepareCodexTeamSourceRecord({
        record: { type: "future_record", content: "must not leak" }
      })
    ).toThrowError(CodexTeamSourcePrivacyError);
  });
});
