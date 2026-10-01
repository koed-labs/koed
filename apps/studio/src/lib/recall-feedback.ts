export type RecallFeedbackRating = "up" | "down";

export type RecallFeedback = Readonly<{
  rating: RecallFeedbackRating | null;
  comment: string | null;
  updatedAt: string;
}>;

export type RecallFeedbackChange = Readonly<{
  rating?: RecallFeedbackRating | null;
  comment?: string | null;
}>;

const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const answerId = new RegExp(`^(?:provider|agent):${uuid}$`);

export function recallFeedbackPath(
  executionId: string,
  answerIdValue: string
): string {
  if (
    !new RegExp(`^${uuid}$`).test(executionId) ||
    !answerId.test(answerIdValue)
  ) {
    throw new Error("This recalled answer is unavailable for feedback.");
  }
  return `/v1/managed-conversations/${encodeURIComponent(executionId)}/recall-feedback/${encodeURIComponent(answerIdValue)}`;
}

export function parseRecallFeedback(value: unknown): RecallFeedback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "comment,rating,updatedAt" ||
    !(
      record.rating === null ||
      record.rating === "up" ||
      record.rating === "down"
    ) ||
    !(record.comment === null || typeof record.comment === "string") ||
    (typeof record.comment === "string" &&
      (record.comment.length > 4_000 ||
        new TextEncoder().encode(record.comment).byteLength > 16 * 1024)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    return null;
  return {
    rating: record.rating,
    comment: record.comment,
    updatedAt: record.updatedAt
  };
}

export function parseRecallFeedbackResponse(
  value: unknown
): RecallFeedback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The feedback response is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(",") !== "feedback" ||
    !Object.hasOwn(record, "feedback")
  ) {
    throw new Error("The feedback response is invalid.");
  }
  const feedback = record.feedback;
  if (feedback === null) return null;
  const parsed = parseRecallFeedback(feedback);
  if (!parsed) throw new Error("The feedback response is invalid.");
  return parsed;
}

export function assertRecallFeedbackChange(
  value: unknown
): asserts value is RecallFeedbackChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Feedback change is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "rating" && key !== "comment") ||
    ("rating" in record &&
      record.rating !== null &&
      record.rating !== "up" &&
      record.rating !== "down") ||
    ("comment" in record &&
      record.comment !== null &&
      typeof record.comment !== "string") ||
    (typeof record.comment === "string" &&
      (record.comment.length > 4_000 ||
        new TextEncoder().encode(record.comment).byteLength > 16 * 1024))
  ) {
    throw new Error("Feedback change is invalid.");
  }
}
