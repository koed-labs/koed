import { describe, expect, it } from "vitest";
import {
  createOracleCampaignProgress,
  createOracleCampaignProtocol,
  createOracleCampaignShard,
  wilsonInterval95,
  type OracleCampaignTaskResult
} from "./campaign.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const hash = (character: string) => character.repeat(64);

const protocol = () =>
  createOracleCampaignProtocol({
    campaignId: "luna-v9-tb3",
    campaignSeed: "frozen-campaign-1",
    taskUniverseDigests: [digest("c"), digest("a"), digest("b")],
    semanticConfigHash: hash("d"),
    memoryAnswerPromptVersion: "memory-answer-v9",
    mcpRecallPolicyVersion:
      "mcp-server-instructions-v4+memory-answer-tool-description-v4",
    concurrency: 4,
    pins: {
      harborCommit: hash("1"),
      terminalBenchCommit: hash("2"),
      corpusHash: hash("3"),
      uvLockHash: hash("4")
    }
  });

const result = (
  taskDigest: string,
  status: OracleCampaignTaskResult["status"]
): OracleCampaignTaskResult => ({
  taskDigest,
  status,
  corpusAttestationSha256:
    status === "pending" || status === "corpus_unqualified" ? null : hash("e"),
  reward: status === "passed" ? 1 : status === "failed" ? 0 : null,
  passed: status === "passed" ? true : status === "failed" ? false : null,
  elapsedMs: status === "pending" ? null : 100,
  tokens: status === "pending" ? null : 20,
  apiEquivalentCostUsd: status === "pending" ? null : 0.01,
  completedAt: status === "pending" ? null : "2026-08-14T10:00:00.000Z"
});

describe("oracle campaign protocol and shards", () => {
  it("creates a content-addressed protocol independent of input task order", () => {
    const first = protocol();
    const second = createOracleCampaignProtocol({
      campaignId: first.campaignId,
      campaignSeed: first.campaignSeed,
      taskUniverseDigests: [...first.taskUniverseDigests].reverse(),
      semanticConfigHash: first.semanticConfigHash,
      memoryAnswerPromptVersion: first.memoryAnswerPromptVersion,
      mcpRecallPolicyVersion: first.mcpRecallPolicyVersion,
      concurrency: first.concurrency,
      pins: first.pins
    });
    expect(second.protocolHash).toBe(first.protocolHash);
    expect(first.taskUniverseDigests).toEqual([
      digest("a"),
      digest("b"),
      digest("c")
    ]);
  });

  it("rejects incompatible and overlapping shards", () => {
    const value = protocol();
    const first = createOracleCampaignShard(value, {
      shardId: "day-1",
      selectedTaskDigests: [digest("a"), digest("b")],
      createdAt: "2026-08-14T10:00:00.000Z"
    });
    const overlap = createOracleCampaignShard(value, {
      shardId: "day-2",
      selectedTaskDigests: [digest("b"), digest("c")],
      createdAt: "2026-08-15T10:00:00.000Z"
    });
    expect(() =>
      createOracleCampaignProgress({
        protocol: value,
        shards: [first, overlap],
        results: [],
        generatedAt: "2026-08-15T11:00:00.000Z"
      })
    ).toThrow("overlapping task units");

    const changed = {
      ...structuredClone(first),
      campaignProtocolHash: hash("f")
    };
    expect(() =>
      createOracleCampaignProgress({
        protocol: value,
        shards: [changed],
        results: [],
        generatedAt: "2026-08-15T11:00:00.000Z"
      })
    ).toThrow("hash mismatch");
  });
});

describe("oracle campaign progress", () => {
  it("reports a cumulative score, Wilson interval and visible corpus failures", () => {
    const value = protocol();
    const shard = createOracleCampaignShard(value, {
      shardId: "all",
      selectedTaskDigests: value.taskUniverseDigests,
      createdAt: "2026-08-14T10:00:00.000Z"
    });
    const progress = createOracleCampaignProgress({
      protocol: value,
      shards: [shard],
      results: [
        result(digest("a"), "passed"),
        result(digest("b"), "failed"),
        result(digest("c"), "corpus_unqualified")
      ],
      generatedAt: "2026-08-14T11:00:00.000Z"
    });
    expect(progress).toMatchObject({
      selectedTasks: 3,
      pendingTasks: 0,
      qualifiedTasks: 2,
      unqualifiedTasks: 1,
      completedEvaluations: 2,
      passedTasks: 1,
      failedTasks: 1,
      score: 0.5,
      elapsedMs: 300,
      tokens: 60,
      apiEquivalentCostUsd: 0.03
    });
    expect(progress.percentagePointDeltaFromReference).toBeCloseTo(29.2, 10);
    expect(progress.scoreWilson95?.lower).toBeCloseTo(0.0945, 3);
    expect(progress.scoreWilson95?.upper).toBeCloseTo(0.9055, 3);
  });

  it("fills omitted selected tasks as pending", () => {
    const value = protocol();
    const shard = createOracleCampaignShard(value, {
      shardId: "partial-results",
      selectedTaskDigests: [digest("a"), digest("b")],
      createdAt: "2026-08-14T10:00:00.000Z"
    });
    const progress = createOracleCampaignProgress({
      protocol: value,
      shards: [shard],
      results: [result(digest("a"), "passed")],
      generatedAt: "2026-08-14T11:00:00.000Z"
    });
    expect(progress.pendingTasks).toBe(1);
    expect(
      progress.results.find((item) => item.taskDigest === digest("b"))
    ).toMatchObject({ status: "pending" });
  });

  it("validates Wilson inputs", () => {
    expect(wilsonInterval95(0, 0)).toBeNull();
    expect(() => wilsonInterval95(2, 1)).toThrow("outside their valid range");
  });
});
