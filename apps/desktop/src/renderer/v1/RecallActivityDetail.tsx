import { RecallActivityExecution } from "./RecallActivityExecution.js";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  ScrollArea,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab
} from "@koed-labs/ui";
import { Check, Copy, FileText, Layers } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  PersonalDesktopApi,
  RecallActivityDetail as Detail
} from "@koed-labs/shared/personal-desktop";
import {
  SecureMarkdown,
  type MarkdownPlatformAdapters
} from "../markdown/SecureMarkdown.js";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import { RecallActivityOutcome } from "./RecallActivityOutcome.js";
import {
  recallCallerPresentation,
  recallDurationLabel
} from "./recall-activity-model.js";
import { RecallActivityUsage } from "./RecallActivityUsage.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import "./recall-detail.css";

export function RecallActivityDetail({
  api,
  projects,
  questionId,
  revision,
  onClose,
  adapters
}: {
  api: PersonalDesktopApi;
  projects: readonly DesktopProject[];
  questionId: string;
  revision: string;
  onClose: () => void;
  adapters: MarkdownPlatformAdapters;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const memoryStatus = detail?.question.metadata
    ? detail.question.metadata.memoryStatus
    : detail?.memoryStatus;
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(false);
    setCopyState("idle");
    if (!api.loadRecallActivity) {
      setError(true);
      return;
    }
    void api.loadRecallActivity({ questionId }).then(
      (value) => {
        if (active) setDetail(value);
      },
      () => {
        if (active) setError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [api, questionId, revision]);
  const caller = recallCallerPresentation(
    detail?.question.metadata?.caller?.name
  );
  const answer = detail?.answer ?? detail?.failure ?? null;
  const copyAnswer = async () => {
    if (!answer) return;
    try {
      await adapters.writeClipboard(answer);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        className="v1-app recall-detail recall-answer-dialog"
        initialFocus={heading}
      >
        <ScrollArea className="recall-dialog-scroll">
          <div className="recall-dialog-content">
            <DialogTitle
              className="sr-only"
              id="recall-detail-title"
              tabIndex={-1}
              ref={heading}
            >
              Memory Answer
            </DialogTitle>
            <DialogDescription className="sr-only">
              Recorded question, answer, recall details and provider usage
            </DialogDescription>
            {error ? (
              <p role="alert" className="recall-detail-state">
                This Memory Answer is unavailable or your access has changed.
              </p>
            ) : !detail ? (
              <p role="status" className="recall-detail-state">
                Loading answer…
              </p>
            ) : (
              <>
                <div className="recall-detail-eyebrow">
                  <span className={`recall-client ${caller.icon ?? ""}`}>
                    {caller.icon && (
                      <span className="recall-client-logo">
                        <AiClientLogo id={caller.icon} />
                      </span>
                    )}
                    <span className="recall-client-name">{caller.label}</span>
                  </span>
                  <time dateTime={detail.question.recordedAt}>
                    {new Date(detail.question.recordedAt).toLocaleString(
                      undefined,
                      {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hourCycle: "h23"
                      }
                    )}
                  </time>
                </div>
                <h2 className="recall-question-title">
                  {detail.question.query ?? "Question unavailable"}
                </h2>
                {detail.question.queryTruncated && (
                  <p className="recall-detail-note">
                    This view shows a shortened question.
                  </p>
                )}
                <div className="recall-detail-meta">
                  <RecallActivityOutcome
                    status={detail.question.status}
                    memoryStatus={memoryStatus ?? null}
                  />
                  <span>
                    {recallDurationLabel(
                      detail.question.metadata?.timing?.durationMs
                    )}
                  </span>
                  {detail.execution?.delivery?.operations.some(
                    (operation) =>
                      operation.kind === "targeted_expand" &&
                      operation.recovered
                  ) && (
                    <span className="recall-detail-signal">
                      Targeted recovery
                    </span>
                  )}
                </div>
                <Tabs defaultValue="answer" key={detail.question.id}>
                  <TabsList aria-label="Memory Answer details">
                    <TabsTab value="answer">Answer</TabsTab>
                    <TabsTab value="recall">Recall details</TabsTab>
                    <TabsTab value="usage">Provider usage</TabsTab>
                  </TabsList>
                  <TabsPanel value="answer">
                    <div className="recall-answer-heading">
                      <span>
                        {detail.question.status === "error"
                          ? "Recorded error"
                          : "Recorded answer"}
                      </span>
                      {answer && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={
                            copyState === "copied"
                              ? "Answer copied"
                              : "Copy answer"
                          }
                          onClick={() => {
                            void copyAnswer();
                          }}
                        >
                          {copyState === "copied" ? <Check /> : <Copy />}
                        </Button>
                      )}
                    </div>
                    {copyState !== "idle" && (
                      <p role="status" className="recall-detail-note">
                        {copyState === "copied"
                          ? "Answer copied."
                          : "Could not copy this answer. Try again."}
                      </p>
                    )}
                    {detail.failure && detail.answer && (
                      <p role="status" className="recall-detail-note">
                        {detail.failure}
                      </p>
                    )}
                    {answer ? (
                      <SecureMarkdown
                        className="recall-answer-text"
                        source={answer}
                        adapters={adapters}
                      />
                    ) : (
                      <p className="recall-detail-note">
                        No retained answer is available.
                      </p>
                    )}
                    <section
                      className="recall-sources"
                      aria-labelledby="recall-evidence-title"
                    >
                      <h3 id="recall-evidence-title">
                        <Layers />
                        Evidence Bundle{" "}
                        <span>
                          · {detail.evidence.length}{" "}
                          {detail.evidence.length === 1 ? "source" : "sources"}
                        </span>
                      </h3>
                      {!detail.evidence.length && (
                        <p className="recall-detail-note">
                          No retained evidence is available.
                        </p>
                      )}
                      {detail.evidence.map((item, index) => (
                        <details className="recall-source" key={index}>
                          <summary>
                            <FileText />
                            <span>
                              {item.title}
                              <small>Retained excerpt</small>
                            </span>
                          </summary>
                          <p className="recall-question">
                            {item.text || "No retained excerpt."}
                          </p>
                          {item.sourceId && (
                            <small>Source: {item.sourceId}</small>
                          )}
                        </details>
                      ))}
                      {!!detail.citations.length && (
                        <details className="recall-citations">
                          <summary>
                            Citations ({detail.citations.length})
                          </summary>
                          {detail.citations.map((item, index) => (
                            <p key={index}>
                              {item.title}: {item.text || item.sourceId}
                            </p>
                          ))}
                        </details>
                      )}
                    </section>
                    {detail.contentTruncated && (
                      <p className="recall-detail-note">
                        Long content has been shortened for this view.
                      </p>
                    )}
                  </TabsPanel>
                  <TabsPanel value="usage">
                    <RecallActivityUsage detail={detail} />
                  </TabsPanel>
                  <TabsPanel value="recall">
                    <RecallActivityExecution
                      detail={detail}
                      projects={projects}
                    />
                    <dl className="recall-detail-facts" aria-label="Record">
                      <div>
                        <dt>Calling AI Client</dt>
                        <dd>
                          {detail.question.metadata?.caller?.name ?? "Unknown"}
                          {detail.question.metadata?.caller?.version &&
                            ` · ${detail.question.metadata.caller.version}`}
                        </dd>
                      </div>
                      <div>
                        <dt>Conversation</dt>
                        <dd>{detail.question.sessionId ?? "Not recorded"}</dd>
                      </div>
                      <div>
                        <dt>Record</dt>
                        <dd>
                          <code>{detail.question.id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Recorded at</dt>
                        <dd>
                          {new Date(
                            detail.question.recordedAt
                          ).toLocaleString()}
                        </dd>
                      </div>
                    </dl>
                  </TabsPanel>
                </Tabs>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
}
