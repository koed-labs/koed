import type {
  HistoricalImportRunDetail,
  HistoricalImportRunRecord,
  HistoricalImportSourceRecord,
  MemorySourceRepository
} from "@koed-labs/db";
import { parseClaudeHistoricalImportBytes } from "@koed-labs/mcp-server/claude-transcript-parser";
import {
  buildCodexHistoricalJournalRange,
  type TranscriptJournalParserState
} from "@koed-labs/mcp-server/codex-transcript-parser";
import {
  buildPiHistoricalJournalRange,
  type PiSessionParserState
} from "@koed-labs/mcp-server/pi-session-parser";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { readConversationSourceSegmentBytes } from "./conversation-source-journal-routes.js";
import {
  createFilesystemConversationSourceStorage,
  type ConversationSourceStorage
} from "./conversation-source-storage.js";
import {
  createHistoricalImportSourceSchema,
  historicalImportBatchSchema,
  historicalImportJournalRangeItemSchema,
  historicalImportJournalRangeSchema,
  historicalImportRunListSchema,
  historicalImportRunParamsSchema,
  historicalImportSourceLookupSchema,
  historicalImportSourceParamsSchema,
  historicalImportTransitionSchema
} from "./historical-import-schemas.js";

const localProfiles = new Set(["developer", "local_personal"]);

const requireLocalImportSurface = (context: ApiRouteContext): void => {
  if (!localProfiles.has(context.config.deploymentProfile)) {
    throw Object.assign(new Error("Historical import is local-only"), {
      statusCode: 404
    });
  }
};

const safeProjectProvenance = (
  project: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    ["projectId", "name", "branch", "ref", "fingerprint"]
      .filter((key) => project[key] !== undefined)
      .map((key) => [key, project[key]])
  );

const safeParserState = (
  state: Record<string, unknown>
): Record<string, string | boolean> =>
  Object.fromEntries(
    [
      "activeTurnId",
      "currentTurnId",
      "lastEventTime",
      "assistantMessagePreference"
    ]
      .filter((key) => ["string", "boolean"].includes(typeof state[key]))
      .map((key) => [key, state[key] as string | boolean])
  );

const presentSource = (
  source: HistoricalImportSourceRecord,
  options: { includeResumeState?: boolean } = {}
) => {
  const safe = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        key !== "redactedSourceLabel" &&
        key !== "detectedProject" &&
        key !== "historicalCursorParserState" &&
        key !== "historicalCursorCurrentTurnId"
    )
  );
  return {
    ...safe,
    ...(options.includeResumeState
      ? {
          historicalCursorParserState: safeParserState(
            source.historicalCursorParserState
          ),
          ...(source.historicalCursorCurrentTurnId
            ? {
                historicalCursorCurrentTurnId:
                  source.historicalCursorCurrentTurnId
              }
            : {})
        }
      : {}),
    sourceLabel: source.redactedSourceLabel,
    detectedProject: safeProjectProvenance(source.detectedProject)
  };
};

const presentRun = (
  run: HistoricalImportRunRecord | HistoricalImportRunDetail
) => ({
  ...run,
  ...("sources" in run
    ? { sources: run.sources.map((source) => presentSource(source)) }
    : {})
});

const requireSource = async (
  repo: MemorySourceRepository,
  userId: string,
  sourceId: string
): Promise<HistoricalImportSourceRecord> => {
  const source = await repo.getHistoricalImportSource({ userId }, sourceId);
  if (!source) {
    throw Object.assign(new Error("Historical import source not found"), {
      statusCode: 404
    });
  }
  return source;
};

// A rejected transition is either already applied, a completion that still
// waits for downstream work, or a conflict with another state change.
const transitionConflict = (
  kind: "run" | "source",
  current: { state: string } | null,
  input: { expectedState: string; state: string }
): Error => {
  const label =
    kind === "run" ? "Historical import run" : "Historical import source";
  if (current?.state === input.state)
    return Object.assign(new Error(`${label} transition already applied`), {
      statusCode: 409,
      code: "historical_import_transition_already_applied"
    });
  if (current?.state === input.expectedState && input.state === "completed")
    return Object.assign(new Error(`${label} completion is pending`), {
      statusCode: 409,
      code: "historical_import_completion_pending"
    });
  return Object.assign(new Error(`${label} state conflict`), {
    statusCode: 409,
    code: "historical_import_state_conflict"
  });
};

