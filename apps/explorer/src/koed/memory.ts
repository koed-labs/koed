import type {
  MemoryAnswerResponse,
  MemoryEvidenceItem,
  MemoryQuestionRecord
} from "./types";
import { firstLine } from "./graph";

export function memoryQuestionId() {
  return typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `question-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function memoryEvidence(
  response?: MemoryAnswerResponse
): MemoryEvidenceItem[] {
  return response?.evidenceBundle?.evidence ?? response?.evidence ?? [];
}

export function questionEvidence(
  question: MemoryQuestionRecord
): MemoryEvidenceItem[] {
  return question.evidence ?? memoryEvidence(question.response);
}

export function memoryRetrieval(response?: MemoryAnswerResponse) {
  return response?.evidenceBundle?.retrieval ?? response?.retrieval;
}

export function questionRetrieval(question: MemoryQuestionRecord) {
  return (
    question.retrieval ??
    question.response?.evidenceBundle?.retrieval ??
    question.response?.retrieval
  );
}

export function memoryScopeLabel(
  question: Pick<
    MemoryQuestionRecord,
    "searchDomain" | "projectName" | "threadName"
  >
) {
  if (question.searchDomain === "session") {
    return question.threadName ?? "Selected session";
  }
  if (question.searchDomain === "project") {
    return question.projectName ?? "Selected project";
  }
  return "Global memory";
}

export function memoryQuestionPreview(question: MemoryQuestionRecord) {
  if (question.status === "pending") {
    return question.lastErrorMessage
      ? "Still working..."
      : "Searching memory...";
  }
  if (question.status === "error") {
    return question.errorMessage ?? question.error ?? "Memory answer failed";
  }
  return firstLine(
    question.answerPreview ??
      question.answerMarkdown ??
      question.response?.markdown ??
      ""
  );
}
