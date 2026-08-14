import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseExperienceReplayCommand } from "./command.js";
import { planAttemptResume, readRunJournal, RunJournal } from "./journal.js";
import { SafeRunDirectory } from "./output-path.js";

describe("experience replay command parsing", () => {
  it("parses the five strict command shapes", () => {
    expect(
      parseExperienceReplayCommand([
        "run",
        "--config",
        "run.json",
        "--confirm-paid-run"
      ])
    ).toEqual({
      name: "run",
      configPath: "run.json",
      confirmPaidRun: true,
      productPathProof: false,
      oracleSeededProof: false,
      oracleRepeatedStudy: false,
      oracleCampaign: false,
      oracleCorpusQualification: false,
      oracleBriefPath: null,
      oracleCorpusPath: null,
      oracleCampaignManifestPath: null,
      oracleQualificationManifestPath: null,
      oracleRepeats: null,
      codexSubscription: false
    });
    expect(
      parseExperienceReplayCommand(["resume", "--run", "/tmp/run"])
    ).toEqual({
      name: "resume",
      runDirectory: "/tmp/run"
    });
    expect(
      parseExperienceReplayCommand(["--", "run", "--config", "run.json"])
    ).toEqual({
      name: "run",
      configPath: "run.json",
      confirmPaidRun: false,
      productPathProof: false,
      oracleSeededProof: false,
      oracleRepeatedStudy: false,
      oracleCampaign: false,
      oracleCorpusQualification: false,
      oracleBriefPath: null,
      oracleCorpusPath: null,
      oracleCampaignManifestPath: null,
      oracleQualificationManifestPath: null,
      oracleRepeats: null,
      codexSubscription: false
    });
    expect(
      parseExperienceReplayCommand([
        "preflight",
        "--config",
        "proof.json",
        "--confirm-paid-run",
        "--product-path-proof",
        "--codex-subscription"
      ])
    ).toEqual({
      name: "preflight",
      configPath: "proof.json",
      confirmPaidRun: true,
      productPathProof: true,
      oracleSeededProof: false,
      oracleRepeatedStudy: false,
      oracleCampaign: false,
      oracleCorpusQualification: false,
      oracleBriefPath: null,
      oracleCorpusPath: null,
      oracleCampaignManifestPath: null,
      oracleQualificationManifestPath: null,
      oracleRepeats: null,
      codexSubscription: true
    });
    expect(() =>
      parseExperienceReplayCommand(["report", "--config", "x"])
    ).toThrow("accepts only");
    expect(() =>
      parseExperienceReplayCommand(["run", "--config", "a", "--config", "b"])
    ).toThrow("Duplicate");
    expect(() =>
      parseExperienceReplayCommand([
        "resume",
        "--run",
        "/tmp/run",
        "--codex-subscription"
      ])
    ).toThrow("accepts only");
    expect(
      parseExperienceReplayCommand([
        "run",
        "--config",
        "oracle.json",
        "--oracle-seeded-proof",
        "--oracle-brief",
        "/tmp/brief.txt",
        "--oracle-corpus",
        "/tmp/corpus"
      ])
    ).toMatchObject({
      oracleSeededProof: true,
      oracleBriefPath: "/tmp/brief.txt",
      oracleCorpusPath: "/tmp/corpus",
      productPathProof: false
    });
    expect(
      parseExperienceReplayCommand([
        "run",
        "--config",
        "oracle.json",
        "--oracle-repeated-study",
        "--oracle-corpus",
        "/tmp/corpus",
        "--oracle-repeats",
        "3"
      ])
    ).toMatchObject({
      oracleRepeatedStudy: true,
      oracleCorpusPath: "/tmp/corpus",
      oracleRepeats: 3
    });
    expect(
      parseExperienceReplayCommand([
        "run",
        "--config",
        "campaign.json",
        "--oracle-campaign",
        "--oracle-campaign-manifest",
        "/tmp/campaign.json",
        "--oracle-corpus",
        "/tmp/corpora"
      ])
    ).toMatchObject({
      oracleCampaign: true,
      oracleCampaignManifestPath: "/tmp/campaign.json",
      oracleCorpusPath: "/tmp/corpora",
      oracleRepeatedStudy: false
    });
    expect(
      parseExperienceReplayCommand([
        "run",
        "--config",
        "campaign.json",
        "--oracle-qualify",
        "--oracle-qualification-manifest",
        "/tmp/qualification.json",
        "--oracle-corpus",
        "/tmp/corpora"
      ])
    ).toMatchObject({
      oracleCorpusQualification: true,
      oracleQualificationManifestPath: "/tmp/qualification.json",
      oracleCorpusPath: "/tmp/corpora"
    });
    expect(() =>
      parseExperienceReplayCommand([
        "run",
        "--config",
        "oracle.json",
        "--oracle-repeats",
        "0"
      ])
    ).toThrow("only with --oracle-repeated-study");
    expect(() =>
      parseExperienceReplayCommand([
        "run",
        "--config",
        "oracle.json",
        "--oracle-repeated-study",
        "--oracle-corpus",
        "/tmp/corpus",
        "--oracle-repeats",
        "101"
      ])
    ).toThrow("integer from 1 to 100");
    expect(() =>
      parseExperienceReplayCommand([
        "run",
        "--config",
        "oracle.json",
        "--oracle-seeded-proof"
      ])
    ).toThrow("requires exactly one");
    expect(() =>
      parseExperienceReplayCommand([
        "run",
        "--config",
        "oracle.json",
        "--oracle-seeded-proof",
        "--oracle-brief",
        "/tmp/brief.txt",
        "--product-path-proof"
      ])
    ).toThrow("mutually exclusive");
  });
});

