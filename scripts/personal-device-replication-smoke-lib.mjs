import { createHash } from "node:crypto";

const markerHit = (body, marker) =>
  body?.retrievalMode === "semantic_vector" &&
  Array.isArray(body.hits) &&
  body.hits.some((hit) => JSON.stringify(hit).includes(marker));

export const waitForReplicatedRetrieval = async ({
  listener,
  readStatus,
  search,
  marker,
  onListening,
  timeoutMs = 120_000
}) => {
  let settled = false;
  let checking = false;
  let rerun = false;
  let lastStatus = null;
  let lastSearch = null;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  const check = async () => {
    if (settled) return;
    if (checking) {
      rerun = true;
      return;
    }
    checking = true;
    try {
      do {
        rerun = false;
        lastStatus = readStatus ? await readStatus() : null;
        lastSearch = await search();
        if (markerHit(lastSearch, marker)) {
          finish({ status: lastStatus?.status ?? null, search: lastSearch });
          return;
        }
      } while (rerun && !settled);
    } catch (error) {
      rejectResult(error);
      settled = true;
    } finally {
      checking = false;
    }
  };
  const onNotification = (message) => {
    if (message?.channel === "koed_pds_local_sync") void check();
  };
  listener.on("notification", onNotification);
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectResult(
      new Error(
        `Timed out waiting for Device B replication notification. Last status: ${JSON.stringify(lastStatus)} Last search: ${JSON.stringify(lastSearch)}`
      )
    );
  }, timeoutMs);
  try {
    await listener.query("listen koed_pds_local_sync");
    await onListening?.();
    await check();
    return await result;
  } finally {
    clearTimeout(timeout);
    listener.removeListener("notification", onNotification);
    await listener.query("unlisten koed_pds_local_sync").catch(() => undefined);
  }
};

export const replicatedTranscriptItems = ({
  sessionId,
  marker,
  observedAt
}) => [
  {
    sessionId,
    sourceKind: "codex",
    sourceAdapterVersion: "codex-transcript-v1",
    sourceTransport: "transcript",
    externalSessionId: marker,
    externalTurnId: `${marker}-turn`,
    externalItemId: `${marker}-prompt`,
    sourceRecordType: "event_msg",
    sourceEventType: "user_message",
    sourceSequence: 0,
    eventTime: observedAt,
    rawJson: {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `Replicated Personal Memory ${marker}`
      }
    },
    rawText: `Replicated Personal Memory ${marker}`,
    sourceHash: createHash("sha256")
      .update(`Replicated Personal Memory ${marker}`)
      .digest("hex"),
    idempotencyKey: `${marker}-source-item`,
    metadata: { transcriptType: "user_message", sourceRole: "user" }
  }
];
