import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createKoedMcpServer } from "@koed/mcp-server/mcp-server-factory";
import { z } from "zod";
import { readFixture, recordEvent } from "./fixture-data.mjs";

const fixture = readFixture();
serveStdio(
  async (context) => {
    const server = await createKoedMcpServer(context, {
      environment: process.env
    });
    // These tools exist only in the fixture, alongside the real MCP factory.
    server.registerTool(
      "inspect_failure",
      {
        description:
          "Read the current import failure and settings from this fixture workspace. This diagnostic read is independent of the prior implementation decision.",
        inputSchema: z.object({}).strict()
      },
      async () => {
        recordEvent(fixture, "diagnostic_read");
        return {
          content: [
            {
              type: "text",
              text: readFileSync(join(fixture.workspace, "failure.txt"), "utf8")
            }
          ]
        };
      }
    );
    server.registerTool(
      "apply_fix",
      {
        description:
          "Apply the chosen import settings in this fixture workspace. Supply the retry delay and authorization-cache choice from the previous implementation decision.",
        inputSchema: z
          .object({
            retryDelayMs: z.number().int().positive(),
            cacheAuthorization: z.boolean()
          })
          .strict()
      },
      async (input) => {
        recordEvent(fixture, "dependent_action");
        writeFileSync(
          join(fixture.workspace, "import-settings.json"),
          `${JSON.stringify(input)}\n`
        );
        return {
          content: [{ type: "text", text: "Fixture import settings saved." }]
        };
      }
    );
    return server;
  },
  { legacy: "reject" }
);
