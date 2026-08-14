import { describe, expect, it } from "vitest";
import {
  retrievalArenaCases,
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash
} from "./cases.js";
import {
  productStateManifestSchema,
  stableHash,
  type ProductStateManifest
} from "./contracts.js";
import {
  attestLiveProductState,
  liveCaseStateHash,
  seedLiveProductFixture,
  type LiveProductStateReader,
  type LiveStateRow
} from "./live-product-fixture.js";

const benchmarkCase = retrievalArenaCases[0]!;
const sourceIds = benchmarkCase.corpus.map(
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);
const rows = benchmarkCase.corpus.map<LiveStateRow>((item, index) => ({
  itemId: item.id,
  sourceType: item.sourceType,
  sourceId: sourceIds[index]!,
  ownerUserId: "00000000-0000-4000-8000-000000000099",
  visibility: "personal",
  eventType: "user_prompt",
  sessionId: "00000000-0000-4000-8000-000000000098",
  payload: { content: item.text },
  includeInEmbedding: true,
  includeInLcm: true,
  invalidatedAt: null,
  lcmNodes: [],
  curatedSources: []
}));
const manifest = (): ProductStateManifest =>
  productStateManifestSchema.parse({
    schemaVersion: "koed-retrieval-arena-product-state-v1",
    seed: "retrieval-arena-live-product-v1",
    datasetVersion: "koed-first-party-v3",
    datasetHash: retrievalArenaDatasetHash,
    corpusIdentity: retrievalArenaCorpusIdentity,
    runtimeIdentity: "runtime-a",
    cases: [
      {
        caseId: benchmarkCase.id,
        corpusHash: stableHash(benchmarkCase.corpus),
        stateHash: liveCaseStateHash(rows),
        itemIds: benchmarkCase.corpus.map((item) => item.id),
        productContextHash: stableHash(benchmarkCase.productContext),
        liveSources: benchmarkCase.corpus.map((item, index) => ({
          itemId: item.id,
          sourceType: item.sourceType,
          sourceId: sourceIds[index]
        }))
      }
    ]
  });

const reader = (
  stateRows: LiveStateRow[],
  runtime = "runtime-a"
): LiveProductStateReader => ({
  runtimeIdentity: async () => runtime,
  readCaseState: async () => stateRows
});

describe("Retrieval Arena live product fixture proof", () => {
  it("derives proof from independently observed rows and rejects stale state", async () => {
    const current = manifest();
    const proof = await attestLiveProductState({
      manifest: current,
      manifestHash: "f".repeat(64),
      caseId: benchmarkCase.id,
      baseUrl: "http://127.0.0.1:3000",
      configurationHash: "c".repeat(64),
      reader: reader(rows)
    });
    expect(proof.caseStateHash).toBe(liveCaseStateHash(rows));
    expect(proof.runtimeIdentity).toBe("runtime-a");

    const stale = rows.map((row, index) =>
      index === 0 ? { ...row, payload: { content: "changed live row" } } : row
    );
    await expect(
      attestLiveProductState({
        manifest: current,
        manifestHash: "f".repeat(64),
        caseId: benchmarkCase.id,
        baseUrl: "http://127.0.0.1:3000",
        configurationHash: "c".repeat(64),
        reader: reader(stale)
      })
    ).rejects.toThrow(/stale, incomplete/);
    await expect(
      attestLiveProductState({
        manifest: current,
        manifestHash: "f".repeat(64),
        caseId: benchmarkCase.id,
        baseUrl: "http://127.0.0.1:3000",
        configurationHash: "c".repeat(64),
        reader: reader(rows, "runtime-b")
      })
    ).rejects.toThrow(/another runtime/);
  });

  it("fails closed instead of substituting Personal events for Team/Curated/LCM cases", async () => {
    await expect(
      seedLiveProductFixture({
        baseUrl: "http://127.0.0.1:3000",
        authorization: "Bearer local-test",
        databaseUrl: "postgresql://local@127.0.0.1:5432/isolated",
        outputPath: "/tmp/must-not-be-created.json",
        caseIds: ["heldout-team-curated-hierarchy"]
      })
    ).rejects.toThrow(/unsupported.*requires curated_memory/);
  });
});
