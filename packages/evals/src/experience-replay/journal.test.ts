import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  planAttemptResume,
  readRunJournal,
  type RunJournalEntry
} from "./journal.js";

const base = {
  version: 1 as const,
  configurationHash: "config-hash",
  recordedAt: new Date(0).toISOString()
};

const readEntries = async (entries: readonly object[]) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-journal-strict-"));
  const journalPath = path.join(root, "journal.jsonl");
  await writeFile(
    journalPath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
  return readRunJournal(journalPath, base.configurationHash);
};

describe("strict Experience Replay journal generations", () => {
  it("requires positive contiguous generations", async () => {
    await expect(
      readEntries([
        {
          ...base,
          sequence: 0,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 0,
          state: "admitted"
        }
      ])
    ).rejects.toThrow("Malformed attempt");

    await expect(
      readEntries([
        {
          ...base,
          sequence: 0,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 1,
          state: "admitted"
        },
        {
          ...base,
          sequence: 1,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 3,
          state: "admitted"
        }
      ])
    ).rejects.toThrow("non-contiguous execution generations");
  });

  it("rejects duplicate and out-of-order generation state", async () => {
    await expect(
      readEntries([
        {
          ...base,
          sequence: 0,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 1,
          state: "agent_started"
        },
        {
          ...base,
          sequence: 1,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 1,
          state: "admitted"
        }
      ])
    ).rejects.toThrow("started before admission");

    await expect(
      readEntries([
        {
          ...base,
          sequence: 0,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 1,
          state: "agent_started"
        },
        {
          ...base,
          sequence: 1,
          type: "attempt_state",
          attemptId: "replay:one",
          executionGeneration: 2,
          state: "admitted"
        }
      ])
    ).rejects.toThrow("irreversible prior generation");
  });

  it("binds a result digest to its journal identity", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    await expect(
      readEntries([
        {
          ...base,
          sequence: 0,
          type: "attempt_result",
          attemptId: "replay:one",
          executionGeneration: 1,
          resultPath: "attempts/one/generations/1/result.json",
          resultSha256: digest,
          resultIdentity: {
            attemptId: "replay:other",
            executionGeneration: 1
          },
          reward: 1,
          failureCategory: null
        }
      ])
    ).rejects.toThrow("Result artifact identity mismatch");

    await expect(
      readEntries([
        {
          ...base,
          sequence: 0,
          type: "attempt_result",
          attemptId: "replay:one",
          executionGeneration: 1,
          resultPath: "attempts/one/generations/1/result.json",
          resultSha256: digest,
          resultIdentity: {
            attemptId: "replay:one",
            executionGeneration: 1
          },
          reward: 1,
          failureCategory: null
        }
      ])
    ).resolves.toHaveLength(1);
  });

  it("plans a replay subset while retaining source journal entries", () => {
    const entries = [
      {
        ...base,
        sequence: 0,
        type: "attempt_result" as const,
        attemptId: "source:task",
        executionGeneration: 1,
        resultPath: "source/task/result.json",
        resultSha256: `sha256:${"a".repeat(64)}`,
        resultIdentity: {
          attemptId: "source:task",
          executionGeneration: 1
        },
        reward: 1,
        failureCategory: null
      },
      {
        ...base,
        sequence: 1,
        type: "attempt_state" as const,
        attemptId: "replay:task:cold:0",
        executionGeneration: 1,
        state: "admitted" as const
      }
    ] satisfies RunJournalEntry[];

    expect(planAttemptResume(["replay:task:cold:0"], entries)).toEqual([
      {
        attemptId: "replay:task:cold:0",
        action: "rerun_before_agent",
        nextExecutionGeneration: 2
      }
    ]);
    expect(() =>
      planAttemptResume(
        ["replay:task:cold:0"],
        [
          ...entries,
          {
            ...base,
            sequence: 2,
            type: "attempt_state",
            attemptId: "replay:unexpected",
            executionGeneration: 1,
            state: "admitted"
          }
        ]
      )
    ).toThrow("unexpected attempt");
  });

  it("retries only pre-agent setup failures", async () => {
    const entries = [
      {
        ...base,
        sequence: 0,
        type: "attempt_state" as const,
        attemptId: "replay:task:empty:0",
        executionGeneration: 1,
        state: "admitted" as const
      },
      {
        ...base,
        sequence: 1,
        type: "attempt_result" as const,
        attemptId: "replay:task:empty:0",
        executionGeneration: 1,
        resultPath: "attempts/task/empty/0/generation-1/failure-result.json",
        resultSha256: `sha256:${"a".repeat(64)}`,
        resultIdentity: {
          attemptId: "replay:task:empty:0",
          executionGeneration: 1
        },
        reward: null,
        failureCategory: "setup_failed"
      }
    ] satisfies RunJournalEntry[];

    expect(planAttemptResume(["replay:task:empty:0"], entries)).toEqual([
      {
        attemptId: "replay:task:empty:0",
        action: "rerun_before_agent",
        nextExecutionGeneration: 2
      }
    ]);
    await expect(
      readEntries([
        ...entries,
        {
          ...base,
          sequence: 2,
          type: "attempt_state",
          attemptId: "replay:task:empty:0",
          executionGeneration: 2,
          state: "admitted"
        }
      ])
    ).resolves.toHaveLength(3);
  });

  it("does not retry a setup-labelled result after the agent started", () => {
    const entries = [
      {
        ...base,
        sequence: 0,
        type: "attempt_state" as const,
        attemptId: "replay:task:empty:0",
        executionGeneration: 1,
        state: "admitted" as const
      },
      {
        ...base,
        sequence: 1,
        type: "attempt_state" as const,
        attemptId: "replay:task:empty:0",
        executionGeneration: 1,
        state: "agent_started" as const
      },
      {
        ...base,
        sequence: 2,
        type: "attempt_result" as const,
        attemptId: "replay:task:empty:0",
        executionGeneration: 1,
        resultPath: "attempts/task/empty/0/generation-1/failure-result.json",
        resultSha256: `sha256:${"a".repeat(64)}`,
        resultIdentity: {
          attemptId: "replay:task:empty:0",
          executionGeneration: 1
        },
        reward: null,
        failureCategory: "setup_failed"
      }
    ] satisfies RunJournalEntry[];

    expect(planAttemptResume(["replay:task:empty:0"], entries)).toEqual([
      {
        attemptId: "replay:task:empty:0",
        action: "skip_completed",
        nextExecutionGeneration: 1
      }
    ]);
  });
});
