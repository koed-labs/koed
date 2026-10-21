import type { McpServer } from "@modelcontextprotocol/server";
import {
  readDesktopLocalCredentialAuthorization,
  workItemsFromDocListPageSchema,
  workItemsFromDocReadPageSchema,
  workItemsFromDocPreviewResultSchema,
  workItemsFromDocToolInputSchema,
  workItemsFromDocToolListSchema,
  workItemsFromDocToolPreviewSchema,
  workItemsFromDocToolReadSchema
} from "@koed/shared";
import { z } from "zod";

export const workItemsFromDocRequestText =
  'Koed work_items_from_doc apply request v1: {"status":"requested"}';

export const workItemsFromDocInput = workItemsFromDocToolInputSchema;

const selector = (environment: NodeJS.ProcessEnv) => {
  const executionId = z
    .uuid()
    .safeParse(environment.KOED_MANAGED_DOC_EXECUTION_ID);
  const generation = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(environment.KOED_MANAGED_DOC_EXECUTION_GENERATION);
  const koedHome = environment.KOED_HOME;
  const apiUrl = environment.KOED_MANAGED_DOC_API_URL;
  if (!executionId.success || !generation.success || !koedHome || !apiUrl)
    throw new Error(
      "Document Work Item tool requires a current managed Conversation"
    );
  const url = new URL(apiUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Document Work Item tool requires a local API");
  const desktop = readDesktopLocalCredentialAuthorization(koedHome);
  if (
    !desktop?.operationFamilies.includes("personal_collaboration_read") ||
    !desktop.operationFamilies.includes("managed_execution")
  )
    throw new Error("Document Work Item tool lacks local owner authority");
  return {
    executionId: executionId.data,
    executionGeneration: generation.data,
    apiUrl: url,
    authorization: desktop.authorization
  };
};

export const readWorkItemsFromDocPage = async (
  input: { source_id?: string; cursor?: number },
  environment: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch
) => {
  const parsed = workItemsFromDocToolReadSchema.parse({
    mode: "read",
    ...input
  });
  const bound = selector(environment);
  const url = new URL(
    `/v1/managed-conversations/${bound.executionId}/work-items-from-doc/read`,
    bound.apiUrl
  );
  if (parsed.source_id) url.searchParams.set("sourceId", parsed.source_id);
  url.searchParams.set("cursor", String(parsed.cursor ?? 0));
  url.searchParams.set(
    "executionGeneration",
    String(bound.executionGeneration)
  );
  const response = await send(url, {
    method: "GET",
    redirect: "error",
    headers: { authorization: bound.authorization, accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok)
    throw new Error(`Project Source read is unavailable (${response.status})`);
  const raw = await response.text();
  if (raw.length > 256_000)
    throw new Error("Project Source page exceeded its limit");
  const page = workItemsFromDocReadPageSchema.parse(JSON.parse(raw));
  if (parsed.source_id && page.sourceId !== parsed.source_id)
    throw new Error("Project Source identity changed");
  return page;
};

export const listWorkItemsFromDocSources = async (
  input: { cursor?: number },
  environment: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch
) => {
  const parsed = workItemsFromDocToolListSchema.parse({
    mode: "list",
    ...input
  });
  const bound = selector(environment);
  const url = new URL(
    `/v1/managed-conversations/${bound.executionId}/work-items-from-doc/list`,
    bound.apiUrl
  );
  url.searchParams.set("cursor", String(parsed.cursor ?? 0));
  url.searchParams.set(
    "executionGeneration",
    String(bound.executionGeneration)
  );
  const response = await send(url, {
    method: "GET",
    redirect: "error",
    headers: { authorization: bound.authorization, accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok)
    throw new Error(
      `Project Source discovery is unavailable (${response.status})`
    );
  const raw = await response.text();
  if (raw.length > 32_000)
    throw new Error("Project Source discovery page exceeded its limit");
  return workItemsFromDocListPageSchema.parse(JSON.parse(raw));
};

export const previewWorkItemsFromDoc = async (
  input: {
    source_id: string;
    source_revision_id: string;
    note_revision_id: string;
    proposals: Array<{
      line_number: number;
      source_line: string;
      title: string;
      goal: string;
      due_text: string | null;
    }>;
  },
  environment: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch
) => {
  const parsed = workItemsFromDocToolPreviewSchema.parse({
    mode: "preview",
    ...input
  });
  const bound = selector(environment);
  const url = new URL(
    `/v1/managed-conversations/${bound.executionId}/work-items-from-doc/preview`,
    bound.apiUrl
  );
  const response = await send(url, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: bound.authorization,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      executionGeneration: bound.executionGeneration,
      sourceId: parsed.source_id,
      sourceRevisionId: parsed.source_revision_id,
      noteRevisionId: parsed.note_revision_id,
      proposals: parsed.proposals.map((proposal) => ({
        lineNumber: proposal.line_number,
        sourceLine: proposal.source_line,
        title: proposal.title,
        goal: proposal.goal,
        dueText: proposal.due_text
      }))
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok)
    throw new Error(
      `Document Work Item preview is unavailable (${response.status})`
    );
  const raw = await response.text();
  if (raw.length > 32_000)
    throw new Error("Document Work Item preview exceeded its limit");
  return workItemsFromDocPreviewResultSchema.parse(JSON.parse(raw));
};

/** List/read/preview are bounded owner-checked reads; apply requests a write. */
export const registerWorkItemsFromDocTool = (
  server: McpServer,
  environment: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch
): void => {
  server.registerTool(
    "work_items_from_doc",
    {
      title: "Make Work Items from a document",
      description:
        "For a typed request, first use list to find current Project documents by name; continue while nextCursor is present. If names are ambiguous, ask the User which document. A Project HQ selection lists only its selected document. Then read the chosen source_id in pages (or omit it for a selected document) and identify actionable lines. Use preview with exact revision IDs and verbatim line evidence to count new versus existing Plan Work Items without writing. A Koed catch-up may offer the new count, but must not apply; apply is only for a User start or prompt. Koed verifies source evidence, current Agent lease and duplicate lines before writing. Works without a to-tickets skill.",
      inputSchema: workItemsFromDocInput
    },
    async (input) => {
      const parsed = workItemsFromDocInput.parse(input);
      if (parsed.mode === "apply") {
        if (environment.KOED_MANAGED_CATCH_UP_READ_ONLY === "1")
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Koed catch-up cannot apply document Work Items."
              }
            ]
          };
        return {
          structuredContent: { status: "requested" },
          content: [
            { type: "text" as const, text: workItemsFromDocRequestText }
          ]
        };
      }
      if (parsed.mode === "list") {
        const page = await listWorkItemsFromDocSources(
          parsed,
          environment,
          send
        );
        return {
          structuredContent: page,
          content: [{ type: "text" as const, text: JSON.stringify(page) }]
        };
      }
      if (parsed.mode === "preview") {
        const preview = await previewWorkItemsFromDoc(
          parsed,
          environment,
          send
        );
        return {
          structuredContent: preview,
          content: [{ type: "text" as const, text: JSON.stringify(preview) }]
        };
      }
      const page = await readWorkItemsFromDocPage(parsed, environment, send);
      return {
        structuredContent: page,
        content: [{ type: "text" as const, text: JSON.stringify(page) }]
      };
    }
  );
};
