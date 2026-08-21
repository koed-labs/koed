import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PrivacyClassifiedField } from "./privacy-filter-contract.js";
import {
  extractPrivacyTextFields,
  isFullyRedactedPrivacyText,
  PrivacyFieldError,
  reconstructPrivacyTextFields,
  type ExtractedPrivacyTextField,
  type PrivacyFieldSchema,
  type PrivacyJsonValue
} from "./privacy-field-extractor.js";

const classifiedFields = (
  fields: readonly ExtractedPrivacyTextField[],
  mask: (field: ExtractedPrivacyTextField) => string
): PrivacyClassifiedField[] =>
  fields.map((field) => ({
    path: field.path,
    inputSha256: createHash("sha256").update(field.text, "utf8").digest("hex"),
    inputByteLength: Buffer.byteLength(field.text, "utf8"),
    maskedText: mask(field),
    spans: [],
    decodedTextMatchesInput: true
  }));

const expectCode = (callback: () => unknown, code: string): void => {
  try {
    callback();
    throw new Error("Expected privacy field operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PrivacyFieldError);
    expect((error as PrivacyFieldError).code).toBe(code);
  }
};

describe("privacy field extractor", () => {
  it("extracts only declared nested tool text in stable source order", () => {
    const source = {
      id: 42,
      enabled: true,
      missing: null,
      turns: [
        {
          role: "assistant",
          content: "Call the lookup tool for José.",
          tool: {
            name: "lookup",
            payload: {
              query: "José / 東京",
              limit: 3,
              internal: "not selected"
            }
          }
        },
        {
          role: "tool",
          content: "Found josé@example.test",
          tool: {
            name: "lookup",
            payload: {
              query: "second query",
              limit: 1,
              internal: "still not selected"
            }
          }
        }
      ]
    } satisfies PrivacyJsonValue;
    const schema = {
      kind: "object",
      fields: {
        turns: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              role: { kind: "text" },
              content: { kind: "text" },
              tool: {
                kind: "object",
                fields: {
                  name: { kind: "text" },
                  payload: {
                    kind: "object",
                    fields: {
                      query: { kind: "text" },
                      internal: { kind: "text" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } satisfies PrivacyFieldSchema;

    const fields = extractPrivacyTextFields({
      source,
      schema,
      decodedSource: Buffer.from(`${JSON.stringify(source)}\n`, "utf8")
    });

    expect(fields).toEqual([
      { path: "/turns/0/role", text: "assistant" },
      { path: "/turns/0/content", text: "Call the lookup tool for José." },
      { path: "/turns/0/tool/name", text: "lookup" },
      { path: "/turns/0/tool/payload/query", text: "José / 東京" },
      { path: "/turns/0/tool/payload/internal", text: "not selected" },
      { path: "/turns/1/role", text: "tool" },
      { path: "/turns/1/content", text: "Found josé@example.test" },
      { path: "/turns/1/tool/name", text: "lookup" },
      { path: "/turns/1/tool/payload/query", text: "second query" },
      {
        path: "/turns/1/tool/payload/internal",
        text: "still not selected"
      }
    ]);
    expect(new Set(fields.map((field) => field.path)).size).toBe(fields.length);

    const reconstructed = reconstructPrivacyTextFields({
      source,
      schema,
      fields: classifiedFields(fields, (field) => `[MASKED:${field.path}]`)
    });

    expect(reconstructed.turns[0]!.tool.payload).toEqual({
      query: "[MASKED:/turns/0/tool/payload/query]",
      limit: 3,
      internal: "[MASKED:/turns/0/tool/payload/internal]"
    });
    expect(typeof reconstructed.id).toBe("number");
    expect(reconstructed.enabled).toBe(true);
    expect(reconstructed.missing).toBeNull();
    expect(Object.keys(reconstructed)).toEqual(Object.keys(source));
    expect(Object.keys(reconstructed.turns[0]!)).toEqual(
      Object.keys(source.turns[0]!)
    );
    expect(source.turns[0]!.content).toBe("Call the lookup tool for José.");
  });

  it("fails closed when schema drift introduces undeclared text", () => {
    const schema = {
      kind: "object",
      fields: { content: { kind: "text" } }
    } satisfies PrivacyFieldSchema;
    expectCode(
      () =>
        extractPrivacyTextFields({
          source: {
            content: "visible",
            newProviderField: { credential: "must not pass through" }
          },
          schema
        }),
      "invalid_schema"
    );
    expect(
      extractPrivacyTextFields({
        source: { content: "visible", sourceSequence: 42, complete: true },
        schema
      })
    ).toEqual([{ path: "/content", text: "visible" }]);
  });

  it("preserves declared protocol literals without classifying them", () => {
    const source = {
      type: "response_item",
      id: "019ff6ff-0000-7000-8000-000000000001",
      payload: { text: "Email jose@example.test" }
    };
    const schema = {
      kind: "object",
      fields: {
        type: { kind: "literal" },
        id: { kind: "literal" },
        payload: {
          kind: "object",
          fields: { text: { kind: "text" } }
        }
      }
    } satisfies PrivacyFieldSchema;
    const fields = extractPrivacyTextFields({ source, schema });
    expect(fields).toEqual([
      { path: "/payload/text", text: "Email jose@example.test" }
    ]);
    const reconstructed = reconstructPrivacyTextFields({
      source,
      schema,
      fields: classifiedFields(fields, () => "Email [PRIVATE_EMAIL]")
    });
    expect(reconstructed).toEqual({
      type: "response_item",
      id: "019ff6ff-0000-7000-8000-000000000001",
      payload: { text: "Email [PRIVATE_EMAIL]" }
    });
  });

  it("masks LCM fields and expansion while filtering fully redacted anchors", () => {
    const source = {
      representation: "lcm_leaf",
      lcm: {
        title: "José migration",
        summary_text: "José moved the service to api.example.test.",
        lexical_anchors: [
          "José",
          "api.example.test",
          "migration api.example.test"
        ]
      },
      expansion: [
        { kind: "memory_event", text: "Email josé@example.test", ordinal: 0 },
        { kind: "memory_event", text: "Deployment succeeded", ordinal: 1 }
      ]
    } satisfies PrivacyJsonValue;
    const schema = {
      kind: "object",
      fields: {
        representation: { kind: "text" },
        lcm: {
          kind: "object",
          fields: {
            title: { kind: "text" },
            summary_text: { kind: "text" },
            lexical_anchors: {
              kind: "array",
              items: { kind: "text", filterFullyRedacted: true }
            }
          }
        },
        expansion: {
          kind: "array",
          items: {
            kind: "object",
            fields: { kind: { kind: "text" }, text: { kind: "text" } }
          }
        }
      }
    } satisfies PrivacyFieldSchema;
    const extracted = extractPrivacyTextFields({ source, schema });
    const replacements = new Map<string, string>([
      ["/lcm/title", "[PRIVATE_PERSON] migration"],
      [
        "/lcm/summary_text",
        "[PRIVATE_PERSON] moved the service to [PRIVATE_URL]."
      ],
      ["/lcm/lexical_anchors/0", "[PRIVATE_PERSON]"],
      ["/lcm/lexical_anchors/1", " [PRIVATE_URL] "],
      ["/lcm/lexical_anchors/2", "migration [PRIVATE_URL]"],
      ["/expansion/0/text", "Email [PRIVATE_EMAIL]"],
      ["/expansion/1/text", "Deployment succeeded"],
      ["/representation", "lcm_leaf"],
      ["/expansion/0/kind", "memory_event"],
      ["/expansion/1/kind", "memory_event"]
    ]);

    const reconstructed = reconstructPrivacyTextFields({
      source,
      schema,
      fields: classifiedFields(
        extracted,
        (field) => replacements.get(field.path)!
      )
    });

    expect(reconstructed.lcm.lexical_anchors).toEqual([
      "migration [PRIVATE_URL]"
    ]);
    expect(reconstructed.lcm.title).toBe("[PRIVATE_PERSON] migration");
    expect(reconstructed.expansion).toEqual([
      { kind: "memory_event", text: "Email [PRIVATE_EMAIL]", ordinal: 0 },
      { kind: "memory_event", text: "Deployment succeeded", ordinal: 1 }
    ]);
    expect(isFullyRedactedPrivacyText("[SECRET][PRIVATE_EMAIL]")).toBe(true);
    expect(isFullyRedactedPrivacyText("token [SECRET]")).toBe(false);
  });

  it("uses canonical JSON Pointer escaping without Unicode normalization", () => {
    const decomposed = "Cafe\u0301";
    const source = {
      "話/題~🧠": {
        [decomposed]: "José 🧠 東京"
      }
    } satisfies PrivacyJsonValue;
    const schema = {
      kind: "object",
      fields: {
        "話/題~🧠": {
          kind: "object",
          fields: { [decomposed]: { kind: "text" } }
        }
      }
    } satisfies PrivacyFieldSchema;
    const extracted = extractPrivacyTextFields({ source, schema });

    expect(extracted).toEqual([
      { path: "/話~1題~0🧠/Café", text: "José 🧠 東京" }
    ]);
    const reconstructed = reconstructPrivacyTextFields({
      source,
      schema,
      fields: classifiedFields(extracted, () => "[PRIVATE_PERSON] 🧠 東京")
    });
    expect(reconstructed["話/題~🧠"][decomposed]).toBe(
      "[PRIVATE_PERSON] 🧠 東京"
    );
    expect(Object.keys(reconstructed["話/題~🧠"])).toEqual([decomposed]);
  });

  it("rejects malformed, missing, duplicate, and undeclared response paths", () => {
    const source = { text: "secret value", ignored: 42 };
    const schema = {
      kind: "object",
      fields: { text: { kind: "text" } }
    } satisfies PrivacyFieldSchema;
    const extracted = extractPrivacyTextFields({ source, schema });
    const valid = classifiedFields(extracted, () => "[SECRET]")[0]!;

    expectCode(
      () =>
        reconstructPrivacyTextFields({
          source,
          schema,
          fields: [{ ...valid, path: "/te~2xt" }]
        }),
      "malformed_path"
    );
    expectCode(
      () => reconstructPrivacyTextFields({ source, schema, fields: [] }),
      "missing_path"
    );
    expectCode(
      () =>
        reconstructPrivacyTextFields({
          source,
          schema,
          fields: [valid, valid]
        }),
      "duplicate_path"
    );
    expectCode(
      () =>
        reconstructPrivacyTextFields({
          source,
          schema,
          fields: [{ ...valid, path: "/ignored" }]
        }),
      "unexpected_path"
    );
  });

  it("binds each classified field to the exact decoded source without leaks", () => {
    const plaintext = "never log alice@example.test";
    const source = { text: plaintext };
    const schema = {
      kind: "object",
      fields: { text: { kind: "text" } }
    } satisfies PrivacyFieldSchema;
    const extracted = extractPrivacyTextFields({ source, schema });
    const valid = classifiedFields(extracted, () => "[PRIVATE_EMAIL]")[0]!;
    const wrongHash = `${valid.inputSha256.slice(0, -1)}${
      valid.inputSha256.endsWith("0") ? "1" : "0"
    }`;

    try {
      reconstructPrivacyTextFields({
        source,
        schema,
        fields: [{ ...valid, inputSha256: wrongHash }]
      });
      throw new Error("Expected source binding failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivacyFieldError);
      expect((error as PrivacyFieldError).code).toBe("source_field_mismatch");
      expect((error as Error).message).not.toContain(plaintext);
      expect((error as Error).message).not.toContain("alice@example.test");
      expect((error as Error).message).not.toContain("/text");
    }
  });

  it("validates canonical NDJSON decoding and source ordering", () => {
    const source = { first: "one", second: "two" };
    const schema = {
      kind: "object",
      fields: { first: { kind: "text" }, second: { kind: "text" } }
    } satisfies PrivacyFieldSchema;

    expect(
      extractPrivacyTextFields({
        source,
        schema,
        decodedSource: '{"first":"one","second":"two"}\n'
      })
    ).toHaveLength(2);
    expectCode(
      () =>
        extractPrivacyTextFields({
          source,
          schema,
          decodedSource: '{"second":"two","first":"one"}\n'
        }),
      "source_mismatch"
    );
    expectCode(
      () =>
        extractPrivacyTextFields({
          source,
          schema,
          decodedSource: Uint8Array.from([0xff])
        }),
      "invalid_source"
    );
  });

  it("rejects malformed source shapes and missing required schema paths", () => {
    const textSchema = {
      kind: "object",
      fields: { nested: { kind: "object", fields: { text: { kind: "text" } } } }
    } satisfies PrivacyFieldSchema;

    expectCode(
      () =>
        extractPrivacyTextFields({
          source: { nested: { text: 42 } },
          schema: textSchema
        }),
      "invalid_source"
    );
    expectCode(
      () => extractPrivacyTextFields({ source: {}, schema: textSchema }),
      "missing_path"
    );
    expect(
      extractPrivacyTextFields({
        source: {},
        schema: {
          kind: "object",
          fields: { text: { kind: "text", optional: true } }
        }
      })
    ).toEqual([]);
  });

  it("enforces depth, key, and UTF-8 byte bounds before traversal", () => {
    const schema = {
      kind: "object",
      fields: { text: { kind: "text" } }
    } satisfies PrivacyFieldSchema;

    expectCode(
      () =>
        extractPrivacyTextFields({
          source: { text: "value" },
          schema,
          limits: { maxDepth: 0 }
        }),
      "bounds_exceeded"
    );
    expectCode(
      () =>
        extractPrivacyTextFields({
          source: { text: "value", extra: true },
          schema,
          limits: { maxKeys: 1 }
        }),
      "bounds_exceeded"
    );
    expectCode(
      () =>
        extractPrivacyTextFields({
          source: { text: "🧠" },
          schema,
          limits: { maxBytes: 10 }
        }),
      "bounds_exceeded"
    );
  });
});