const policyProjectId = (
  source: HistoricalImportSourceRecord
): string | undefined => {
  for (const key of ["projectId", "path", "cwd"] as const) {
    const value = source.detectedProject[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const requireImportPolicy = async (
  context: ApiRouteContext,
  repo: MemorySourceRepository,
  userId: string,
  source: HistoricalImportSourceRecord
) => {
  const policy = await context.capture.resolveCapturePolicyForRequest(
    repo,
    { userId },
    {
      projectId: policyProjectId(source),
      threadId: source.sourceSessionId
    }
  );
  if (
    policy.visibility !== "personal" ||
    policy.captureState !== "enabled" ||
    policy.paused
  ) {
    throw Object.assign(
      new Error("Historical import blocked by effective Capture Policy"),
      { statusCode: 409, code: "historical_import_capture_policy_blocked" }
    );
  }
  return policy;
};

type HistoricalBatchInput = ReturnType<
  typeof historicalImportBatchSchema.parse
>;
type HistoricalJournalRangeInput = ReturnType<
  typeof historicalImportJournalRangeSchema.parse
>;

// A record index reserves 1000 source sequences, one per content block, and
// an item batch carries at most as many items.
const JOURNAL_RANGE_MAXIMUM_ITEMS = 1_000;

const journalRangeError = (
  statusCode: number,
  code: string,
  message: string
): Error => Object.assign(new Error(message), { statusCode, code });

const journalRangeInvalid = (message: string): Error =>
  journalRangeError(422, "historical_import_journal_range_invalid", message);

const journalRangeTooManyItems = (): Error =>
  journalRangeError(
    422,
    "historical_import_journal_range_too_many_items",
    "Journal range holds more items than one range may contribute"
  );

type JournalRangeBuildInput = {
  bytes: Buffer;
  absoluteStartOffset: number;
  source: HistoricalImportSourceRecord;
  sourceComponentId: string;
  request: HistoricalJournalRangeInput;
};

/**
 * How one AI Client's journal range becomes items. `build` runs the parser
 * and mapping that client's importer uses for an item batch, so both paths
 * store the same items.
 */
type JournalRangeAdapter = {
  /** Whether a range may hold several complete records. */
  severalRecords: boolean;
  /** Request fields this adapter needs or refuses, checked before any read. */
  checkRequest(request: HistoricalJournalRangeInput): void;
  build(input: JournalRangeBuildInput): {
    items: unknown[];
    /** Set when the parser may stop short of the range end. */
    resolvedOffset?: number;
    sourceLine: number;
    parserState: Record<string, unknown>;
  };
  /** Whether a build error means the stored record cannot be imported. */
  rejectsRecord(error: Error): boolean;
};

const refuseThreadContext = (request: HistoricalJournalRangeInput): void => {
  if (
    request.threadKind !== undefined ||
    request.parentThreadId !== undefined
  ) {
    throw journalRangeInvalid(
      "Thread context applies to Codex journal ranges only"
    );
  }
};

const codexJournalRangeAdapter: JournalRangeAdapter = {
  // A deferred assistant event resolves only together with the record
  // after it, so the unit the importer could not send may be several.
  severalRecords: true,
  checkRequest(request) {
    if (request.threadKind === undefined) {
      throw journalRangeInvalid("A Codex journal range needs its thread kind");
    }
  },
  build({ bytes, absoluteStartOffset, source, request }) {
    return buildCodexHistoricalJournalRange({
      bytes,
      absoluteStartOffset,
      lineIndexOffset: source.historicalCursorLine,
      prior: source.historicalCursorParserState as TranscriptJournalParserState,
      sessionId: source.sessionId,
      sourceSessionId: source.sourceSessionId,
      sourceFingerprint: source.sourceFingerprint,
      threadKind: request.threadKind!,
      ...(request.parentThreadId
        ? { parentThreadId: request.parentThreadId }
        : {})
    });
  },
  rejectsRecord: (error) =>
    /malformed complete JSONL record/.test(error.message)
};

const journalRangeAdapters: Record<string, JournalRangeAdapter> = {
  // Legacy and paginated Codex histories share one importer.
  "codex-transcript-v1": codexJournalRangeAdapter,
  "codex-transcript-v2": codexJournalRangeAdapter,
  "claude-code-transcript-v1": {
    severalRecords: false,
    checkRequest: refuseThreadContext,
    build({ bytes, absoluteStartOffset, source, sourceComponentId }) {
      const currentTurnId = source.historicalCursorParserState.currentTurnId;
      const parsed = parseClaudeHistoricalImportBytes({
        bytes,
        absoluteStartOffset,
        lineIndexOffset: source.historicalCursorLine,
        sessionId: source.sessionId,
        externalSessionId: source.sourceSessionId,
        sourceFingerprint: source.sourceFingerprint,
        sourceComponentId,
        maximumItems: JOURNAL_RANGE_MAXIMUM_ITEMS,
        ...(typeof currentTurnId === "string"
          ? { prior: { currentTurnId } }
          : {})
      });
      return {
        items: parsed.items,
        sourceLine: parsed.checkpoint.lineCount,
        parserState: parsed.parserState
      };
    },
    rejectsRecord: (error) => error.message.startsWith("claude_transcript_")
  },
  "pi-session-v1": {
    severalRecords: false,
    checkRequest: refuseThreadContext,
    build({ bytes, absoluteStartOffset, source }) {
      return buildPiHistoricalJournalRange({
        bytes,
        absoluteStartOffset,
        lineIndexOffset: source.historicalCursorLine,
        prior: source.historicalCursorParserState as PiSessionParserState,
        sessionId: source.sessionId,
        sourceSessionId: source.sourceSessionId,
        sourceFingerprint: source.sourceFingerprint
      });
    },
    rejectsRecord: (error) => error.message.startsWith("pi_session_")
  }
};

/**
 * Builds the item batch for a journal range the client could not upload. The
 * range is read from the stored segment, so nothing here trusts client
 * content; the repository still revalidates the cursor and Capture Policy in
 * the transaction that writes the items.
 */
const journalRangeBatch = async (
  context: ApiRouteContext,
  journalStorage: () => ConversationSourceStorage,
  repo: MemorySourceRepository,
  userId: string,
  source: HistoricalImportSourceRecord,
  input: HistoricalJournalRangeInput
): Promise<HistoricalBatchInput> => {
  const adapter = Object.hasOwn(
    journalRangeAdapters,
    source.sourceAdapterVersion
  )
    ? journalRangeAdapters[source.sourceAdapterVersion]
    : undefined;
  if (!adapter) {
    throw journalRangeError(
      422,
      "historical_import_journal_range_unsupported",
      "Journal range import is not supported for this AI Client"
    );
  }
  adapter.checkRequest(input);
  // Refuse before reading stored content. The repository repeats both checks
  // in the transaction that writes the items.
  await requireImportPolicy(context, repo, userId, source);
  if (input.sourceOffset > source.registrationFrontierOffset) {
    throw journalRangeError(
      409,
      "historical_import_cursor_conflict",
      "Historical import cursor conflict"
    );
  }
  const actor = { userId };
  const [segment] = await repo.listConversationSourceSegmentsByIndex(actor, {
    artifactId: source.artifactId,
    afterSegmentIndex: input.segmentIndex - 1,
    throughSegmentIndex: input.segmentIndex,
    limit: 1
  });
  if (
    !segment ||
    segment.plaintextDigest !== input.lastVerifiedDigest ||
    input.expectedSourceOffset < segment.sourceStartOffset ||
    input.sourceOffset > segment.sourceEndOffset
  ) {
    throw journalRangeError(
      409,
      "historical_import_segment_verification_failed",
      "Historical import segment verification failed"
    );
  }
  const segmentBytes = Buffer.from(
    await readConversationSourceSegmentBytes(context, journalStorage(), segment)
  );
  const start = input.expectedSourceOffset - segment.sourceStartOffset;
  const records = segmentBytes.subarray(
    start,
    input.sourceOffset - segment.sourceStartOffset
  );
  // Complete records only: the range starts after a line end and ends with
  // one. Unless the adapter resolves records together, it holds exactly one.
  if (
    records.byteLength !== input.sourceOffset - input.expectedSourceOffset ||
    (start > 0 && segmentBytes[start - 1] !== 0x0a) ||
    records.at(-1) !== 0x0a ||
    (!adapter.severalRecords &&
      records.indexOf(0x0a) !== records.byteLength - 1)
  ) {
    throw journalRangeInvalid(
      adapter.severalRecords
        ? "Journal range must cover complete records"
        : "Journal range must cover exactly one complete record"
    );
  }
  const range = {
    expectedSourceOffset: input.expectedSourceOffset,
    sourceOffset: input.sourceOffset,
    segmentIndex: input.segmentIndex,
    lastVerifiedDigest: input.lastVerifiedDigest
  };
  if (source.historicalCursorOffset === input.sourceOffset) {
    // Already committed, for example after a lost response. The repository
    // answers with a replay, or with a conflict if the import moved on.
    return { ...range, sourceLine: source.historicalCursorLine, items: [] };
  }
  if (source.historicalCursorOffset !== input.expectedSourceOffset) {
    throw journalRangeError(
      409,
      "historical_import_cursor_conflict",
      "Historical import cursor conflict"
    );
  }
  const artifact = await repo.getConversationSourceArtifact(
    actor,
    source.artifactId
  );
  if (!artifact) {
    throw journalRangeError(
      409,
      "historical_import_artifact_unavailable",
      "Conversation Source Artifact is unavailable"
    );
  }
  let built: ReturnType<JournalRangeAdapter["build"]>;
  let items: HistoricalBatchInput["items"];
  try {
    built = adapter.build({
      bytes: records,
      absoluteStartOffset: input.expectedSourceOffset,
      source,
      sourceComponentId: artifact.sourceComponentId,
      request: input
    });
    if (
      built.resolvedOffset !== undefined &&
      built.resolvedOffset !== input.sourceOffset
    ) {
      // Committing the range would move the cursor past records that
      // produced no items.
      throw journalRangeInvalid(
        "Journal range ends in records that are not resolved yet"
      );
    }
    if (built.items.length > JOURNAL_RANGE_MAXIMUM_ITEMS) {
      throw journalRangeTooManyItems();
    }
    items = built.items.map((item) =>
      historicalImportJournalRangeItemSchema.parse(item)
    );
  } catch (error) {
    // The Claude parser stops at the item limit before it builds anything.
    if (
      error instanceof Error &&
      error.message === "claude_transcript_too_many_items"
    ) {
      throw journalRangeTooManyItems();
    }
    // Only a record the parser or the item rules reject is a data error.
    const invalidRecord =
      error instanceof ZodError ||
      (error instanceof Error && adapter.rejectsRecord(error));
    if (!invalidRecord) throw error;
    throw journalRangeInvalid("Journal range does not hold importable records");
  }
  return {
    ...range,
    sourceLine: built.sourceLine,
    parserState: built.parserState,
    items
  };
};

const registerCreateRunRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/historical-imports",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const run = await context.requireRepository().createHistoricalImportRun({
        userId: user.id
      });
      return { run: presentRun(run) };
    }
  );
};

const registerAdmissionRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/historical-import-admission",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      await context.auth.authenticate(request);
      return context.historicalImport.admission();
    }
  );
};

const registerListRunsRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/historical-imports",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const query = historicalImportRunListSchema.parse(request.query);
      const runs = await context
        .requireRepository()
        .listHistoricalImportRuns({ userId: user.id }, query);
      return { runs: runs.map(presentRun) };
    }
  );
};

const registerGetRunRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/historical-imports/:runId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { runId } = historicalImportRunParamsSchema.parse(request.params);
      const run = await context
        .requireRepository()
        .getHistoricalImportRun({ userId: user.id }, runId);
      if (!run) {
        throw Object.assign(new Error("Historical import run not found"), {
          statusCode: 404
        });
      }
      return { run: presentRun(run) };
    }
  );
};

// Matches the run states that accept new sources.
const openRunStates = new Set([
  "discovered",
  "eligible",
  "queued",
  "importing",
  "paused"
]);

const registerCreateSourceRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/historical-import-sources",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const input = createHistoricalImportSourceSchema.parse(request.body);
      const repository = context.requireRepository();
      const source = await repository.createHistoricalImportSource(
        { userId: user.id },
        input
      );
      if (!source) {
        // An open run means the artifact was the problem; a missing or closed
        // run tells the caller to start a new one.
        const run = await repository.getHistoricalImportRun(
          { userId: user.id },
          input.runId
        );
        if (run && openRunStates.has(run.state)) {
          throw Object.assign(
            new Error("Historical import artifact is not available"),
            {
              statusCode: 409,
              code: "historical_import_artifact_unavailable"
            }
          );
        }
        throw Object.assign(new Error("Historical import run not found"), {
          statusCode: 409,
          code: "historical_import_run_not_found"
        });
      }
      return {
        source: presentSource(source, { includeResumeState: true })
      };
    }
  );
};

const registerSourceLookupRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/historical-import-sources/lookup",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const identity = historicalImportSourceLookupSchema.parse(request.query);
      const source = await context
        .requireRepository()
        .getHistoricalImportSourceByIdentity({ userId: user.id }, identity);
      if (!source) {
        throw Object.assign(new Error("Historical import source not found"), {
          statusCode: 404
        });
      }
      return {
        source: presentSource(source, { includeResumeState: true })
      };
    }
  );
};

const registerRunTransitionRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.patch(
    "/v1/historical-imports/:runId",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { runId } = historicalImportRunParamsSchema.parse(request.params);
      const input = historicalImportTransitionSchema.parse(request.body);
      const run = await context
        .requireRepository()
        .transitionHistoricalImportRun(
          { userId: user.id },
          { runId, ...input }
        );
      if (!run) {
        throw transitionConflict(
          "run",
          await context
            .requireRepository()
            .getHistoricalImportRun({ userId: user.id }, runId),
          input
        );
      }
      return { run: presentRun(run) };
    }
  );
};

const registerSourceTransitionRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.patch(
    "/v1/historical-import-sources/:sourceId",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { sourceId } = historicalImportSourceParamsSchema.parse(
        request.params
      );
      const input = historicalImportTransitionSchema.parse(request.body);
      const repo = context.requireRepository();
      const source = await requireSource(repo, user.id, sourceId);
      if (input.state === "eligible" || input.state === "queued") {
        await requireImportPolicy(context, repo, user.id, source);
      }
      const updated = await repo.transitionHistoricalImportSource(
        { userId: user.id },
        { sourceId, ...input }
      );
      if (!updated) {
        throw transitionConflict(
          "source",
          await repo.getHistoricalImportSource({ userId: user.id }, sourceId),
          input
        );
      }
      return { source: presentSource(updated) };
    }
  );
};

