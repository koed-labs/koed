import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverManagedConversationRuntime } from "./managed-conversation-runtime-discovery.js";

describe("managed Conversation runtime discovery", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
  });

  const createTranscript = async (
    root: string,
    homeName: string,
    threadId: string
  ) => {
    const managedHome = join(root, "codex-managed", homeName);
    const transcriptPath = join(
      managedHome,
      "sessions",
      "2026",
      "07",
      "27",
      `rollout-${threadId}.jsonl`
    );
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      join(managedHome, "koed-managed-home.json"),
      JSON.stringify({ version: 1, kind: "koed-managed-codex-home" })
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          session_id: threadId,
          cli_version: "0.145.0",
          cwd: "/work/project"
        }
      })}\n`
    );
    return { managedHome, transcriptPath };
  };

  it("finds the exact transcript in a valid Koed-managed home", async () => {
    const root = await mkdtemp(join(tmpdir(), "koed-runtime-discovery-"));
    homes.push(root);
    const expected = await createTranscript(root, "session-valid", "thread-1");

    await expect(
      discoverManagedConversationRuntime({
        koedHome: root,
        providerThreadId: "thread-1"
      })
    ).resolves.toEqual({
      ...expected,
      providerCliVersion: "0.145.0",
      projectPath: "/work/project"
    });
  });

  it("rejects ambiguous provider identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "koed-runtime-discovery-"));
    homes.push(root);
    await createTranscript(root, "session-first", "thread-1");
    await createTranscript(root, "session-second", "thread-1");

    await expect(
      discoverManagedConversationRuntime({
        koedHome: root,
        providerThreadId: "thread-1"
      })
    ).rejects.toThrow("ManagedConversationRuntimeDiscoveryConflictError");
  });

  it("does not follow transcript directory symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "koed-runtime-discovery-"));
    const outside = await mkdtemp(join(tmpdir(), "koed-runtime-outside-"));
    homes.push(root, outside);
    const managedHome = join(root, "codex-managed", "session-valid");
    await mkdir(managedHome, { recursive: true });
    await writeFile(
      join(managedHome, "koed-managed-home.json"),
      JSON.stringify({ version: 1, kind: "koed-managed-codex-home" })
    );
    const outsideTranscript = join(outside, "rollout.jsonl");
    await writeFile(
      outsideTranscript,
      `${JSON.stringify({
        type: "session_meta",
        payload: { session_id: "thread-1" }
      })}\n`
    );
    await symlink(outside, join(managedHome, "sessions"));

    await expect(
      discoverManagedConversationRuntime({
        koedHome: root,
        providerThreadId: "thread-1"
      })
    ).resolves.toBeNull();
  });
});
