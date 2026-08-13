export interface BridgeCallTelemetry {
  mcpCalls: number;
  mcpFailures: number;
  memoryAnswerCalls: number;
  memoryAnswerFailures: number;
  searches: number | null;
  expansions: number | null;
  stages: number | null;
  evidenceCount: number | null;
  workerPeakRssBytes: number | null;
  memoryAnswerRequests: readonly {
    responseDetail: string | null;
    searchDomain: string | null;
  }[];
}

interface BridgeCallDescriptor {
  memoryAnswer: boolean;
  responseDetail: string | null;
  searchDomain: string | null;
}

const readers = new Map<string, () => BridgeCallTelemetry>();

const jsonRpcObjects = (text: string): unknown[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("data:")) {
    return trimmed
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as unknown);
  }
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const observedCount = (
  value: Record<string, unknown> | undefined,
  key: string,
  label: string
): number | undefined => {
  if (!value || !Object.hasOwn(value, key)) return undefined;
  const count = value[key];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new Error(`${label} is corrupt`);
  return count;
};

export class BridgeTelemetryCollector {
  private metrics: BridgeCallTelemetry = {
    mcpCalls: 0,
    mcpFailures: 0,
    memoryAnswerCalls: 0,
    memoryAnswerFailures: 0,
    searches: null,
    expansions: null,
    stages: null,
    evidenceCount: null,
    workerPeakRssBytes: null,
    memoryAnswerRequests: []
  };
  private collectionFailure: Error | undefined;

  describe(body: Uint8Array | undefined): BridgeCallDescriptor | undefined {
    if (!body) return undefined;
    try {
      const messages = jsonRpcObjects(Buffer.from(body).toString("utf8"));
      const calls = messages.filter(
        (message) => record(message)?.method === "tools/call"
      );
      if (calls.length === 0) return undefined;
      if (calls.length !== 1) {
        throw new Error("batched MCP tool calls cannot be attributed safely");
      }
      const message = record(calls[0]);
      const params = record(message?.params);
      const arguments_ = record(params?.arguments);
      return {
        memoryAnswer: params?.name === "memory_answer",
        responseDetail:
          typeof arguments_?.response_detail === "string"
            ? arguments_.response_detail
            : null,
        searchDomain:
          typeof arguments_?.search_domain === "string"
            ? arguments_.search_domain
            : null
      };
    } catch (error) {
      this.collectionFailure = new Error(
        "Bridge MCP request telemetry could not be parsed",
        { cause: error }
      );
      return undefined;
    }
  }

  async complete(
    descriptor: BridgeCallDescriptor | undefined,
    response?: Response,
    requestError = false
  ): Promise<void> {
    if (!descriptor) return;
    this.metrics.mcpCalls += 1;
    if (descriptor.memoryAnswer) this.metrics.memoryAnswerCalls += 1;
    if (descriptor.memoryAnswer) {
      this.metrics.memoryAnswerRequests = [
        ...this.metrics.memoryAnswerRequests,
        {
          responseDetail: descriptor.responseDetail,
          searchDomain: descriptor.searchDomain
        }
      ];
    }
    let failed = requestError;
    if (response) {
      failed ||= !response.ok;
      try {
        const messages = jsonRpcObjects(await response.clone().text());
        failed ||= messages.some((message) => {
          const item = record(message);
          const result = record(item?.result);
          return item?.error !== undefined || result?.isError === true;
        });
        if (descriptor.memoryAnswer) {
          for (const message of messages) {
            const result = record(record(message)?.result);
            const content = Array.isArray(result?.content)
              ? result.content
              : [];
            const answers: unknown[] = [];
            if (result?.structuredContent !== undefined)
              answers.push(result.structuredContent);
            else {
              for (const item of content) {
                const text = record(item)?.text;
                if (typeof text !== "string") continue;
                try {
                  answers.push(JSON.parse(text));
                } catch {
                  continue;
                }
              }
            }
            for (const answer of answers) {
              const payload = record(answer);
              const retrieval = record(payload?.retrieval);
              const worker = record(payload?.localMemoryWorker);
              const evidence = Array.isArray(payload?.evidence)
                ? payload.evidence
                : Array.isArray(record(payload?.evidenceBundle)?.evidence)
                  ? (record(payload?.evidenceBundle)!.evidence as unknown[])
                  : [];
              const searches = observedCount(
                worker,
                "searchCount",
                "memory_answer search count"
              );
              const expansions = observedCount(
                worker,
                "expandCount",
                "memory_answer expansion count"
              );
              if (searches !== undefined)
                this.metrics.searches = (this.metrics.searches ?? 0) + searches;
              if (expansions !== undefined)
                this.metrics.expansions =
                  (this.metrics.expansions ?? 0) + expansions;
              const stages = retrieval?.stages;
              if (
                retrieval &&
                Object.hasOwn(retrieval, "stages") &&
                !Array.isArray(stages)
              )
                throw new Error("memory_answer retrieval stages are corrupt");
              if (Array.isArray(stages))
                this.metrics.stages =
                  (this.metrics.stages ?? 0) + stages.length;
              const reportedEvidence = observedCount(
                retrieval,
                "evidenceCount",
                "memory_answer evidence count"
              );
              if (reportedEvidence !== undefined)
                this.metrics.evidenceCount =
                  (this.metrics.evidenceCount ?? 0) + reportedEvidence;
              else if (evidence.length > 0)
                this.metrics.evidenceCount =
                  (this.metrics.evidenceCount ?? 0) + evidence.length;
              const executions = worker?.appServerExecutions;
              if (Array.isArray(executions))
                for (const execution of executions) {
                  const peak = observedCount(
                    record(record(execution)?.processMetrics),
                    "peakRssBytes",
                    "memory_answer worker peak RSS"
                  );
                  if (peak !== undefined)
                    this.metrics.workerPeakRssBytes = Math.max(
                      this.metrics.workerPeakRssBytes ?? 0,
                      peak
                    );
                }
            }
          }
        }
      } catch (error) {
        this.collectionFailure = new Error(
          "Bridge MCP response telemetry could not be parsed",
          { cause: error }
        );
      }
    }
    if (failed) {
      this.metrics.mcpFailures += 1;
      if (descriptor.memoryAnswer) this.metrics.memoryAnswerFailures += 1;
    }
  }

  snapshot(): BridgeCallTelemetry {
    if (this.collectionFailure) throw this.collectionFailure;
    return { ...this.metrics };
  }
}

export const registerBridgeTelemetry = (
  url: string,
  collector: BridgeTelemetryCollector
): (() => void) => {
  if (readers.has(url)) throw new Error("Bridge telemetry URL is duplicated");
  const reader = () => collector.snapshot();
  readers.set(url, reader);
  return () => {
    if (readers.get(url) === reader) readers.delete(url);
  };
};

export const collectBridgeTelemetry = (url: string): BridgeCallTelemetry => {
  const reader = readers.get(url);
  if (!reader) throw new Error("Bridge telemetry collector is unavailable");
  return reader();
};