const ingestHistoricalBatch = async (
  context: ApiRouteContext,
  journalStorage: () => ConversationSourceStorage,
  userId: string,
  sourceId: string,
  request: HistoricalBatchInput | HistoricalJournalRangeInput
) => {
  const repo = context.requireRepository();
  const source = await requireSource(repo, userId, sourceId);
  const input =
    "kind" in request
      ? await journalRangeBatch(
          context,
          journalStorage,
          repo,
          userId,
          source,
          request
        )
      : request;
  return repo.ingestHistoricalImportBatch(
    { userId },
    {
      sourceId,
      ...input,
      items: input.items.map((item) => ({
        ...item,
        sourceKind: source.sourceKind,
        sourceAdapterVersion: source.sourceAdapterVersion,
        sourceTransport: "historical_import"
      }))
    }
  );
};

const registerBatchRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  // Local profiles keep the journal on disk. The storage is opened once, on
  // the first journal range, and never for an item batch.
  let openedStorage: ConversationSourceStorage | undefined;
  const storageForJournalRange = (): ConversationSourceStorage =>
    (openedStorage ??= createFilesystemConversationSourceStorage(
      context.config.koedHome
    ));
  app.post(
    "/v1/historical-import-sources/:sourceId/batches",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { sourceId } = historicalImportSourceParamsSchema.parse(
        request.params
      );
      // The batch kind picks the schema, so an item batch keeps reporting
      // the path of the field that is wrong.
      const body = request.body;
      const input =
        typeof body === "object" && body !== null && "kind" in body
          ? historicalImportJournalRangeSchema.parse(body)
          : historicalImportBatchSchema.parse(body);
      const { items, source, policy, replayed } = await ingestHistoricalBatch(
        context,
        storageForJournalRange,
        user.id,
        sourceId,
        input
      );
      if ("kind" in input) {
        // The client holds no parser state for a record it did not parse, so
        // it continues from the committed cursor. The items stay out of the
        // response: the record was too large to upload in the first place.
        return {
          itemCount: items.length,
          source: presentSource(source, { includeResumeState: true }),
          policy,
          replayed
        };
      }
      return {
        items: items.map((item) => ({
          ...item,
          capturedProject: safeProjectProvenance(item.capturedProject)
        })),
        source: presentSource(source),
        policy,
        replayed
      };
    }
  );
};

export const registerHistoricalImportRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  registerAdmissionRoute(app, context);
  registerCreateRunRoute(app, context);
  registerListRunsRoute(app, context);
  registerGetRunRoute(app, context);
  registerCreateSourceRoute(app, context);
  registerSourceLookupRoute(app, context);
  registerRunTransitionRoute(app, context);
  registerSourceTransitionRoute(app, context);
  registerBatchRoute(app, context);
};
