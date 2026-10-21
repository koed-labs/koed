import { useEffect, useRef, useState } from "react";
import type { KoedTextActionProjection } from "@koed/shared";
import { scheduledJobScheduleSchema } from "@koed/shared/scheduled-job-contract";
import { nextScheduledJobOccurrence } from "@koed/shared/scheduled-job-calendar";
import type { ManagedTextActionDesktopApi } from "../../../ipc/managed-text-action-protocol.js";
import "./hq-text-actions.css";

const label: Record<KoedTextActionProjection["name"], string> = {
  koed_project_create: "Create Project",
  koed_project_move_chats: "Move chats",
  koed_project_delete: "Delete Project",
  koed_chat_create: "Start chat",
  koed_chat_move: "Move chat",
  koed_chat_delete: "Delete chat",
  koed_todo_add: "Add to-do",
  koed_todo_send: "Send to Agent",
  koed_job_create: "Schedule Job",
  koed_job_pause: "Pause or resume Job",
  koed_deck_make: "Make flashcards",
  koed_hq_open: "Open Project HQ",
  koed_settings_open: "Open Settings",
  koed_settings_set_theme: "Change theme"
};

const detail = (action: KoedTextActionProjection) => {
  const { arguments: args } = action;
  switch (action.name) {
    case "koed_project_create":
      return `${String(args.name ?? "New Project")}${args.folderPath ? ` · ${String(args.folderPath)}` : ""}`;
    case "koed_todo_add":
      return `${String(args.title ?? "To-do")}${args.dueOn ? ` · ${String(args.dueOn)}` : ""}`;
    case "koed_todo_send":
      return `Send ${String(action.snapshot.workItemTitle ?? "this to-do")} to ${String(action.snapshot.agentName ?? "your Agent")}`;
    case "koed_job_create":
      return `${String(args.title ?? "Scheduled Job")} · ${String(action.snapshot.agentName ?? "Agent")}`;
    case "koed_job_pause":
      return `${args.paused ? "Pause" : "Resume"} ${String(args.title ?? "Scheduled Job")}`;
    case "koed_deck_make": {
      const count = Array.isArray(args.cards) ? args.cards.length : 0;
      return `${String(args.title ?? "Flashcard Deck")} · ${String(args.scope ?? "")} · ${count} ${count === 1 ? "card" : "cards"}`;
    }
    case "koed_project_delete":
      return `${String(action.snapshot.projectName ?? args.projectId ?? "Project")} · ${String(action.snapshot.activeExecutionCount ?? 0)} active Agent executions. Review Project deletion and its chats, to-dos, and memory.`;
    case "koed_chat_delete":
      return `${String(action.snapshot.chatTitle ?? "This chat")} · Its memory stays available. Review the exact chat before deletion.`;
    case "koed_hq_open":
      return String(action.snapshot.projectName ?? "Open Project HQ");
    case "koed_chat_move":
      return `${String(action.snapshot.chatTitle ?? "This chat")}: ${String(action.snapshot.sourceProjectName ?? "Chats")} → ${String(action.snapshot.projectName ?? "Chats")}`;
    case "koed_project_move_chats": {
      const chats = Array.isArray(action.snapshot.chats)
        ? action.snapshot.chats
        : [];
      const from = new Set(
        chats.map((chat) =>
          chat && typeof chat === "object"
            ? String(
                (chat as Record<string, unknown>).sourceProjectName ?? "Chats"
              )
            : "Chats"
        )
      );
      return `${chats.length} ${chats.length === 1 ? "chat" : "chats"}: ${[...from].join(", ")} → ${String(action.snapshot.projectName ?? "Project")}`;
    }
    case "koed_settings_open":
      return String(args.section ?? "General");
    case "koed_settings_set_theme":
      return `${String(args.theme ?? "system")} theme`;
    default:
      return "Review the exact target before continuing.";
  }
};

const hasDurableServiceReceipt = (action: KoedTextActionProjection) =>
  [
    "koed_project_create",
    "koed_todo_add",
    "koed_todo_send",
    "koed_job_create",
    "koed_job_pause",
    "koed_deck_make",
    "koed_chat_move",
    "koed_project_move_chats"
  ].includes(action.name);

