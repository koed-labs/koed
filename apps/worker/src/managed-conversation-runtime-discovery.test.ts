import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverManagedConversationRuntime } from "./managed-conversation-runtime-discovery.js";

describe("managed Conversation runtime discovery", () => {
  const homes: string[] = [];

  const temporaryRoot = async (prefix: string): Promise<string> =>
    realpath(await mkdtemp(join(tmpdir(), prefix)));

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
  });

  const createTranscript = async (
    codexHome: string,
    fileName: string,
    threadId: string
  ) => {
    const transcriptPath = join(
      codexHome,
      "sessions",
      "2026",
      "07",
      "27",
      `rollout-${fileName}-${threadId}.jsonl`
    );
    await mkdir(dirname(transcriptPath), { recursive: true });
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
    return { codexHome, transcriptPath };
  };

  it("finds the exact transcript in the configured Codex home", async () => {
    const codexHome = await temporaryRoot("koed-runtime-discovery-");
    homes.push(codexHome);
    const expected = await createTranscript(codexHome, "one", "thread-1");

    await expect(
      discoverManagedConversationRuntime({
        codexHome,
        providerThreadId: "thread-1"
      })
    ).resolves.toEqual({
      ...expected,
      providerCliVersion: "0.145.0",
      projectPath: "/work/project"
    });
  });

  it("rejects ambiguous provider identity", async () => {
    const codexHome = await temporaryRoot("koed-runtime-discovery-");
    homes.push(codexHome);
    await createTranscript(codexHome, "first", "thread-1");
    await createTranscript(codexHome, "second", "thread-1");

    await expect(
      discoverManagedConversationRuntime({
        codexHome,
        providerThreadId: "thread-1"
      })
    ).rejects.toThrow("ManagedConversationRuntimeDiscoveryConflictError");
  });

  it("ignores unrelated transcript content before reading metadata", async () => {
    const codexHome = await temporaryRoot("koed-runtime-discovery-");
    homes.push(codexHome);
    const sessions = join(codexHome, "sessions", "2026", "07", "26");
    await mkdir(sessions, { recursive: true });
    await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        writeFile(
          join(sessions, `rollout-unrelated-${index}.jsonl`),
          "not valid JSON and must never be opened\n"
        )
      )
    );
    const expected = await createTranscript(codexHome, "matching", "thread-1");

    await expect(
      discoverManagedConversationRuntime({
        codexHome,
        providerThreadId: "thread-1"
      })
    ).resolves.toEqual({
      ...expected,
      providerCliVersion: "0.145.0",
      projectPath: "/work/project"
    });
  });

  it("does not follow transcript directory symlinks", async () => {
    const codexHome = await temporaryRoot("koed-runtime-discovery-");
    const outside = await temporaryRoot("koed-runtime-outside-");
    homes.push(codexHome, outside);
    const outsideTranscript = join(outside, "rollout.jsonl");
    await writeFile(
      outsideTranscript,
      `${JSON.stringify({
        type: "session_meta",
        payload: { session_id: "thread-1" }
      })}\n`
    );
    await symlink(outside, join(codexHome, "sessions"));

    await expect(
      discoverManagedConversationRuntime({
        codexHome,
        providerThreadId: "thread-1"
      })
    ).resolves.toBeNull();
  });
});
