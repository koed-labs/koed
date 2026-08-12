import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExplicitScaleTestTarget,
  deterministicSyntheticVector,
  observeRetrievalScaleScope,
  SCALE_EMBEDDING_COMPATIBILITY_MODEL,
  SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS,
  SCALE_SYNTHETIC_VECTOR_LABEL,
  verifyRetrievalScaleLoadFile
} from "./scale-importer.js";
import {
  generateRetrievalScaleLoad,
  retrievalScaleProfiles,
  scaleLoadIdentity
} from "./scale-runner.js";

describe("retrieval scale database guard", () => {
  it("requires a loopback, explicit, non-public test schema", () => {
    expect(() =>
      assertExplicitScaleTestTarget({
        databaseUrl: "postgresql://user:secret@db.example.com/koed",
        expectedDatabase: "koed",
        expectedSchema: "retrieval_scale_test"
      })
    ).toThrow(/loopback/);
    expect(() =>
      assertExplicitScaleTestTarget({
        databaseUrl: "postgresql://user:secret@127.0.0.1/koed",
        expectedDatabase: "koed",
        expectedSchema: "public"
      })
    ).toThrow(/non-public/);
    expect(() =>
      assertExplicitScaleTestTarget({
        databaseUrl: "postgresql://user:secret@127.0.0.1/koed_eval",
        expectedDatabase: "koed_eval",
        expectedSchema: "retrieval_scale_test"
      })
    ).not.toThrow();
  });
});

describe("retrieval scale generated load verification", () => {
  const profile = {
    ...retrievalScaleProfiles["development-smoke"],
    scope: {
      users: 2,
      teamWorkspaces: 1,
      projects: 2,
      sessions: 2,
      memoryEvents: 3,
      memoryNodes: 2,
      curatedMemories: 1,
      embeddings: 6
    }
  };

  it("accepts only the exact deterministic JSONL sequence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koed-scale-importer-"));
    try {
      const path = join(directory, "load.jsonl");
      const records = [...generateRetrievalScaleLoad(profile, "seed")];
      await writeFile(
        path,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
      );
      await expect(
        verifyRetrievalScaleLoadFile({ path, profile, seed: "seed" })
      ).resolves.toBe(6);
      records[1] = { ...records[1]!, text: "tampered background load" };
      await writeFile(
        path,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
      );
      await expect(
        verifyRetrievalScaleLoadFile({ path, profile, seed: "seed" })
      ).rejects.toThrow(/does not match/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("retrieval scale synthetic vectors and DB attestation", () => {
  it("creates deterministic, normalized, explicitly synthetic 1024d vectors", () => {
    const first = deterministicSyntheticVector("abc");
    expect(first).toBe(deterministicSyntheticVector("abc"));
    expect(first).not.toBe(deterministicSyntheticVector("def"));
    const values = first.slice(1, -1).split(",").map(Number);
    expect(values).toHaveLength(SCALE_SYNTHETIC_EMBEDDING_DIMENSIONS);
    expect(
      Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
    ).toBeCloseTo(1, 6);
    expect(SCALE_SYNTHETIC_VECTOR_LABEL).toContain("synthetic-deterministic");
    expect(SCALE_EMBEDDING_COMPATIBILITY_MODEL).toBe("qwen3-0.6b");
  });

  it("builds an attestation only from matching database counts", async () => {
    const profile = retrievalScaleProfiles["development-smoke"];
    const query = async () => ({
      rows: [
        {
          users: profile.scope.users,
          team_workspaces: profile.scope.teamWorkspaces,
          projects: profile.scope.projects,
          sessions: profile.scope.sessions,
          memory_events: profile.scope.memoryEvents,
          memory_nodes: profile.scope.memoryNodes,
          curated_memories: profile.scope.curatedMemories,
          embeddings: profile.scope.embeddings,
          queryable_vectors: profile.scope.embeddings,
          ownership_mismatches: 0
        }
      ]
    });
    const attestation = await observeRetrievalScaleScope({
      db: { query } as never,
      schema: "retrieval_scale_test",
      profile,
      seed: "seed",
      runtimeIdentity: "runtime-id",
      databaseIdentity: "koed_eval:retrieval_scale_test",
      observedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(attestation.loadIdentity).toBe(scaleLoadIdentity(profile, "seed"));
    expect(attestation.observedScope).toEqual(profile.scope);
    expect(attestation.databaseIdentity).toBe("koed_eval:retrieval_scale_test");
  });
});
