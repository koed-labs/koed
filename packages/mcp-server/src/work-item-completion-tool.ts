import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Claude's tool_result transport retains MCP text but drops structuredContent.
// This exact receipt is still only a request; the managed worker owns mutation.
export const workItemCompletionRequestText =
  'Koed work_item_complete request v1: {"status":"requested"}';

/**
 * The MCP reply records a request. Only the managed worker's observed,
 * successful tool-completed event may perform the trusted state transition.
 */
export const registerWorkItemCompletionTool = (server: McpServer): void => {
  server.registerTool(
    "work_item_complete",
    {
      title: "Complete Work Item",
      description:
        "Report that the current managed Work Item is complete without a pull request. Koed validates this request against the running Agent execution before changing its status. Call only after the goal is met.",
      inputSchema: z.object({}).strict()
    },
    () =>
      Promise.resolve({
        structuredContent: { status: "requested" },
        content: [
          {
            type: "text" as const,
            text: workItemCompletionRequestText
          }
        ]
      })
  );
};
