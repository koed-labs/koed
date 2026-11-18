import { Button } from "@koed-labs/ui";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { RecallActivityDetail } from "@koed-labs/shared/personal-desktop";
import type { MarkdownPlatformAdapters } from "../markdown/SecureMarkdown.js";

export function RecallActivityCaller({
  question,
  adapters
}: {
  question: RecallActivityDetail["question"];
  adapters: MarkdownPlatformAdapters;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const questionLabel = question.queryTruncated
    ? "Recorded question"
    : "Full question";
  const copyQuestion = async () => {
    if (!question.query) return;
    try {
      await adapters.writeClipboard(question.query);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <div className="recall-caller-details">
      <dl
        className="recall-detail-facts recall-caller-facts"
        aria-label="Caller metadata"
      >
        <div>
          <dt>Calling AI Client</dt>
          <dd>
            {question.metadata?.caller?.name ?? "Unknown"}
            {question.metadata?.caller?.version &&
              ` · ${question.metadata.caller.version}`}
          </dd>
        </div>
        <div>
          <dt>Conversation</dt>
          <dd>
            <code>{question.sessionId ?? "Not recorded"}</code>
          </dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            <code>{question.id}</code>
          </dd>
        </div>
        <div>
          <dt>Recorded at</dt>
          <dd>
            <time dateTime={question.recordedAt}>
              {new Date(question.recordedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "medium"
              })}
            </time>
          </dd>
        </div>
      </dl>
      <section
        className="recall-caller-question"
        aria-labelledby="recall-full-question-title"
      >
        <div className="recall-caller-question-heading">
          <h3 id="recall-full-question-title">{questionLabel}</h3>
          {question.query && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                copyState === "copied"
                  ? "Question copied"
                  : `Copy ${questionLabel.toLowerCase()}`
              }
              onClick={() => {
                void copyQuestion();
              }}
            >
              {copyState === "copied" ? <Check /> : <Copy />}
            </Button>
          )}
        </div>
        {copyState !== "idle" && (
          <p
            role="status"
            className={
              copyState === "copied" ? "sr-only" : "recall-detail-note"
            }
          >
            {copyState === "copied"
              ? "Question copied."
              : "Could not copy this question. Try again."}
          </p>
        )}
        {question.queryTruncated && (
          <p className="recall-detail-note">
            Only the recorded portion of this question is available.
          </p>
        )}
        <p className="recall-caller-question-text">
          {question.query || "Question unavailable"}
        </p>
      </section>
    </div>
  );
}
