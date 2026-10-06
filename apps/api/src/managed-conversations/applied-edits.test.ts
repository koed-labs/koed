import { describe, expect, it } from "vitest";
import { codexAppliedEdits, readCodexAppliedEdits } from "./applied-edits.js";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const identity = {
  threadId: "thread",
  turnId: "turn",
  projectPath: "/projects/page"
};
const row = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ type, payload });
const transcript = (
  path = "index.html",
  body = "+<h1>Hello world</h1>",
  output = `Success. Updated the following files:\nA ${path}\n`
) =>
  [
    row("session_meta", { id: "thread", cwd: identity.projectPath }),
    row("event_msg", { type: "task_started", turn_id: "old" }),
    row("response_item", {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "old-call",
      input:
        "*** Begin Patch\n*** Add File: old.html\n+Wrong turn\n*** End Patch"
    }),
    row("event_msg", { type: "task_started", turn_id: "turn" }),
    row("response_item", {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "call",
      input: `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch`
    }),
    row("response_item", {
      type: "custom_tool_call_output",
      call_id: "call",
      output: JSON.stringify({ output, metadata: { exit_code: 0 } })
    }),
    row("event_msg", { type: "task_complete", turn_id: "turn" })
  ].join("\n") + "\n";
describe("recorded applied edits", () => {
  it("recovers confirmed edits for exactly one bound turn without accessing today's files", () => {
    expect(codexAppliedEdits(transcript(), identity)).toEqual([
      {
        path: "index.html",
        change: "added",
        patch: "+<h1>Hello world</h1>",
        patchTruncated: false,
        confirmation: "applied",
        additions: 1,
        deletions: 0
      }
    ]);
  });
  it("rejects wrong session, folder, turn, unsuccessful calls and incomplete turns", () => {
    for (const change of [
      { threadId: "other" },
      { turnId: "other" },
      { projectPath: "/projects/other" }
    ])
      expect(
        codexAppliedEdits(transcript(), { ...identity, ...change })
      ).toEqual([]);
    expect(
      codexAppliedEdits(transcript("index.html", "+text", "Failed"), identity)
    ).toEqual([]);
    expect(
      codexAppliedEdits(
        transcript().split("\n").slice(0, -2).join("\n"),
        identity
      )
    ).toEqual([]);
  });
  it("keeps files within the chosen project and excludes sensitive content", () => {
    expect(codexAppliedEdits(transcript("../private.html"), identity)).toEqual(
      []
    );
    const excluded = codexAppliedEdits(
      transcript(".env", "+SECRET=value"),
      identity
    )[0];
    expect(excluded.contentExcluded).toBe(true);
    expect(excluded.patch).toBeUndefined();
  });
  it("bounds patch size and refuses symlink transcripts", async () => {
    const edit = codexAppliedEdits(
      transcript("index.html", "+" + "x".repeat(40000)),
      identity
    )[0];
    expect(edit.patch?.length).toBe(32768);
    expect(edit.patchTruncated).toBe(true);
    const folder = await mkdtemp(resolve(tmpdir(), "koed-edits-"));
    try {
      const path = resolve(folder, "source.jsonl");
      await writeFile(path, transcript());
      await symlink(path, resolve(folder, "link.jsonl"));
      expect(await readCodexAppliedEdits(path, identity)).toHaveLength(1);
      await expect(
        readCodexAppliedEdits(resolve(folder, "link.jsonl"), identity)
      ).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

it("recovers literal patches inside a completed exec tool call without claiming verified application", () => {
  const patch =
    "*** Begin Patch\n*** Update File: index.html\n@@\n-old\n+Hello world\n*** End Patch";
  const text = [
    row("session_meta", { id: "thread", cwd: identity.projectPath }),
    row("event_msg", { type: "task_started", turn_id: "turn" }),
    row("response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec",
      input: `text(await tools.apply_patch(${JSON.stringify(patch)}));`
    }),
    row("response_item", {
      type: "custom_tool_call_output",
      call_id: "exec",
      output: [
        { type: "input_text", text: "Script completed\nOutput:" },
        { type: "input_text", text: "{}" }
      ]
    }),
    row("event_msg", { type: "task_complete", turn_id: "turn" })
  ].join("\n");
  expect(codexAppliedEdits(text, identity)).toMatchObject([
    {
      path: "index.html",
      confirmation: "recorded",
      additions: 1,
      deletions: 1,
      patch: "@@\n-old\n+Hello world"
    }
  ]);
  expect(
    codexAppliedEdits(
      text.replace("Script completed", "Script failed"),
      identity
    )
  ).toEqual([]);
});