describe("append-only resume journal", () => {
  it("fsyncs ordered records and distinguishes safe retries from missing outcomes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-journal-test-"));
    const repository = path.join(root, "repo");
    await mkdir(repository);
    const { directory } = await SafeRunDirectory.create({
      outputPath: path.join(root, "run"),
      repositoryRoot: repository,
      requiredBytes: 0,
      reserveBytes: 0
    });
    const journal = new RunJournal(
      directory,
      "config-hash",
      [],
      () => new Date(0)
    );
    await journal.append({
      type: "attempt_state",
      attemptId: "before-agent",
      executionGeneration: 1,
      state: "admitted"
    });
    await journal.append({
      type: "attempt_state",
      attemptId: "after-agent",
      executionGeneration: 1,
      state: "agent_started"
    });
    await journal.append({
      type: "attempt_result",
      attemptId: "complete",
      executionGeneration: 1,
      resultPath: "attempts/complete/result.json",
      resultSha256: `sha256:${"a".repeat(64)}`,
      resultIdentity: {
        attemptId: "complete",
        executionGeneration: 1
      },
      reward: 1,
      failureCategory: null
    });
    const entries = await readRunJournal(
      path.join(directory.root, "journal.jsonl"),
      "config-hash"
    );
    expect(
      planAttemptResume(["before-agent", "after-agent", "complete"], entries)
    ).toEqual([
      {
        attemptId: "before-agent",
        action: "rerun_before_agent",
        nextExecutionGeneration: 2
      },
      {
        attemptId: "after-agent",
        action: "preserve_missing",
        nextExecutionGeneration: 1
      },
      {
        attemptId: "complete",
        action: "skip_completed",
        nextExecutionGeneration: 1
      }
    ]);

    await expect(
      readRunJournal(
        path.join(directory.root, "journal.jsonl"),
        "different-hash"
      )
    ).rejects.toThrow("Configuration hash mismatch");
  });

  it("rejects a torn final append", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-journal-test-"));
    const journalPath = path.join(root, "journal.jsonl");
    await writeFile(journalPath, '{"version":1');
    await expect(readRunJournal(journalPath, "hash")).rejects.toThrow(
      "incomplete final record"
    );
  });

  it("rejects a symlinked journal on resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-journal-test-"));
    const target = path.join(root, "target.jsonl");
    const journalPath = path.join(root, "journal.jsonl");
    await writeFile(target, "");
    await symlink(target, journalPath);
    await expect(readRunJournal(journalPath, "hash")).rejects.toThrow(
      "symlink"
    );
  });

  it("serializes concurrent appends with contiguous sequences", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-journal-test-"));
    const repository = path.join(root, "repo");
    await mkdir(repository);
    const { directory } = await SafeRunDirectory.create({
      outputPath: path.join(root, "run"),
      repositoryRoot: repository,
      requiredBytes: 0,
      reserveBytes: 0
    });
    const journal = new RunJournal(directory, "config-hash");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        journal.append({
          type: "attempt_state",
          attemptId: `attempt-${index}`,
          executionGeneration: 1,
          state: "admitted"
        })
      )
    );
    const entries = await readRunJournal(
      path.join(directory.root, "journal.jsonl"),
      "config-hash"
    );
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index)
    );
  });

  it("rejects malformed resume fields before planning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-journal-test-"));
    const journalPath = path.join(root, "journal.jsonl");
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 1,
        sequence: 0,
        configurationHash: "hash",
        recordedAt: new Date(0).toISOString(),
        type: "attempt_state",
        attemptId: "attempt",
        executionGeneration: -1,
        state: "admitted"
      })}\n`
    );
    await expect(readRunJournal(journalPath, "hash")).rejects.toThrow(
      "Malformed attempt"
    );
  });
});
