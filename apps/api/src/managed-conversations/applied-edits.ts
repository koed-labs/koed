import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { classifySourceContent } from "@koed/shared";
import { managedConversationFilePathSchema } from "@koed/shared/managed-conversation-files";

type Edit = {
  path: string;
  change: "added" | "modified" | "deleted";
  patch?: string;
  patchTruncated: boolean;
  confirmation: "applied" | "recorded";
  additions?: number;
  deletions?: number;
  contentExcluded?: true;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Expose recorded patch literals from the exact bound turn, with explicit confirmation. */
export function codexAppliedEdits(
  text: string,
  identity: { threadId: string; turnId: string; projectPath: string }
): Edit[] {
  let verifiedSession = false;
  let activeTurn: string | null = null;
  let completed = false;
  let budget = 256 * 1024;
  const calls = new Map<
    string,
    { patch: string; confirmation: "applied" | "recorded" }
  >();
  const edits: Edit[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(line));
    } catch {
      return [];
    }
    const payload = object(row.payload);
    if (row.type === "session_meta") {
      if (
        verifiedSession ||
        payload.id !== identity.threadId ||
        typeof payload.cwd !== "string" ||
        resolve(payload.cwd) !== resolve(identity.projectPath)
      )
        return [];
      verifiedSession = true;
    }
    if (!verifiedSession) continue;
    if (row.type === "event_msg" && payload.type === "task_started")
      activeTurn = typeof payload.turn_id === "string" ? payload.turn_id : null;
    if (row.type === "event_msg" && payload.type === "task_complete") {
      if (payload.turn_id === identity.turnId && activeTurn === identity.turnId)
        completed = true;
      activeTurn = null;
    }
    if (activeTurn !== identity.turnId || row.type !== "response_item")
      continue;
    if (
      payload.type === "custom_tool_call" &&
      payload.name === "apply_patch" &&
      typeof payload.call_id === "string" &&
      typeof payload.input === "string" &&
      payload.input.length <= 512 * 1024 &&
      calls.size < 100
    )
      calls.set(payload.call_id, {
        patch: payload.input,
        confirmation: "applied"
      });
    if (
      payload.type === "custom_tool_call" &&
      payload.name === "exec" &&
      typeof payload.call_id === "string" &&
      typeof payload.input === "string" &&
      payload.input.length <= 512 * 1024 &&
      calls.size < 100
    ) {
      // Decode literal patch arguments only. Never execute or evaluate the recorded script.
      const patches = [
        ...payload.input.matchAll(
          /tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*")\s*\)/gu
        )
      ]
        .slice(0, 16)
        .flatMap((match) => {
          try {
            return [JSON.parse(match[1]!) as string];
          } catch {
            return [];
          }
        });
      if (patches.length)
        calls.set(payload.call_id, {
          patch: patches.join("\n"),
          confirmation: "recorded"
        });
    }
    if (
      payload.type !== "custom_tool_call_output" ||
      typeof payload.call_id !== "string"
    )
      continue;
    const call = calls.get(payload.call_id);
    calls.delete(payload.call_id);
    if (!call) continue;
    const { patch, confirmation } = call;
    let output = payload.output;
    // Codex serializes successful custom tool output as a JSON envelope.
    if (typeof output === "string" && output.startsWith("{")) {
      try {
        const parsed = object(JSON.parse(output));
        if (object(parsed.metadata).exit_code !== 0) continue;
        output = parsed.output;
      } catch {
        continue;
      }
    }
    if (confirmation === "recorded") {
      if (
        !Array.isArray(output) ||
        !output.some(
          (part) =>
            typeof object(part).text === "string" &&
            (object(part).text as string).startsWith("Script completed")
        )
      )
        continue;
      output =
        "Success. Updated the following files:\n" +
        [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: ([^\n]+)/gmu)]
          .map((match) => `M ${match[2]!}`)
          .join("\n");
    }
    if (
      typeof output !== "string" ||
      !output.startsWith("Success. Updated the following files:\n")
    )
      continue;
    const confirmed = new Set(
      output
        .split("\n")
        .slice(1)
        .filter((value) => /^[AMD] /u.test(value))
        .map((value) => value.slice(2))
    );
    const sections = patch
      .split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/mu)
      .slice(1);
    for (const section of sections) {
      if (edits.length >= 100) break;
      const header = /^\*\*\* (Add|Update|Delete) File: ([^\n]+)\n/u.exec(
        section
      );
      if (
        !header ||
        !header[2] ||
        !confirmed.has(header[2]) ||
        section.includes("*** Move to:")
      )
        continue;
      const path = relative(
        identity.projectPath,
        resolve(identity.projectPath, header[2])
      );
      if (
        path.split("/").includes(".git") ||
        !managedConversationFilePathSchema.safeParse(path).success
      )
        continue;
      const body = section
        .slice(header[0].length)
        .replace(/\n\*\*\* End Patch\s*$/u, "");
      const excluded = classifySourceContent(path, Buffer.from(body));
      const shown = body.slice(0, Math.min(32 * 1024, budget));
      budget -= excluded ? 0 : shown.length;
      const change =
        header[1] === "Add"
          ? "added"
          : header[1] === "Delete"
            ? "deleted"
            : "modified";
      const lines = body.split("\n");
      edits.push({
        path,
        change,
        confirmation,
        patchTruncated: shown.length < body.length,
        ...(excluded
          ? { contentExcluded: true as const }
          : {
              ...(shown ? { patch: shown } : {}),
              ...(change !== "deleted"
                ? {
                    additions: lines.filter((value) => value.startsWith("+"))
                      .length,
                    deletions: lines.filter((value) => value.startsWith("-"))
                      .length
                  }
                : {})
            })
      });
    }
  }
  return completed ? edits : [];
}

/** Trusted local runtime binding only; bounded read and no workspace traversal. */
export async function readCodexAppliedEdits(
  path: string,
  identity: Parameters<typeof codexAppliedEdits>[1]
): Promise<Edit[]> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return [];
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (!bytesRead) return [];
      offset += bytesRead;
    }
    return codexAppliedEdits(buffer.toString("utf8"), identity);
  } finally {
    await handle.close();
  }
}
