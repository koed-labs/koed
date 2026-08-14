import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectOracleCampaignDefinition,
  parseOracleCampaignDefinition
} from "./oracle-campaign-manifest.js";
import { parseOracleQualificationManifest } from "./oracle-qualification-manifest.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe("private oracle manifests", () => {
  it("separates a fixed campaign universe from its shard", () => {
    const parsed = parseOracleCampaignDefinition({
      schema_version: "koed-oracle-campaign-definition-v1",
      campaign_id: "luna-v9-tb3",
      task_universe_digests: [digest("b"), digest("a")],
      shard_id: "day-1",
      shard_task_digests: [digest("b")],
      reference_score: 0.208
    });
    expect(parsed.taskUniverseDigests).toEqual([digest("a"), digest("b")]);
    expect(parsed.shardTaskDigests).toEqual([digest("b")]);
    expect(parsed.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a shard outside its universe and duplicate qualification tasks", () => {
    expect(() =>
      parseOracleCampaignDefinition({
        schema_version: "koed-oracle-campaign-definition-v1",
        campaign_id: "campaign",
        task_universe_digests: [digest("a")],
        shard_id: "shard",
        shard_task_digests: [digest("b")],
        reference_score: 0.208
      })
    ).toThrow("outside the universe");
    expect(() =>
      parseOracleQualificationManifest({
        schema_version: "koed-oracle-qualification-manifest-v1",
        tasks: [
          {
            task_digest: digest("a"),
            oracle_brief: "Use the verified implementation.",
            maximum_attempts: 2
          },
          {
            task_digest: digest("a"),
            oracle_brief: "Duplicate.",
            maximum_attempts: 2
          }
        ]
      })
    ).toThrow("unique");
  });

  it("requires a private 0600 campaign definition outside the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-campaign-"));
    const manifestPath = path.join(root, "campaign.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema_version: "koed-oracle-campaign-definition-v1",
        campaign_id: "campaign",
        task_universe_digests: [digest("a")],
        shard_id: "shard",
        shard_task_digests: [digest("a")],
        reference_score: 0.208
      }),
      { mode: 0o644 }
    );
    await expect(
      inspectOracleCampaignDefinition({
        manifestPath,
        repositoryRoot: process.cwd()
      })
    ).rejects.toThrow("0600");
    await chmod(manifestPath, 0o600);
    await expect(
      inspectOracleCampaignDefinition({
        manifestPath,
        repositoryRoot: process.cwd()
      })
    ).resolves.toMatchObject({ campaignId: "campaign", shardId: "shard" });
  });
});