const jobReviewDetails = (action: KoedTextActionProjection) => {
  if (action.name !== "koed_job_create") return null;
  const parsed = scheduledJobScheduleSchema.safeParse(
    action.arguments.schedule
  );
  if (!parsed.success || typeof action.arguments.instruction !== "string")
    return (
      <p role="alert">
        Scheduled Job details are unavailable. Refresh before approval.
      </p>
    );
  const schedule = parsed.data;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const recurrence =
    schedule.kind === "daily"
      ? "Every day"
      : schedule.kind === "weekdays"
        ? "Every weekday"
        : schedule.kind === "weekly"
          ? `Every ${schedule.dow.map((day) => days[day - 1]).join(", ")}`
          : `Every month on day ${schedule.dom}`;
  const next = nextScheduledJobOccurrence(schedule, new Date());
  const nextLabel = next
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: schedule.tz
      }).format(next) + ` (${schedule.tz})`
    : "Unavailable";
  return (
    <dl className="hq-text-action__job-review">
      <div>
        <dt>When</dt>
        <dd>
          {recurrence} at {schedule.at} ({schedule.tz})
        </dd>
      </div>
      <div>
        <dt>Next</dt>
        <dd>{nextLabel}</dd>
      </div>
      <div>
        <dt>Instruction</dt>
        <dd className="hq-text-action__job-instruction">
          {action.arguments.instruction}
        </dd>
      </div>
      <div>
        <dt>Results</dt>
        <dd>this chat</dd>
      </div>
      <div>
        <dt>Project</dt>
        <dd>{String(action.snapshot.projectName ?? "Just me")}</dd>
      </div>
    </dl>
  );
};

