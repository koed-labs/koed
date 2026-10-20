import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

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
            text: "Work Item completion requested. Koed will verify the running execution."
          }
        ]
      })
  );
};
