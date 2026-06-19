import {
  compactMemoryAnswerPayload,
  type MemoryAnswerResponseDetail,
  type MemoryAnswerWorkerResponse
} from "./answer-worker.js";

export const evidenceFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.evidence ?? answer.evidence;

export const citationsFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.citations;

export const retrievalFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.retrieval ?? answer.retrieval;

export const stripAppServerEvents = <T>(value: T): T => {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripAppServerEvents) as T;
  }
  const { appServerEvents, rawEvents, ...rest } = value as Record<
    string,
    unknown
  >;
  void appServerEvents;
  void rawEvents;
  return Object.fromEntries(
    Object.entries(rest).map(([key, entry]) => [
      key,
      stripAppServerEvents(entry)
    ])
  ) as T;
};

export const persistedAnswerResponse = (
  answer: MemoryAnswerWorkerResponse
): MemoryAnswerWorkerResponse => {
  const compact: Record<string, unknown> = {
    markdown: answer.markdown,
    retrieval: answer.retrieval,
    localMemoryWorker: stripAppServerEvents(answer.localMemoryWorker)
  };
  if (answer.structuredAnswer !== undefined) {
    compact.structuredAnswer = answer.structuredAnswer;
  }
  if (answer.citations !== undefined) {
    compact.citations = answer.citations;
  }
  return compact as MemoryAnswerWorkerResponse;
};

export const toolAnswerResponse = (
  answer: MemoryAnswerWorkerResponse,
  responseDetail: MemoryAnswerResponseDetail
): MemoryAnswerWorkerResponse =>
  compactMemoryAnswerPayload(
    {
      ...answer,
      localMemoryWorker: stripAppServerEvents(answer.localMemoryWorker)
    },
    responseDetail
  );

export const answerMarkdownFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.markdown?.trim() || "No matching memory evidence found.";

export const errorMessageFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.localMemoryWorker.errorMessage ??
  answer.localMemoryWorker.skippedReason ??
  "Memory answer worker failed.";
