import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertCodexConversationProtocolCompatibility } from "../src/codex-app-server-protocol-compatibility.js";

const notificationMethods = [
  "thread/started",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated"
];
const requestMethods = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt"
];
const itemTypes = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "plan",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
];

interface SchemaGeneratorOptions {
  hangMs?: number;
  omitItemType?: string;
  omitNotificationMethod?: string;
  omitRequiredField?: {
    file: string;
    field: string;
    definition?: string;
    itemType?: string;
  };
  omitProperty?: {
    file: string;
    field: string;
    definition?: string;
    itemType?: string;
  };
  overrideProperty?: {
    file: string;
    field: string;
    itemType: string;
    schema: unknown;
  };
}

const writeSchemaGenerator = (
  directory: string,
  options: SchemaGeneratorOptions = {}
): string => {
  const modulePath = path.join(directory, "fake-schema-generator.mjs");
  const scriptPath = path.join(directory, "fake-schema-generator");
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${modulePath}" "$@"
`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    modulePath,
    `
import fs from "node:fs";
import path from "node:path";
const options = ${JSON.stringify(options)};
const outputIndex = process.argv.indexOf("--out");
if (!process.argv.includes("generate-json-schema") || !process.argv.includes("--experimental") || outputIndex < 0) process.exit(2);
if (options.hangMs) await new Promise((resolve) => setTimeout(resolve, options.hangMs));
const output = process.argv[outputIndex + 1];
fs.mkdirSync(path.join(output, "v2"), { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value));
const requiredFor = (file, fields, scope = {}) => fields.filter((field) => {
  const omitted = options.omitRequiredField;
  return !omitted || omitted.file !== file || omitted.field !== field ||
    omitted.definition !== scope.definition || omitted.itemType !== scope.itemType;
});
const propertyFor = (file, field, scope = {}) => {
  const omitted = options.omitProperty;
  return !omitted || omitted.file !== file || omitted.field !== field ||
    omitted.definition !== scope.definition || omitted.itemType !== scope.itemType;
};
const semanticProperties = {
  userMessage: { content: { type: "array", items: {} } },
  agentMessage: {
    text: { type: "string" },
    phase: { type: ["string", "null"] }
  },
  reasoning: {
    summary: { type: "array", items: { type: "string" } },
    content: { type: "array", items: { type: "string" } }
  },
  commandExecution: {
    command: { type: "string" },
    aggregatedOutput: { type: ["string", "null"] },
    exitCode: { type: ["integer", "null"] },
    status: { type: "string" },
    durationMs: { type: ["integer", "null"] }
  },
  mcpToolCall: {
    server: { type: "string" },
    tool: { type: "string" },
    arguments: true,
    result: { type: ["object", "null"] },
    error: { type: ["object", "null"] },
    status: { type: "string" },
    durationMs: { type: ["integer", "null"] }
  },
  dynamicToolCall: {
    tool: { type: "string" },
    arguments: true,
    contentItems: { type: ["array", "null"], items: {} },
    success: { type: ["boolean", "null"] },
    status: { type: "string" },
    durationMs: { type: ["integer", "null"] }
  },
  collabAgentToolCall: {
    tool: { type: "string" },
    agentsStates: { type: "object" },
    prompt: { type: ["string", "null"] },
    receiverThreadIds: { type: "array", items: { type: "string" } },
    status: { type: "string" }
  }
};
const semanticRequired = {
  userMessage: ["content"],
  agentMessage: ["text"],
  commandExecution: ["command", "status"],
  mcpToolCall: ["arguments", "server", "status", "tool"],
  dynamicToolCall: ["arguments", "status", "tool"],
  collabAgentToolCall: ["agentsStates", "receiverThreadIds", "status", "tool"]
};
const propertiesFor = (file, type) => Object.fromEntries(
  Object.entries(semanticProperties[type] ?? {}).flatMap(([field, schema]) => {
    if (!propertyFor(file, field, { itemType: type })) return [];
    const override = options.overrideProperty;
    return [[field,
      override && override.file === file && override.itemType === type && override.field === field
        ? override.schema
        : schema
    ]];
  })
);
const variants = ${JSON.stringify(itemTypes)}.filter(
  (type) => type !== options.omitItemType
);
const methods = ${JSON.stringify(notificationMethods)}.filter(
  (method) => method !== options.omitNotificationMethod
);
write("ServerNotification.json", {
  oneOf: methods.map((method) => ({ properties: { method: { enum: [method] } } }))
});
write("ClientRequest.json", {
  oneOf: ${JSON.stringify(requestMethods)}.map(
    (method) => ({ properties: { method: { enum: [method] } } })
  )
});
const itemSchema = (file, timestampField) => ({
  required: requiredFor(file, ["item", "threadId", "turnId", timestampField]),
  definitions: {
    ThreadItem: {
      oneOf: variants.map((type) => ({
        required: requiredFor(
          file,
          ["id", "type", ...(semanticRequired[type] ?? [])],
          { itemType: type }
        ),
        properties: {
          id: { type: "string" },
          type: { enum: [type] },
          ...propertiesFor(file, type),
          ...(type === "userMessage" &&
          propertyFor(file, "clientId", { itemType: type })
            ? { clientId: { type: ["string", "null"] } }
            : {})
        }
      }))
    }
  }
});
write(
  "v2/ItemCompletedNotification.json",
  itemSchema("v2/ItemCompletedNotification.json", "completedAtMs")
);
write(
  "v2/ItemStartedNotification.json",
  itemSchema("v2/ItemStartedNotification.json", "startedAtMs")
);
const turnNotification = (file) => ({
  required: requiredFor(file, ["threadId", "turn"]),
  definitions: {
    Turn: {
      required: requiredFor(file, ["id"], { definition: "Turn" })
    }
  }
});
write(
  "v2/TurnCompletedNotification.json",
  turnNotification("v2/TurnCompletedNotification.json")
);
write(
  "v2/TurnStartedNotification.json",
  turnNotification("v2/TurnStartedNotification.json")
);
write("v2/ThreadTokenUsageUpdatedNotification.json", {
  required: requiredFor("v2/ThreadTokenUsageUpdatedNotification.json", [
    "threadId",
    "turnId",
    "tokenUsage"
  ])
});
const deltaSchemas = ${JSON.stringify({
      "v2/AgentMessageDeltaNotification.json": [
        "delta",
        "itemId",
        "threadId",
        "turnId"
      ],
      "v2/CommandExecutionOutputDeltaNotification.json": [
        "delta",
        "itemId",
        "threadId",
        "turnId"
      ],
      "v2/FileChangeOutputDeltaNotification.json": [
        "delta",
        "itemId",
        "threadId",
        "turnId"
      ],
      "v2/PlanDeltaNotification.json": [
        "delta",
        "itemId",
        "threadId",
        "turnId"
      ],
      "v2/ReasoningSummaryTextDeltaNotification.json": [
        "delta",
        "itemId",
        "summaryIndex",
        "threadId",
        "turnId"
      ],
      "v2/ReasoningTextDeltaNotification.json": [
        "contentIndex",
        "delta",
        "itemId",
        "threadId",
        "turnId"
      ]
    })};
for (const [file, fields] of Object.entries(deltaSchemas)) {
  write(file, { required: requiredFor(file, fields) });
}
const threadResponse = (file) => ({
  required: requiredFor(file, ["thread"]),
  definitions: {
    Thread: {
      required: requiredFor(file, ["id", "sessionId"], {
        definition: "Thread"
      })
    }
  }
});
write("v2/ThreadStartedNotification.json", {
  required: requiredFor("v2/ThreadStartedNotification.json", ["thread"]),
  definitions: {
    Thread: {
      required: requiredFor(
        "v2/ThreadStartedNotification.json",
        ["id", "sessionId", "ephemeral"],
        { definition: "Thread" }
      ),
      properties: Object.fromEntries(
        ["id", "sessionId", "ephemeral", "parentThreadId", "path"].flatMap(
          (field) =>
            propertyFor("v2/ThreadStartedNotification.json", field, {
              definition: "Thread"
            })
              ? [[field, {}]]
              : []
        )
      )
    }
  }
});
write(
  "v2/ThreadStartResponse.json",
  threadResponse("v2/ThreadStartResponse.json")
);
write(
  "v2/ThreadResumeResponse.json",
  threadResponse("v2/ThreadResumeResponse.json")
);
write("v2/TurnStartResponse.json", {
  required: requiredFor("v2/TurnStartResponse.json", ["turn"]),
  definitions: {
    Turn: {
      required: requiredFor("v2/TurnStartResponse.json", ["id"], {
        definition: "Turn"
      })
    }
  }
});
write("v2/ThreadResumeParams.json", {
  required: requiredFor("v2/ThreadResumeParams.json", ["threadId"])
});
write("v2/ThreadStartParams.json", {
  properties: {
    ...(propertyFor("v2/ThreadStartParams.json", "historyMode")
      ? { historyMode: {} }
      : {})
  }
});
write("v2/TurnStartParams.json", {
  required: requiredFor("v2/TurnStartParams.json", ["input", "threadId"]),
  properties: {
    input: {},
    threadId: {},
    ...(propertyFor("v2/TurnStartParams.json", "clientUserMessageId")
      ? { clientUserMessageId: {} }
      : {})
  }
});
write("v2/TurnInterruptParams.json", {
  required: requiredFor("v2/TurnInterruptParams.json", ["threadId", "turnId"])
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

describe("Codex app-server conversation protocol compatibility", () => {
  it("accepts the generated experimental conversation protocol surface", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-compatible-")
    );
    try {
      const result = assertCodexConversationProtocolCompatibility({
        binary: writeSchemaGenerator(directory),
        cwd: directory,
        env: process.env
      });

      expect(result.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.notificationMethods).toEqual(
        [...notificationMethods].sort()
      );
      expect(result.notificationMethods).toContain(
        "item/reasoning/summaryTextDelta"
      );
      expect(result.threadItemTypes).toEqual([...itemTypes].sort());
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails visibly when the installed protocol drops a required item type", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-incompatible-")
    );
    try {
      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, {
            omitItemType: "mcpToolCall"
          }),
          cwd: directory,
          env: process.env
        })
      ).toThrow("missing ThreadItem variants: mcpToolCall");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails visibly when the installed protocol drops a current notification", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-notification-")
    );
    try {
      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, {
            omitNotificationMethod: "item/fileChange/outputDelta"
          }),
          cwd: directory,
          env: process.env
        })
      ).toThrow("missing notification methods: item/fileChange/outputDelta");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails visibly when lifecycle, delta, or response identity fields drift", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-identity-")
    );
    const cases: Array<{
      options: SchemaGeneratorOptions;
      message: string;
    }> = [
      {
        options: {
          omitRequiredField: {
            file: "v2/ItemCompletedNotification.json",
            itemType: "mcpToolCall",
            field: "id"
          }
        },
        message:
          "v2/ItemCompletedNotification.json mcpToolCall required identity fields: id"
      },
      {
        options: {
          omitRequiredField: {
            file: "v2/ReasoningTextDeltaNotification.json",
            field: "itemId"
          }
        },
        message:
          "v2/ReasoningTextDeltaNotification.json required fields: itemId"
      },
      {
        options: {
          omitRequiredField: {
            file: "v2/TurnCompletedNotification.json",
            definition: "Turn",
            field: "id"
          }
        },
        message: "v2/TurnCompletedNotification.json Turn required fields: id"
      },
      {
        options: {
          omitRequiredField: {
            file: "v2/ThreadStartResponse.json",
            definition: "Thread",
            field: "sessionId"
          }
        },
        message: "v2/ThreadStartResponse.json Thread required fields: sessionId"
      }
    ];

    try {
      for (const testCase of cases) {
        expect(() =>
          assertCodexConversationProtocolCompatibility({
            binary: writeSchemaGenerator(directory, testCase.options),
            cwd: directory,
            env: process.env
          })
        ).toThrow(testCase.message);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires managed user-message identity capabilities", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-user-identity-")
    );
    try {
      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, {
            omitProperty: {
              file: "v2/TurnStartParams.json",
              field: "clientUserMessageId"
            }
          }),
          cwd: directory,
          env: process.env
        })
      ).toThrow("v2/TurnStartParams.json properties: clientUserMessageId");

      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, {
            omitProperty: {
              file: "v2/ItemCompletedNotification.json",
              itemType: "userMessage",
              field: "clientId"
            }
          }),
          cwd: directory,
          env: process.env
        })
      ).toThrow(
        "v2/ItemCompletedNotification.json userMessage identity properties: clientId"
      );

      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, {
            omitProperty: {
              file: "v2/ThreadStartParams.json",
              field: "historyMode"
            }
          }),
          cwd: directory,
          env: process.env
        })
      ).toThrow("v2/ThreadStartParams.json properties: historyMode");

      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, {
            omitProperty: {
              file: "v2/ThreadStartedNotification.json",
              definition: "Thread",
              field: "parentThreadId"
            }
          }),
          cwd: directory,
          env: process.env
        })
      ).toThrow(
        "v2/ThreadStartedNotification.json Thread properties: parentThreadId"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects drift in semantic ThreadItem fields consumed by the adapter", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-semantics-")
    );
    const cases: Array<{
      options: SchemaGeneratorOptions;
      message: string;
    }> = [
      {
        options: {
          omitProperty: {
            file: "v2/ItemCompletedNotification.json",
            itemType: "agentMessage",
            field: "text"
          }
        },
        message: "agentMessage semantic property: text (string)"
      },
      {
        options: {
          overrideProperty: {
            file: "v2/ItemCompletedNotification.json",
            itemType: "reasoning",
            field: "summary",
            schema: { type: "string" }
          }
        },
        message: "reasoning semantic property: summary (string_array)"
      },
      {
        options: {
          overrideProperty: {
            file: "v2/ItemCompletedNotification.json",
            itemType: "commandExecution",
            field: "durationMs",
            schema: { type: ["string", "null"] }
          }
        },
        message: "commandExecution semantic property: durationMs (integer)"
      },
      {
        options: {
          omitProperty: {
            file: "v2/ItemCompletedNotification.json",
            itemType: "mcpToolCall",
            field: "result"
          }
        },
        message: "mcpToolCall semantic property: result (present)"
      },
      {
        options: {
          omitProperty: {
            file: "v2/ItemCompletedNotification.json",
            itemType: "dynamicToolCall",
            field: "contentItems"
          }
        },
        message: "dynamicToolCall semantic property: contentItems (array)"
      }
    ];

    try {
      for (const testCase of cases) {
        expect(() =>
          assertCodexConversationProtocolCompatibility({
            binary: writeSchemaGenerator(directory, testCase.options),
            cwd: directory,
            env: process.env
          })
        ).toThrow(testCase.message);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds experimental schema generation", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-timeout-")
    );
    try {
      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary: writeSchemaGenerator(directory, { hangMs: 1_000 }),
          cwd: directory,
          env: process.env,
          timeoutMs: 25
        })
      ).toThrow("schema generation timed out after 25ms");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("revalidates a binary that changes in place", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-protocol-updated-")
    );
    try {
      const binary = writeSchemaGenerator(directory);
      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary,
          cwd: directory,
          env: process.env
        })
      ).not.toThrow();

      writeSchemaGenerator(directory, { omitItemType: "mcpToolCall" });
      expect(() =>
        assertCodexConversationProtocolCompatibility({
          binary,
          cwd: directory,
          env: process.env
        })
      ).toThrow("missing ThreadItem variants: mcpToolCall");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
