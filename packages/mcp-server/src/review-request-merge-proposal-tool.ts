import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** A proposal is a selector only. It grants no source-control authority. */
export const mergeProposalText = (number: number): string =>
  `Koed review_request_merge_propose request v1: {"number":${number},"status":"requested"}`;

export const registerReviewRequestMergeProposalTool = (
  server: McpServer
): void => {
  server.registerTool(
    "review_request_merge_propose",
    {
      title: "Propose pull request merge",
      description:
        "Ask Koed to show a Native review for a pull request. Pass only its number. Koed verifies the execution, repository, checks and allowed merge method; this tool cannot merge a pull request.",
      inputSchema: z.object({ number: z.number().int().positive() }).strict()
    },
    ({ number }) =>
      Promise.resolve({
        structuredContent: { number, status: "requested" },
        content: [{ type: "text" as const, text: mergeProposalText(number) }]
      })
  );
};
