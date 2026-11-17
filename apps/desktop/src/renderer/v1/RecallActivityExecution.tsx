import type { DesktopProject } from "../../project-memory-ui.js";
import type { CSSProperties } from "react";
import {
  CheckCircle2,
  CircleAlert,
  FileText,
  Gauge,
  Info,
  Layers
} from "lucide-react";
import type {
  RecallActivityDetail,
  RecallAllowance,
  RecallDeliveryOperation
} from "@koed-labs/shared/personal-desktop";
import { RecallActivityScope } from "./RecallActivityScope.js";
import "./recall-execution.css";

const number = (value: number | null | undefined) =>
  value == null ? "Unknown" : value.toLocaleString();
const reasons: Record<RecallDeliveryOperation["reasons"][number], string> = {
  evidence_tokens: "Evidence token allowance reached",
  evidence_items: "Evidence item allowance reached",
  candidates: "Candidate allowance reached",
  prompt_tokens: "Cumulative prompt allowance reached",
  recovery_reserve: "Prompt room reserved for targeted recovery"
};
const budgetNames = {
  wall_time: "Time",
  searches: "Searches",
  expansions: "Expansions",
  attempts: "Attempts",
  candidates: "Candidates",
  evidence_items: "Evidence items",
  evidence_tokens: "Evidence tokens",
  prompt_tokens: "Prompt tokens"
};
function Budget({
  label,
  value,
  exhausted
}: {
  label: string;
  value: RecallAllowance;
  exhausted: boolean;
}) {
  const known = value.consumed !== null && value.limit !== null;
  return (
    <div className={`recall-budget${exhausted ? " exhausted" : ""}`}>
      <div className="recall-budget-top">
        <span>{label}</span>
        <span>
          <strong>{number(value.consumed)}</strong>
          <small> / {number(value.limit)}</small>
        </span>
      </div>
      <div
        className={`recall-budget-meter${known ? "" : " unknown"}`}
        role={known ? "meter" : undefined}
        aria-label={label}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? value.limit! : undefined}
        aria-valuenow={
          known ? Math.min(value.consumed!, value.limit!) : undefined
        }
        aria-valuetext={
          known
            ? `${number(value.consumed)} of ${number(value.limit)} local tokens`
            : undefined
        }
      >
        {known && (
          <i
            style={{
              width: `${value.limit ? Math.min(100, (value.consumed! / value.limit) * 100) : 0}%`
            }}
          />
        )}
      </div>
    </div>
  );
}
function Missing({ children }: { children: string }) {
  return (
    <p className="recall-execution-missing">
      <Info />
      {children}
    </p>
  );
}
export function RecallActivityExecution({
  detail,
  projects = []
}: {
  detail: RecallActivityDetail;
  projects?: readonly DesktopProject[];
}) {
  const budgets = detail.execution?.budgets;
  const delivery = detail.execution?.delivery;
  const operations = delivery?.operations ?? [];
  return (
    <>
      <RecallActivityScope
        question={detail.question}
        heading
        projects={projects}
      />
      <div
        className="recall-execution-columns"
        style={
          {
            "--recall-operation-rows": Math.max(3, operations.length)
          } as CSSProperties
        }
      >
        <section
          className="recall-execution-section"
          aria-label="Execution budgets"
        >
          <div className="recall-execution-heading">
            <h3>
              <Gauge />
              Execution budgets
            </h3>
          </div>
          {budgets ? (
            <>
              <Budget
                label="Evidence working set"
                value={budgets.evidenceWorkingSet}
                exhausted={budgets.exhausted.includes("evidence_tokens")}
              />
              <Budget
                label="Final Evidence Bundle"
                value={budgets.finalEvidenceBundle}
                exhausted={budgets.exhausted.includes("evidence_tokens")}
              />
              <Budget
                label="Cumulative prompt"
                value={budgets.cumulativePrompt}
                exhausted={budgets.exhausted.includes("prompt_tokens")}
              />
              <div className="recall-execution-counts">
                {(["searches", "expansions", "attempts"] as const).map(
                  (key) => (
                    <div key={key}>
                      <span>{key}</span>
                      <strong>
                        {number(budgets[key].consumed)} /{" "}
                        {number(budgets[key].limit)}
                      </strong>
                    </div>
                  )
                )}
              </div>
            </>
          ) : (
            <>
              <Missing>
                Execution budgets were not recorded for this answer.
              </Missing>
              {/* Older records still carry their worker's own counters. */}
              {[
                detail.searchCount,
                detail.expandCount,
                detail.candidateCount
              ].some((value) => value != null) && (
                <div
                  className="recall-execution-counts"
                  aria-label="Recorded counts"
                >
                  {(
                    [
                      ["searches", detail.searchCount],
                      ["expansions", detail.expandCount],
                      ["candidates", detail.candidateCount]
                    ] as const
                  ).map(([key, value]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <strong>{number(value)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="recall-execution-footer">
            {Boolean(budgets?.exhausted.length) && (
              <p className="recall-execution-exhausted">
                <CircleAlert />
                Allowance reached:{" "}
                {budgets!.exhausted.map((key) => budgetNames[key]).join(", ")}
              </p>
            )}
            <p className="recall-execution-note">
              <Info />
              Local token estimates. Each allowance is separate; these values
              are not provider billing totals.
              {(detail.question.metadata?.usage?.taskAttempts ?? 1) > 1 &&
                " Budgets cover the final execution; Provider usage can include earlier task attempts."}
            </p>
          </div>
        </section>
        <section
          className="recall-execution-section"
          aria-label="Source delivery"
        >
          <div className="recall-execution-heading">
            <h3>
              <Layers />
              Source delivery
            </h3>
            <span>After admission</span>
          </div>
          {delivery ? (
            <div className="recall-delivery">
              {operations.length ? (
                operations.map((operation, index) => (
                  <div className="recall-delivery-operation" key={index}>
                    <span
                      className="recall-operation-marker"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <div className="recall-operation-body">
                      <div className="recall-operation-title">
                        <strong>
                          {
                            {
                              search: "Search",
                              scan: "Scan",
                              expand: "Expand sources",
                              targeted_expand: "Targeted expansion"
                            }[operation.kind]
                          }
                        </strong>
                        <span>
                          <b>{number(operation.delivered)}</b> delivered ·{" "}
                          <span
                            className={operation.omitted ? "recall-amber" : ""}
                          >
                            {number(operation.omitted)} omitted
                          </span>
                        </span>
                      </div>
                      {operation.reasons.map((reason) => (
                        <p className="recall-operation-reason" key={reason}>
                          <CircleAlert />
                          {reasons[reason]}
                        </p>
                      ))}
                      {Boolean(operation.omitted) &&
                        operation.reasons.length === 0 && (
                          <p className="recall-operation-reason">
                            <Info />
                            Omission reason not recorded
                          </p>
                        )}
                      {operation.recovered && (
                        <p className="recall-operation-recovery">
                          <CheckCircle2 />
                          Previously omitted source delivered
                        </p>
                      )}
                      {operation.failed && (
                        <p className="recall-operation-reason">
                          <CircleAlert />
                          Operation did not complete
                        </p>
                      )}
                      {budgets?.attempts.consumed != null &&
                        budgets.attempts.consumed > 1 &&
                        operation.attempt !== null && (
                          <small className="recall-operation-attempt">
                            Attempt {operation.attempt}
                          </small>
                        )}
                    </div>
                  </div>
                ))
              ) : (
                <Missing>No retrieval operations were recorded.</Missing>
              )}
            </div>
          ) : (
            <Missing>Source delivery was not recorded for this answer.</Missing>
          )}
          <div className="recall-delivery-divider" aria-hidden="true" />
          <div className="recall-execution-footer">
            {delivery?.truncated && (
              <p className="recall-execution-note">
                The first 100 operations are shown.
              </p>
            )}
            <div className="recall-evidence-total">
              <FileText />
              Final selected evidence
              <strong>
                {delivery?.finalSelected == null
                  ? "Not recorded"
                  : `${number(delivery.finalSelected)} ${delivery.finalSelected === 1 ? "source" : "sources"}`}
              </strong>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