const deckReviewDetails = (action: KoedTextActionProjection) => {
  if (action.name !== "koed_deck_make" || action.state !== "awaiting_review")
    return null;
  const cards = Array.isArray(action.arguments.cards)
    ? (action.arguments.cards as Record<string, unknown>[])
    : [];
  return (
    <div className="hq-text-action__deck-review">
      <p>
        From {String(action.arguments.madeFrom ?? "Project Sources and memory")}
      </p>
      <details>
        <summary>Review all {cards.length} questions and answers</summary>
        <ol>
          {cards.map((card, index) => (
            <li key={index}>
              <strong>{String(card.question ?? "")}</strong>
              <p>{String(card.answer ?? "")}</p>
              {card.sourceRef ? <small>{String(card.sourceRef)}</small> : null}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
};

/** A Koed action approval is separate from AI Client command approval. */
export function ManagedTextActions({
  api,
  executionId,
  ownerId,
  profileKey,
  onApply,
  onNativeReview,
  onResumeMove,
  onOpenDeck
}: {
  api: ManagedTextActionDesktopApi;
  executionId: string;
  ownerId?: string;
  profileKey?: string;
  onApply?: (action: KoedTextActionProjection) => Promise<boolean>;
  onNativeReview?: (action: KoedTextActionProjection) => void;
  onResumeMove?: (action: KoedTextActionProjection) => Promise<boolean>;
  onOpenDeck?: (target: { projectId: string; deckId: string }) => void;
}) {
  const [actions, setActions] = useState<KoedTextActionProjection[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  const inFlight = useRef(new Set<string>());
  const busy = useRef(false);

  useEffect(() => {
    const current = ++scope.current;
    inFlight.current.clear();
    setActions([]);
    setError(null);
    setBusyId(null);
    busy.current = false;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const rows = await api.list(executionId);
        if (
          scope.current !== current ||
          rows.some(
            (row) =>
              row.ownerUserId !== ownerId || row.executionId !== executionId
          )
        )
          return;
        setActions(rows);
        setError(null);
      } catch {
        if (scope.current === current)
          setError("Koed actions are temporarily unavailable.");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    const onVisibilityChange = () => void load();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      scope.current++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [api, executionId, ownerId, profileKey]);

  const run = async (action: KoedTextActionProjection) => {
    if (!onApply || busy.current || inFlight.current.has(action.id)) return;
    inFlight.current.add(action.id);
    busy.current = true;
    const current = scope.current;
    setBusyId(action.id);
    setError(null);
    let claimed: KoedTextActionProjection | null = null;
    let checkedExactEffect = false;
    try {
      const claimResult = await api.claim(
        executionId,
        action.id,
        action.revision
      );
      claimed = claimResult;
      if (scope.current !== current) return;
      setActions((rows) =>
        rows.map((row) => (row.id === action.id ? claimResult : row))
      );
      const applied = await onApply(claimResult);
      if (scope.current !== current) return;
      if (!applied) {
        if (!hasDurableServiceReceipt(action)) {
          setError(
            "This action needs reconciliation. Koed will not repeat it automatically."
          );
          return;
        }
        // A multi-step button service can return without a final response after
        // some steps succeeded. Read its exact receipt; never run it again.
        checkedExactEffect = true;
        const completed = await api.complete(
          executionId,
          action.id,
          claimResult.revision
        );
        if (scope.current === current)
          setActions((rows) =>
            rows.map((row) => (row.id === action.id ? completed : row))
          );
        return;
      }
      checkedExactEffect = true;
      const completed = await api.complete(
        executionId,
        action.id,
        claimResult.revision
      );
      if (scope.current !== current) return;
      setActions((rows) =>
        rows.map((row) => (row.id === action.id ? completed : row))
      );
    } catch {
      if (
        scope.current === current &&
        claimed &&
        !checkedExactEffect &&
        hasDurableServiceReceipt(action)
      ) {
        try {
          // Read the exact service receipt only. Never dispatch the effect again.
          checkedExactEffect = true;
          const completed = await api.complete(
            executionId,
            action.id,
            claimed.revision
          );
          if (scope.current === current) {
            setActions((rows) =>
              rows.map((row) => (row.id === action.id ? completed : row))
            );
            return;
          }
        } catch {
          /* No exact receipt; the claim remains uncertain. */
        }
      }
      if (scope.current === current)
        setError(
          "The action outcome is uncertain. Check its current state; Koed will not run it again automatically."
        );
    } finally {
      if (scope.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };
  const decide = async (
    action: KoedTextActionProjection,
    decision: "approve" | "decline"
  ) => {
    if (busy.current) return;
    busy.current = true;
    const current = scope.current;
    setBusyId(action.id);
    setError(null);
    try {
      const reviewed = await api.review(
        executionId,
        action.id,
        action.revision,
        decision
      );
      if (scope.current !== current) return;
      setActions((rows) =>
        rows.map((row) => (row.id === action.id ? reviewed : row))
      );
      if (decision === "approve") {
        busy.current = false;
        setBusyId(null);
        await run(reviewed);
      }
    } catch {
      if (scope.current === current)
        setError(
          "The action changed. Review the current request before continuing."
        );
    } finally {
      if (scope.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };
  const checkResult = async (action: KoedTextActionProjection) => {
    if (busy.current || !hasDurableServiceReceipt(action)) return;
    busy.current = true;
    const current = scope.current;
    setBusyId(action.id);
    setError(null);
    try {
      // A lost button-service response may have left an exact durable receipt.
      // This path only reads and completes that receipt. It never claims or
      // dispatches the effect again, including after an app restart.
      const latest = await api.get(executionId, action.id);
      if (scope.current !== current) return;
      if (
        latest.ownerUserId !== ownerId ||
        latest.executionId !== executionId ||
        latest.id !== action.id ||
        latest.name !== action.name
      ) {
        throw new Error("Koed action identity changed");
      }
      if (latest.state !== "claimed") {
        setActions((rows) =>
          rows.map((row) => (row.id === action.id ? latest : row))
        );
        return;
      }
      const completed = await api.complete(
        executionId,
        action.id,
        latest.revision
      );
      if (scope.current !== current) return;
      if (
        completed.ownerUserId !== ownerId ||
        completed.executionId !== executionId ||
        completed.id !== action.id ||
        completed.name !== action.name
      ) {
        throw new Error("Koed action identity changed");
      }
      setActions((rows) =>
        rows.map((row) => (row.id === action.id ? completed : row))
      );
    } catch {
      if (scope.current === current)
        setError(
          "The exact effect is not confirmed. Koed will not run it again automatically."
        );
    } finally {
      if (scope.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };
  const resumeMove = async (action: KoedTextActionProjection) => {
    if (
      busy.current ||
      !onResumeMove ||
      !["koed_chat_move", "koed_project_move_chats"].includes(action.name)
    )
      return;
    busy.current = true;
    const current = scope.current;
    setBusyId(action.id);
    setError(null);
    try {
      const latest = await api.get(executionId, action.id);
      if (
        scope.current !== current ||
        latest.state !== "claimed" ||
        latest.id !== action.id ||
        latest.ownerUserId !== ownerId ||
        latest.executionId !== executionId ||
        latest.name !== action.name
      )
        return;
      // Resume only the already prepared exact journal batch. The callback
      // never claims this action or dispatches its original move request.
      if (!(await onResumeMove(latest)))
        throw new Error("Existing reviewed move is still pending");
      const completed = await api.complete(
        executionId,
        action.id,
        latest.revision
      );
      if (
        completed.id !== action.id ||
        completed.ownerUserId !== ownerId ||
        completed.executionId !== executionId ||
        completed.name !== action.name
      )
        throw new Error("Reviewed move result changed identity");
      if (scope.current === current)
        setActions((rows) =>
          rows.map((row) => (row.id === action.id ? completed : row))
        );
    } catch {
      if (scope.current === current)
        setError(
          "The reviewed move remains pending. Koed will not start another move."
        );
    } finally {
      if (scope.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };
  const openDeck = async (action: KoedTextActionProjection) => {
    if (busy.current || !api.deckResult || !onOpenDeck) return;
    busy.current = true;
    const current = scope.current;
    setBusyId(action.id);
    setError(null);
    try {
      const receipt = await api.deckResult(executionId, action.id);
      if (scope.current !== current) return;
      if (
        receipt.state !== "applied" ||
        !receipt.result ||
        receipt.result.projectId !== action.snapshot.projectId
      )
        throw new Error("Deck receipt unavailable");
      onOpenDeck(receipt.result);
    } catch {
      if (scope.current === current)
        setError("The Deck is unavailable under your current Project access.");
    } finally {
      if (scope.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };
  useEffect(() => {
    if (!onApply || busy.current) return;
    const ready = actions.find(
      (action) =>
        action.state === "ready" &&
        action.reviewKind === "none" &&
        !inFlight.current.has(action.id)
    );
    if (ready) void run(ready);
  }, [actions, onApply]);

  if (!actions.length && !error) return null;
  return (
    <section className="hq-text-actions" aria-label="Koed actions">
      {error ? <p role="alert">{error}</p> : null}
      {actions.map((action) => (
        <article key={action.id} className="hq-text-action">
          <strong>{label[action.name]}</strong>
          <span className="hq-text-action__detail">{detail(action)}</span>
          {jobReviewDetails(action)}
          {deckReviewDetails(action)}
          {action.state === "awaiting_review" &&
          action.reviewKind === "ask_first" ? (
            <div className="hq-text-action__buttons">
              <button
                className="hq-text-action__button hq-text-action__button--primary"
                type="button"
                disabled={busyId !== null}
                onClick={() => void decide(action, "approve")}
              >
                Approve
              </button>
              <button
                className="hq-text-action__button"
                type="button"
                disabled={busyId !== null}
                onClick={() => void decide(action, "decline")}
              >
                Not now
              </button>
            </div>
          ) : null}
          {action.state === "awaiting_review" &&
          action.reviewKind === "native" ? (
            <div className="hq-text-action__buttons">
              <button
                className="hq-text-action__button hq-text-action__button--primary"
                type="button"
                disabled={!onNativeReview || busyId !== null}
                onClick={() => onNativeReview?.(action)}
              >
                Review exact effect
              </button>
            </div>
          ) : null}
          {action.state === "ready" && action.reviewKind !== "none" ? (
            <div className="hq-text-action__buttons">
              <button
                className="hq-text-action__button hq-text-action__button--primary"
                type="button"
                disabled={
                  !onApply || busyId !== null || inFlight.current.has(action.id)
                }
                onClick={() => void run(action)}
              >
                Run approved action
              </button>
            </div>
          ) : null}
          {action.state === "claimed" ? (
            <div className="hq-text-action__claimed">
              <small className="hq-text-action__detail">
                Checking the exact effect. Koed will not repeat it
                automatically.
              </small>
              <div className="hq-text-action__buttons">
                {hasDurableServiceReceipt(action) ? (
                  <button
                    className="hq-text-action__button"
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void checkResult(action)}
                  >
                    Check result
                  </button>
                ) : null}
                {onResumeMove &&
                ["koed_chat_move", "koed_project_move_chats"].includes(
                  action.name
                ) ? (
                  <button
                    className="hq-text-action__button hq-text-action__button--primary"
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void resumeMove(action)}
                  >
                    Continue reviewed move
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {action.state === "applied" ? (
            action.name === "koed_deck_make" ? (
              <div className="hq-text-action__buttons">
                <button
                  className="hq-text-action__button hq-text-action__button--primary"
                  type="button"
                  disabled={busyId !== null || !onOpenDeck || !api.deckResult}
                  onClick={() => void openDeck(action)}
                >
                  Open deck
                </button>
              </div>
            ) : (
              <small>
                {action.uiOutcome === "opened_composer"
                  ? "Composer opened"
                  : "Done"}
              </small>
            )
          ) : null}
          {action.state === "declined" ? <small>Not run</small> : null}
          {action.state === "unavailable" ? (
            <small>Unavailable for this Project or chat.</small>
          ) : null}
        </article>
      ))}
    </section>
  );
}
