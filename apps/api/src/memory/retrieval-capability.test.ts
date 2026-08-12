import {
  EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  noAnchorEmbeddingGeneration,
  noAnchorEmbeddingInput,
  noAnchorRetrievalComposition,
  registerRetrievalCapabilityRoute
} from "./retrieval-capability.js";

const temporaryDirectories: string[] = [];
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const manifestDocument = () => {
  const canonical = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
  const generation = noAnchorEmbeddingGeneration();
  const structuredSummary = {
    schema_version: "lcm-semantic-summary-v1" as const,
    title: "Isolated summary",
    summary_text: "This summary was composed without lexical anchors.",
    lexical_anchors: [] as []
  };
  const embeddingInput = noAnchorEmbeddingInput(structuredSummary);
  const runtimeRow = {
    sourceId: "00000000-0000-4000-8000-000000000010",
    embeddingId: "00000000-0000-4000-8000-000000000011",
    sourceHash: "1".repeat(64),
    embeddingInputSha256: sha256(embeddingInput),
    vectorSha256: "2".repeat(64)
  };
  return {
    schemaVersion: "retrieval-arena-no-anchor-index-v1",
    runtimeBaseUrl: "http://isolated.test",
    embedding: {
      model: canonical.key,
      dimensions: canonical.dimensions,
      artifactHash: canonical.defaultArtifactSha256,
      tokenizer: canonical.tokenizer,
      tokenizerRevision: canonical.tokenizerRevision,
      generation,
      composition: noAnchorRetrievalComposition
    },
    indexIdentity: {
      databaseName: "koed_isolated",
      schemaName: "public",
      documentSetSha256: sha256(JSON.stringify([runtimeRow]))
    },
    documents: [
      {
        ...runtimeRow,
        structuredSummary,
        embeddingInput,
        embeddingGeneration: generation
      }
    ]
  };
};

const createCapabilityApi = async (
  manifest: unknown,
  options: {
    proofHash?: string;
    includeManifest?: boolean;
    runtimeVectorSha256?: string;
  } = {}
) => {
  const directory = await mkdtemp(join(tmpdir(), "koed-capability-"));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, "index.json");
  const raw = JSON.stringify(manifest);
  await writeFile(manifestPath, raw);
  const environment: NodeJS.ProcessEnv = {
    MEMORY_API_URL: "http://isolated.test",
    ...(options.includeManifest === false
      ? {}
      : { KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST: manifestPath }),
    ...(options.proofHash === undefined
      ? { KOED_EVAL_NO_LEXICAL_INDEX_PROOF_SHA256: sha256(raw) }
      : options.proofHash
        ? { KOED_EVAL_NO_LEXICAL_INDEX_PROOF_SHA256: options.proofHash }
        : {})
  };
  const app = Fastify();
  const authenticatedOwnerId = "11111111-1111-4111-8111-111111111111";
  let proofOwnerId: string | undefined;
  registerRetrievalCapabilityRoute(app, {
    authenticate: async () => ({ id: authenticatedOwnerId }),
    runtimeEmbeddingModel: "qwen3-0.6b",
    environment,
    runtimeIndexProof: async (input) => {
      proofOwnerId = input.ownerUserId;
      const parsed = manifest as ReturnType<typeof manifestDocument>;
      return {
        databaseName: parsed.indexIdentity.databaseName,
        schemaName: parsed.indexIdentity.schemaName,
        documents: parsed.documents.map((document) => ({
          sourceId: document.sourceId,
          embeddingId: document.embeddingId,
          sourceHash: document.sourceHash,
          embeddingInputSha256: document.embeddingInputSha256,
          vectorSha256: options.runtimeVectorSha256 ?? document.vectorSha256
        }))
      };
    }
  });
  return { app, raw, authenticatedOwnerId, proofOwnerId: () => proofOwnerId };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Retrieval Arena isolated-index capability API", () => {
  it("keeps the normal production composition when no isolated index is configured", async () => {
    const app = Fastify();
    registerRetrievalCapabilityRoute(app, {
      authenticate: async () => ({
        id: "11111111-1111-4111-8111-111111111111"
      }),
      runtimeEmbeddingModel: "qwen3-0.6b",
      environment: {}
    });
    const response = await app.inject("/v1/memory/retrieval-capabilities");
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      capabilitySchemaVersion: 1,
      retrieval: { composition: "production", lexicalAnchors: true }
    });
  });

  it("returns the exact no-anchor composition, manifest proof, and derived generation", async () => {
    const { app, raw, authenticatedOwnerId, proofOwnerId } =
      await createCapabilityApi(manifestDocument());
    const response = await app.inject("/v1/memory/retrieval-capabilities");
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      capabilitySchemaVersion: 1,
      retrieval: {
        composition: noAnchorRetrievalComposition,
        lexicalAnchors: false,
        indexProofHash: sha256(raw),
        embeddingGeneration: noAnchorEmbeddingGeneration()
      }
    });
    expect(noAnchorEmbeddingGeneration()).toContain(
      `document-transform=${EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM}`
    );
    expect(proofOwnerId()).toBe(authenticatedOwnerId);
  });

  it("fails closed when the manifest or proof is absent or mismatched", async () => {
    for (const options of [
      { includeManifest: false },
      { proofHash: "" },
      { proofHash: "a".repeat(64) }
    ]) {
      const { app } = await createCapabilityApi(manifestDocument(), options);
      const response = await app.inject("/v1/memory/retrieval-capabilities");
      await app.close();
      expect(response.statusCode).toBe(503);
    }
  });

  it("rejects stale or anchor-influenced indexed inputs", async () => {
    const manifest = manifestDocument();
    manifest.documents[0]!.embeddingInput +=
      "\nLegacy anchors: [REQUEST_BODY_LIMIT_BYTES]";
    const { app } = await createCapabilityApi(manifest);
    const response = await app.inject("/v1/memory/retrieval-capabilities");
    await app.close();
    expect(response.statusCode).toBe(503);
    expect(response.json<{ message: string }>().message).toMatch(
      /stale or anchor-influenced embedding/
    );
  });

  it("rejects a self-consistent manifest when the live runtime vector differs", async () => {
    const { app } = await createCapabilityApi(manifestDocument(), {
      runtimeVectorSha256: "f".repeat(64)
    });
    const response = await app.inject("/v1/memory/retrieval-capabilities");
    await app.close();
    expect(response.statusCode).toBe(503);
    expect(response.json<{ message: string }>().message).toMatch(
      /stale or mismatched with live index rows\/vectors/
    );
  });
});
