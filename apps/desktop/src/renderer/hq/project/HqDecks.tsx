import { BookOpen, ChevronLeft, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DeckDesktopApi } from "../../../ipc/deck-protocol.js";
import type {
  Deck,
  deckProgressListSchema
} from "@koed/shared/flashcard-deck-contract";
import type { z } from "zod";
import "./hq-decks.css";

type Progress = z.infer<typeof deckProgressListSchema>["progress"];
const intervalLabel = (kind: "good" | "easy", box: number) => {
  const days = (kind === "good" ? [1, 3, 7, 14, 30] : [3, 7, 14, 30, 60])[
    Math.min(box, 4)
  ]!;
  return days === 1 ? "tomorrow" : `${days}d`;
};
export function HqDecks({
  api,
  agentNames,
  projectId,
  ownerId,
  profileKey,
  panelHost,
  openDeckId,
  openDeckNonce,
  closeSignal,
  dismissSignal,
  dismissToken,
  onOpenChange,
  onContextChange
}: {
  api: DeckDesktopApi;
  agentNames: Record<string, string>;
  projectId: string;
  ownerId: string | null | undefined;
  profileKey: string | null | undefined;
  panelHost?: HTMLElement | null;
  openDeckId?: string | null;
  openDeckNonce?: number;
  closeSignal?: number;
  /** Another right-panel view took focus. This dismissal is intentionally silent. */
  dismissSignal?: number;
  dismissToken?: { current: number };
  onOpenChange?: (open: boolean) => void;
  onContextChange?: (label: string | null) => void;
}) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [decksIdentity, setDecksIdentity] = useState("");
  const [selected, setSelected] = useState<Deck | null>(null);
  const [selectedIdentity, setSelectedIdentity] = useState("");
  const [progress, setProgress] = useState<Progress>([]);
  const [tab, setTab] = useState<"study" | "all">("study");
  const [flipped, setFlipped] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [learningRetryCardId, setLearningRetryCardId] = useState<string | null>(
    null
  );
  const [learningNotice, setLearningNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const identity = `${ownerId ?? ""}:${profileKey ?? ""}:${projectId}`;
  const generation = useRef({ identity, value: 0 });
  if (generation.current.identity !== identity) {
    generation.current.identity = identity;
    generation.current.value++;
  }
  const previousDismissSignal = useRef(dismissSignal);
  if (previousDismissSignal.current !== dismissSignal) {
    previousDismissSignal.current = dismissSignal;
    generation.current.value++;
  }
  const selectedForScope = selectedIdentity === identity ? selected : null;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      setSelected(null);
      setProgress([]);
      setLearningNotice("");
      setLearningRetryCardId(null);
      onOpenChange?.(false);
      onContextChange?.(null);
    }
  }, [identity]);
  useEffect(
    () => () => {
      generation.current.value++;
    },
    []
  );
  useEffect(() => {
    let live = true;
    setDecks([]);
    setSelected(null);
    setProgress([]);
    setError("");
    void api
      .list(projectId)
      .then((value) => {
        if (live) {
          setDecks(value.decks);
          setDecksIdentity(identity);
        }
      })
      .catch(() => {
        if (live)
          setError("Decks unavailable. Retry when this Project is available.");
      });
    return () => {
      live = false;
    };
  }, [api, identity, projectId, revision]);
  useEffect(() => {
    if (closeSignal) {
      generation.current.value++;
      setSelected(null);
      onOpenChange?.(false);
      onContextChange?.(null);
    }
  }, [closeSignal]);
  useEffect(() => {
    if (!dismissSignal) return;
    setSelected(null);
    setProgress([]);
    setSeen(new Set());
    setFlipped(false);
    setLearningRetryCardId(null);
    setLearningNotice("");
  }, [dismissSignal]);
  const open = async (deckId: string) => {
    const token = ++generation.current.value;
    const dismissGeneration = dismissToken?.current;
    const current = () =>
      generation.current.value === token &&
      generation.current.identity === identity &&
      dismissToken?.current === dismissGeneration;
    setBusy(true);
    setError("");
    try {
      const deck = await api.open(projectId, deckId);
      const state = await api.progress(projectId, deckId);
      if (!current()) return;
      setSelected(deck);
      setSelectedIdentity(identity);
      setProgress(state.progress);
      setSeen(new Set());
      setFlipped(false);
      setTab("study");
      setLearningRetryCardId(null);
      setLearningNotice("");
      const missed = state.progress.find(
        (row) =>
          row.misses > 0 && deck.cards.some((card) => card.id === row.cardId)
      );
      if (missed) {
        try {
          const status = await api.learning(projectId, deckId, missed.cardId);
          if (!current()) return;
          if (status === "projection_pending" || status === "retry_needed") {
            setLearningRetryCardId(missed.cardId);
            setLearningNotice(
              "Learning proposal is waiting for Personal Memory. Retry when it is ready."
            );
          } else if (status === "conflicted" || status === "skipped") {
            setLearningNotice(
              "This learning proposal could not be completed. Review it in Me memory."
            );
          }
        } catch {
          if (!current()) return;
          setLearningRetryCardId(missed.cardId);
          setLearningNotice(
            "Learning proposal could not be checked. Retry when this Project is available."
          );
        }
      }
      onOpenChange?.(true);
      onContextChange?.(deck.title);
    } catch {
      if (!current()) return;
      setError("This Deck is unavailable. Refresh the Project and try again.");
    } finally {
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    if (openDeckId) void open(openDeckId);
  }, [openDeckId, openDeckNonce, identity]);
  const close = () => {
    generation.current.value++;
    setSelected(null);
    onOpenChange?.(false);
    onContextChange?.(null);
  };
  const due = useMemo(
    () =>
      selectedForScope?.cards
        .filter((card) => {
          const row = progress.find((p) => p.cardId === card.id);
          return (
            !seen.has(card.id) &&
            (!row?.nextAt || Date.parse(row.nextAt) <= Date.now())
          );
        })
        .sort((left, right) => {
          const nextAt = (cardId: string) => {
            const value = progress.find((row) => row.cardId === cardId)?.nextAt;
            return value ? Date.parse(value) : 0;
          };
          return nextAt(left.id) - nextAt(right.id);
        }) ?? [],
    [selectedForScope, progress, seen]
  );
  const card = due[0];
  const grade = async (rating: "again" | "good" | "easy") => {
    if (!selectedForScope || !card || busy) return;
    const token = generation.current.value;
    const current = () =>
      generation.current.value === token &&
      generation.current.identity === identity;
    const row = progress.find((p) => p.cardId === card.id);
    setBusy(true);
    setError("");
    try {
      const saved = await api.grade(
        projectId,
        selectedForScope.id,
        card.id,
        rating,
        row?.box ?? 0,
        row?.misses ?? 0,
        selectedForScope.version,
        card.version
      );
      if (!current()) return;
      setProgress((previous) => [
        ...previous.filter((p) => p.cardId !== card.id),
        saved.progress
      ]);
      if (
        rating === "again" &&
        (saved.learningStatus === "projection_pending" ||
          saved.learningStatus === "retry_needed")
      ) {
        setLearningRetryCardId(card.id);
        setLearningNotice(
          "Learning proposal is waiting for Personal Memory. Retry when it is ready."
        );
      }
      if (
        rating === "again" &&
        (saved.learningStatus === "conflicted" ||
          saved.learningStatus === "skipped")
      )
        setLearningNotice(
          "This learning proposal could not be completed. Review it in Me memory."
        );
      if (rating !== "again")
        setSeen((previous) => new Set([...previous, card.id]));
      setFlipped(false);
    } catch {
      if (!current()) return;
      setError("Your answer was not saved. Refresh this Deck and try again.");
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <div className="hq-decks__keys" aria-label="Flashcard Decks">
        {(decksIdentity === identity ? decks : []).map((deck) => (
          <button
            type="button"
            className="hq-decks__chip"
            key={deck.id}
            onClick={() => void open(deck.id)}
          >
            <BookOpen size={14} />
            {deck.title}
            <small>{deck.cards.length}</small>
          </button>
        ))}
        {(decksIdentity !== identity || decks.length === 0) && !error ? (
          <span className="hq-decks__empty">No Decks yet</span>
        ) : null}
        {error && !selectedForScope ? (
          <button
            type="button"
            className="hq-decks__retry"
            onClick={() => setRevision((n) => n + 1)}
          >
            <RotateCw size={13} /> Retry Decks
          </button>
        ) : null}
      </div>
      {selectedForScope && panelHost
        ? createPortal(
            <aside
              className="hq-decks__panel"
              aria-label={`${selectedForScope.title} Deck`}
            >
              <div className="hq-decks__head">
                <button
                  type="button"
                  onClick={close}
                  aria-label="Back to Project"
                >
                  <ChevronLeft size={17} />
                </button>
                <span>{selectedForScope.title}</span>
                <button type="button" onClick={close} aria-label="Close Deck">
                  <X size={17} />
                </button>
              </div>
              <p className="hq-decks__scope">
                {selectedForScope.cards.length}{" "}
                {selectedForScope.cards.length === 1 ? "card" : "cards"} ·{" "}
                {selectedForScope.scope} ·{" "}
                {selectedForScope.createdByAgentId &&
                agentNames[selectedForScope.createdByAgentId]
                  ? `made by ${agentNames[selectedForScope.createdByAgentId]} from `
                  : "made from "}
                {selectedForScope.madeFrom}
              </p>
              <div
                className="hq-decks__tabs"
                role="tablist"
                aria-label="Deck view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "study"}
                  onClick={() => setTab("study")}
                >
                  Study <span>{due.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "all"}
                  onClick={() => setTab("all")}
                >
                  All cards <span>{selectedForScope.cards.length}</span>
                </button>
              </div>
              {tab === "study" ? (
                card ? (
                  <>
                    <p className="hq-decks__count">
                      {due.length} to review today
                      {card.sourceRef ? ` · ${card.sourceRef}` : ""}
                    </p>
                    <button
                      type="button"
                      className={`hq-decks__card${flipped ? " hq-decks__card--revealed" : ""}`}
                      onClick={() => setFlipped((v) => !v)}
                      aria-label={
                        flipped ? "Show question" : "Flip card to see answer"
                      }
                    >
                      <strong>{card.question}</strong>
                      {flipped ? (
                        <span>{card.answer}</span>
                      ) : (
                        <em>Click to see the answer</em>
                      )}
                    </button>
                    {flipped ? (
                      <div className="hq-decks__ratings">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void grade("again")}
                        >
                          Again<small>today</small>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void grade("good")}
                        >
                          Good
                          <small>
                            {intervalLabel(
                              "good",
                              progress.find((p) => p.cardId === card.id)?.box ??
                                0
                            )}
                          </small>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void grade("easy")}
                        >
                          Easy
                          <small>
                            {intervalLabel(
                              "easy",
                              progress.find((p) => p.cardId === card.id)?.box ??
                                0
                            )}
                          </small>
                        </button>
                      </div>
                    ) : (
                      <div className="hq-decks__ratings">
                        <button type="button" onClick={() => setFlipped(true)}>
                          Show answer
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="hq-decks__done">
                    <BookOpen size={26} />
                    <h3>Done for today</h3>
                    <p>
                      {(() => {
                        const next = progress
                          .map((row) => row.nextAt)
                          .filter(
                            (value): value is string =>
                              Boolean(value) && Date.parse(value!) > Date.now()
                          )
                          .sort()[0];
                        return next
                          ? `Next review ${new Date(next).toLocaleDateString()}. Cards you find hard come back sooner.`
                          : "Cards you find hard come back sooner.";
                      })()}
                    </p>
                  </div>
                )
              ) : (
                <div className="hq-decks__all">
                  {selectedForScope.cards.map((item, index) => {
                    const state = progress.find(
                      (row) => row.cardId === item.id
                    );
                    return (
                      <article key={item.id}>
                        <small>
                          {String(index + 1).padStart(2, "0")}
                          {item.topicLabel ? ` · ${item.topicLabel}` : ""}
                        </small>
                        <strong>{item.question}</strong>
                        <p>{item.answer}</p>
                        <small>
                          {item.sourceRef ?? ""}
                          {state?.nextAt &&
                          Date.parse(state.nextAt) > Date.now()
                            ? ` · next ${new Date(state.nextAt).toLocaleDateString()}`
                            : " · due today"}
                          {state?.misses ? " · hard for you" : ""}
                        </small>
                      </article>
                    );
                  })}
                </div>
              )}
              <p className="hq-decks__scope">
                Made from {selectedForScope.madeFrom}. Cards you mark Again come
                back today, and Koed proposes what you find hard for your Me
                memory.
              </p>
              {error ? (
                <p role="alert" className="hq-decks__error">
                  {error}
                </p>
              ) : null}
              {learningNotice ? (
                <p role="status" className="hq-decks__learning">
                  {learningNotice}{" "}
                  {learningRetryCardId ? (
                    <button
                      type="button"
                      onClick={() => {
                        const token = generation.current.value;
                        const retryCardId = learningRetryCardId;
                        void api
                          .learning(projectId, selectedForScope.id, retryCardId)
                          .then((status) => {
                            if (
                              generation.current.value !== token ||
                              generation.current.identity !== identity
                            )
                              return;
                            if (
                              status !== "projection_pending" &&
                              status !== "retry_needed"
                            ) {
                              setLearningNotice("");
                              setLearningRetryCardId(null);
                            }
                          })
                          .catch(() => {
                            if (
                              generation.current.value !== token ||
                              generation.current.identity !== identity
                            )
                              return;
                            setLearningNotice(
                              "Learning proposal is still unavailable. Retry when this Project is available."
                            );
                          });
                      }}
                    >
                      Retry learning
                    </button>
                  ) : null}
                </p>
              ) : null}
            </aside>,
            panelHost
          )
        : null}
    </>
  );
}
