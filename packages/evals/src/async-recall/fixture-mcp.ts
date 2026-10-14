import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  createKoedMcpServer,
  type KoedMcpRuntimeClient
} from "@koed/mcp-server/mcp-server-factory";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { asyncRecallCases } from "./cases.js";
import { RecallFixture } from "./fixture.js";

const fixtureCase = asyncRecallCases.find(
  (entry) => entry.id === process.env.ASYNC_RECALL_CASE
);
const log = process.env.ASYNC_RECALL_LOG;
const delayMs = Number(process.env.ASYNC_RECALL_DELAY_MS ?? 5_000);
if (!fixtureCase || !log || !Number.isSafeInteger(delayMs) || delayMs < 1)
  throw new Error("A case, event log and positive delay are required");
const fixture = new RecallFixture(
  fixtureCase,
  (event) => {
    appendFileSync(log, `${JSON.stringify(event)}\n`);
  },
  delayMs
);

const response = (payload: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text:
        "markdown" in payload
          ? `<koed-memory-answer>\n${String(payload.markdown)}\n</koed-memory-answer>`
          : JSON.stringify(payload)
    }
  ]
});

const phaseFor = (input: Record<string, unknown>) =>
  fixtureCase.phases.length > 1 && /delay/i.test(String(input.query))
    ? ("followup" as const)
    : ("primary" as const);
// Observe the actual MCP request boundary, not internal reads or child signals.
const inputLines = createInterface({ input: process.stdin, terminal: false });
inputLines.on("line", (line) => {
  try {
    const request = JSON.parse(line) as {
      method?: string;
      params?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    };
    if (
      request.method === "tools/call" &&
      request.params?.name === "memory_answer_result" &&
      typeof request.params.arguments?.task_id === "string"
    )
      fixture.resultRequested(
        request.params.arguments.task_id,
        request.params.arguments.wait === true,
        Object.keys(request.params.arguments).filter(
          (key) =>
            !["task_id", "wait"].includes(key) ||
            (key === "wait" &&
              typeof request.params!.arguments!.wait !== "boolean")
        )
      );
  } catch {
    // The production transport remains responsible for malformed input errors.
  }
});
const runtimeClient: KoedMcpRuntimeClient = {
  capabilities() {
    return Promise.resolve({
      protocolVersion: 1 as const,
      curatedMemoryIntakeAvailable: false,
      supportedTools: ["memory_answer"] as const
    });
  },
  async callTool(name, input) {
    if (name !== "memory_answer") throw new Error("Unsupported fixture tool");
    return fixture.submit(phaseFor(input), "blocking", String(input.query));
  },
  async startMemoryAnswerTask(input) {
    const receipt = await fixture.submit(
      phaseFor(input),
      "non_blocking",
      String(input.query)
    );
    return fixture.snapshot(String(receipt.task_id));
  },
  getMemoryAnswerTask(id) {
    fixture.collect(id, false);
    return Promise.resolve(fixture.snapshot(id));
  },
  cancelMemoryAnswerTask(id) {
    fixture.cancel(id);
    return Promise.resolve(fixture.snapshot(id));
  }
};

serveStdio(
  async (context) => {
    const server = await createKoedMcpServer(context, {
      runtimeClient,
      environment: process.env
    });
    server.registerTool(
      "read_import_diagnostics",
      {
        description:
          "Read the current import failure diagnostics. This action is independent of the prior implementation decision.",
        inputSchema: z.object({}).strict()
      },
      () => Promise.resolve(response(fixture.diagnostics()))
    );
    server.registerTool(
      "record_import_decision",
      {
        description:
          "Record the implementation decision after consulting the recalled constraints, or unknown if no relevant memory exists. Does not change code.",
        inputSchema: z
          .object({
            phase: z.enum(["primary", "followup"]).default("primary"),
            outcome: z.enum(["decided", "unknown"]),
            retry_count: z.number().int().nonnegative().optional(),
            cache_authorization: z.boolean().optional(),
            retry_delay_ms: z.number().int().nonnegative().optional()
          })
          .strict()
      },
      ({ phase, ...decision }) => {
        fixture.decide(phase, decision);
        return Promise.resolve(response({ recorded: true }));
      }
    );
    return server;
  },
  { legacy: "serve" }
);
process.once("exit", () => {
  inputLines.close();
  fixture.close();
});
