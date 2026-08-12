import {
  EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";

export const noAnchorRetrievalComposition =
  "retrieval-arena-structured-summary-v2:summary_text+empty_lexical_anchors";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const noAnchorEmbeddingInput = (summary: {
  title: string;
  summary_text: string;
}): string => summary.summary_text;

export const noAnchorEmbeddingGeneration = (): string => {
  const canonical = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
  return [
    `model=${canonical.key}`,
    `artifact-sha256=${canonical.defaultArtifactSha256}`,
    `tokenizer=${canonical.tokenizer}`,
    `tokenizer-revision=${canonical.tokenizerRevision}`,
    `document-transform=${EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM}`,
    `pooling=${canonical.pooling}`,
    `normalization=${canonical.normalization}`
  ].join("|");
};

const structuredSummarySchema = z
  .object({
    schema_version: z.literal("lcm-semantic-summary-v1"),
    title: z.string().trim().min(1).max(120),
    summary_text: z.string().trim().min(1),
    lexical_anchors: z.tuple([])
  })
  .strict();

const noAnchorIndexManifestSchema = z
  .object({
    schemaVersion: z.literal("retrieval-arena-no-anchor-index-v1"),
    runtimeBaseUrl: z.string().url(),
    embedding: z
      .object({
        model: z.string().min(1),
        dimensions: z.number().int().positive(),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
        tokenizer: z.string().min(1),
        tokenizerRevision: z.string().min(1),
        generation: z.string().min(1),
        composition: z.literal(noAnchorRetrievalComposition)
      })
      .strict(),
    indexIdentity: z
      .object({
        databaseName: z.string().min(1),
        schemaName: z.string().min(1),
        documentSetSha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict(),
    documents: z
      .array(
        z
          .object({
            sourceId: z.string().min(1),
            embeddingId: z.string().uuid(),
            sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
            vectorSha256: z.string().regex(/^[a-f0-9]{64}$/),
            structuredSummary: structuredSummarySchema,
            embeddingInput: z.string().min(1),
            embeddingInputSha256: z.string().regex(/^[a-f0-9]{64}$/),
            embeddingGeneration: z.string().min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export interface RetrievalCapabilityResponse {
  capabilitySchemaVersion: 1;
  retrieval:
    | { composition: "production"; lexicalAnchors: true }
    | {
        composition: typeof noAnchorRetrievalComposition;
        lexicalAnchors: false;
        indexProofHash: string;
        embeddingGeneration: string;
      };
}

const unavailable = (message: string): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode: 503 });

const normalizedUrl = (value: string): string => value.replace(/\/$/, "");

export const resolveRetrievalCapability = async (
  options: {
    environment?: NodeJS.ProcessEnv;
    runtimeEmbeddingModel?: string;
    ownerUserId?: string;
    runtimeIndexProof?: (input: {
      ownerUserId: string;
      sourceIds: string[];
      model: string;
      dimensions: number;
      version: string;
    }) => Promise<{
      databaseName: string;
      schemaName: string;
      documents: Array<{
        sourceId: string;
        embeddingId: string;
        sourceHash: string;
        embeddingInputSha256: string;
        vectorSha256: string;
      }>;
    }>;
  } = {}
): Promise<RetrievalCapabilityResponse> => {
  const environment = options.environment ?? process.env;
  const manifestPath = environment.KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST?.trim();
  const configuredProofHash =
    environment.KOED_EVAL_NO_LEXICAL_INDEX_PROOF_SHA256?.trim();
  if (!manifestPath && !configuredProofHash) {
    return {
      capabilitySchemaVersion: 1,
      retrieval: { composition: "production", lexicalAnchors: true }
    };
  }
  if (!manifestPath || !configuredProofHash) {
    throw unavailable(
      "isolated Retrieval Arena capability requires both manifest and proof SHA-256 configuration"
    );
  }
  if (!/^[a-f0-9]{64}$/.test(configuredProofHash)) {
    throw unavailable(
      "isolated Retrieval Arena capability proof SHA-256 is invalid"
    );
  }
  const runtimeBaseUrl = environment.MEMORY_API_URL?.trim();
  if (!runtimeBaseUrl) {
    throw unavailable(
      "isolated Retrieval Arena capability requires MEMORY_API_URL"
    );
  }

  let raw: string;
  try {
    raw = await readFile(resolve(manifestPath), "utf8");
  } catch (error) {
    throw unavailable(
      `isolated Retrieval Arena index manifest cannot be read: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  const proofHash = sha256(raw);
  if (proofHash !== configuredProofHash) {
    throw unavailable(
      "isolated Retrieval Arena index manifest does not match its configured proof SHA-256"
    );
  }

  let manifest: z.infer<typeof noAnchorIndexManifestSchema>;
  try {
    manifest = noAnchorIndexManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw unavailable(
      `isolated Retrieval Arena index manifest is invalid: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  if (
    normalizedUrl(manifest.runtimeBaseUrl) !== normalizedUrl(runtimeBaseUrl)
  ) {
    throw unavailable(
      "isolated Retrieval Arena index manifest targets another runtime"
    );
  }

  const canonical = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
  const runtimeEmbedding = resolveSupportedEmbeddingModelConfig(
    options.runtimeEmbeddingModel
  );
  const expectedGeneration = noAnchorEmbeddingGeneration();
  if (
    runtimeEmbedding.key !== canonical.key ||
    manifest.embedding.model !== runtimeEmbedding.key ||
    manifest.embedding.dimensions !== runtimeEmbedding.dimensions ||
    manifest.embedding.artifactHash !==
      runtimeEmbedding.defaultArtifactSha256 ||
    manifest.embedding.tokenizer !== runtimeEmbedding.tokenizer ||
    manifest.embedding.tokenizerRevision !==
      runtimeEmbedding.tokenizerRevision ||
    manifest.embedding.generation !== expectedGeneration
  ) {
    throw unavailable(
      "isolated Retrieval Arena index manifest does not match the runtime embedding configuration"
    );
  }
  for (const document of manifest.documents) {
    const expectedInput = noAnchorEmbeddingInput(document.structuredSummary);
    if (
      document.embeddingInput !== expectedInput ||
      document.embeddingInputSha256 !== sha256(expectedInput) ||
      document.embeddingGeneration !== expectedGeneration
    ) {
      throw unavailable(
        `isolated Retrieval Arena index manifest contains a stale or anchor-influenced embedding for ${document.sourceId}`
      );
    }
  }
  if (!options.runtimeIndexProof) {
    throw unavailable(
      "isolated Retrieval Arena capability requires live database/index attestation"
    );
  }
  if (!options.ownerUserId) {
    throw unavailable(
      "isolated Retrieval Arena capability requires an authenticated owner boundary"
    );
  }
  let runtimeIndex: Awaited<
    ReturnType<NonNullable<typeof options.runtimeIndexProof>>
  >;
  try {
    runtimeIndex = await options.runtimeIndexProof({
      ownerUserId: options.ownerUserId,
      sourceIds: manifest.documents.map((document) => document.sourceId),
      model: runtimeEmbedding.key,
      dimensions: runtimeEmbedding.dimensions,
      version: runtimeEmbedding.key
    });
  } catch (error) {
    throw unavailable(
      `isolated Retrieval Arena live index proof failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  if (
    runtimeIndex.databaseName !== manifest.indexIdentity.databaseName ||
    runtimeIndex.schemaName !== manifest.indexIdentity.schemaName
  ) {
    throw unavailable(
      "isolated Retrieval Arena manifest targets different database rows"
    );
  }
  const canonicalDocuments = (documents: typeof runtimeIndex.documents) =>
    [...documents].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId)
    );
  const runtimeDocuments = canonicalDocuments(runtimeIndex.documents);
  const declaredDocuments = canonicalDocuments(
    manifest.documents.map((document) => ({
      sourceId: document.sourceId,
      embeddingId: document.embeddingId,
      sourceHash: document.sourceHash,
      embeddingInputSha256: document.embeddingInputSha256,
      vectorSha256: document.vectorSha256
    }))
  );
  const runtimeDocumentSetSha256 = sha256(JSON.stringify(runtimeDocuments));
  if (
    JSON.stringify(runtimeDocuments) !== JSON.stringify(declaredDocuments) ||
    runtimeDocumentSetSha256 !== manifest.indexIdentity.documentSetSha256
  ) {
    throw unavailable(
      "isolated Retrieval Arena manifest is stale or mismatched with live index rows/vectors"
    );
  }

  return {
    capabilitySchemaVersion: 1,
    retrieval: {
      composition: noAnchorRetrievalComposition,
      lexicalAnchors: false,
      indexProofHash: proofHash,
      embeddingGeneration: expectedGeneration
    }
  };
};

export const retrievalIndexProof = (
  capability: RetrievalCapabilityResponse
): { indexProofHash: string } | undefined =>
  capability.retrieval.composition === noAnchorRetrievalComposition
    ? { indexProofHash: capability.retrieval.indexProofHash }
    : undefined;

export const registerRetrievalCapabilityRoute = (
  app: FastifyInstance,
  options: {
    authenticate(request: FastifyRequest): Promise<{ id: string }>;
    runtimeEmbeddingModel?: string;
    environment?: NodeJS.ProcessEnv;
    runtimeIndexProof?: NonNullable<
      Parameters<typeof resolveRetrievalCapability>[0]
    >["runtimeIndexProof"];
  }
): void => {
  app.get("/v1/memory/retrieval-capabilities", async (request) => {
    const user = await options.authenticate(request);
    return resolveRetrievalCapability({
      environment: options.environment,
      runtimeEmbeddingModel: options.runtimeEmbeddingModel,
      runtimeIndexProof: options.runtimeIndexProof,
      ownerUserId: user.id
    });
  });
};
