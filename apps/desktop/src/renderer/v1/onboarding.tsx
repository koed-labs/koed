import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopStatusStore } from "../services/desktop-commands.js";
import { useDesktopStatus } from "../state/use-status.js";
import { Arrow, ClientSetup } from "./onboarding/ClientSetup.js";
import { LoadingKin } from "./onboarding/LoadingKin.js";
import { OnboardingConfetti } from "./onboarding/OnboardingConfetti.js";
import {
  clientReady,
  clients,
  errorText,
  restoreAgent,
  restoreOnboarding,
  setupState,
  type ClientId,
  type OnboardingAgent,
  type OnboardingDraft
} from "./onboarding/model.js";
import { useSetup } from "./onboarding/use-setup.js";
import "./onboarding.css";
export type { OnboardingAgent, OnboardingDraft } from "./onboarding/model.js";

export type V1OnboardingProps = {
  savedAgent?: OnboardingAgent | null;
  savedDraft?: unknown;
  onSaveDraft?: (draft: OnboardingDraft) => Promise<void> | void;
  onSaveAgent: (agent: OnboardingAgent) => Promise<void> | void;
  onComplete: () => Promise<void> | void;
  statusStore: DesktopStatusStore;
};
export function V1Onboarding({
  savedAgent,
  savedDraft,
  onSaveDraft,
  onSaveAgent,
  onComplete,
  statusStore
}: V1OnboardingProps) {
  const setup = useSetup();
  const [setupStarted, setSetupStarted] = useState(false);
  const state = setupState(setup.error ? null : setup.snapshot);
  const { busyCommand } = useDesktopStatus(statusStore);
  const [restored] = useState(() => restoreOnboarding(savedDraft));
  const [screen, setScreen] = useState<OnboardingDraft["step"]>(
    restored.step === "complete" ? "clients" : restored.step
  );
  const [agent] = useState(() => restoreAgent(savedAgent, savedDraft));
  const agentSaved = useRef(!!savedAgent?.name.trim());
  const [draftRetry, setDraftRetry] = useState(0);
  const [selected, setSelected] = useState(restored.selected);
  const [selectionInitialized, setSelectionInitialized] = useState(
    restored.selectionInitialized
  );
  const [feedback, setFeedback] = useState({
    found: 0,
    scanned: false,
    failed: false
  });
  const [messageIndex, setMessageIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const finishLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const draftWrites = useRef<Promise<void>>(Promise.resolve());
  const saveDraftRef = useRef(onSaveDraft);
  const draftSequence = useRef(0);
  saveDraftRef.current = onSaveDraft;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const sequence = ++draftSequence.current;
    const draft: OnboardingDraft = {
      version: 2,
      step: screen,
      selected,
      selectionInitialized,
      agent
    };
    draftWrites.current = draftWrites.current
      .catch(() => undefined)
      .then(() => saveDraftRef.current?.(draft));
    void draftWrites.current
      .then(() => {
        if (mounted.current && sequence === draftSequence.current)
          setDraftError(null);
      })
      .catch((cause) => {
        if (mounted.current && sequence === draftSequence.current)
          setDraftError(errorText(cause));
      });
  }, [screen, selected, selectionInitialized, agent, draftRetry]);
  const running =
    setup.busy || (!setup.error && setup.snapshot?.state === "running");
  const failed =
    !running && (!!setup.error || setup.snapshot?.state === "failed");
  // A restored draft cannot bypass current prerequisite inspection.
  const showingClients = screen === "clients" && state.ready && !setup.busy;
  const complete = screen === "complete" && state.ready;
  const welcome =
    !setupStarted &&
    !showingClients &&
    !complete &&
    !failed &&
    !state.ready &&
    setup.snapshot?.state !== "running";
  useEffect(() => {
    setMessageIndex(0);
    if (!running || state.ready) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) setMessageIndex((i) => i + 1);
    }, 3400);
    return () => window.clearInterval(interval);
  }, [state.activeId, state.ready, running]);
  useEffect(() => {
    if (failed || complete || completeError) heading.current?.focus();
  }, [failed, complete, completeError]);
  const onSelection = useCallback((ids: ClientId[]) => {
    setSelected(ids);
    setSelectionInitialized(true);
  }, []);
  const onFeedback = useCallback(
    (next: typeof feedback) => setFeedback(next),
    []
  );
  const message = complete
    ? "You’re all set."
    : failed
      ? "A little hiccup."
      : state.ready
        ? "Your Koed is ready."
        : running && setup.snapshot
          ? state.copy.messages[messageIndex % state.copy.messages.length]
          : setup.busy
            ? "Finding a home for Koed…"
            : "A little less repeating. A lot more creating.";

  async function finish() {
    if (finishLock.current || busyCommand) return;
    finishLock.current = true;
    setFinishing(true);
    setCompleteError(null);
    try {
      const [freshSetup, freshStatus] = await Promise.all([
        setup.inspect(),
        statusStore.refresh()
      ]);
      if (!freshSetup || !setupState(freshSetup).ready) {
        setScreen("setup");
        throw new Error("Local setup needs another check before you finish.");
      }
      if (!clients.some((c) => clientReady(c.id, freshStatus))) {
        setScreen("clients");
        throw new Error(
          "Connect at least one ready, signed-in AI Client before finishing."
        );
      }
      await draftWrites.current;
      // Existing identity and its serialized metadata stay untouched.
      if (!agentSaved.current) {
        await onSaveAgent(agent);
        agentSaved.current = true;
      }
      await onComplete();
    } catch (cause) {
      if (mounted.current) {
        setCompleteError(errorText(cause));
        setFinishing(false);
      }
      finishLock.current = false;
    }
  }
  return (
    <main
      className={`lp-workspace ${showingClients ? "lp-client-workspace" : ""}`}
    >
      <div className="lp-window-drag" aria-hidden="true" />
      {complete && (
        <div className="lp-celebration confetti-active" data-confetti-container>
          <OnboardingConfetti />
        </div>
      )}
      <section
        className={`lp-loader ${showingClients ? "lp-client-screen" : ""} ${complete ? "lp-complete-screen" : ""} ${failed ? "lp-setup-error" : ""}`}
        aria-label={
          complete
            ? "All set"
            : showingClients
              ? "Connect AI Clients"
              : "Setting up Koed"
        }
      >
        <div className="lp-kin-area">
          <div className="lp-kin-stage">
            <LoadingKin
              initialized={!!setup.snapshot}
              complete={complete || (!showingClients && state.ready)}
              stage={showingClients ? (feedback.scanned ? 1 : 0) : state.index}
              midpointReached={
                !showingClients && !failed && (state.fraction ?? 0) >= 0.5
              }
              sad={failed || (showingClients && feedback.failed)}
            />
          </div>
          {showingClients && (
            <div className="lp-kin-caption">
              <p key={feedback.failed ? "failed" : feedback.found}>
                {feedback.failed
                  ? "A little hiccup. We can try again."
                  : !feedback.scanned
                    ? "Let’s make some introductions."
                    : feedback.found
                      ? "Looks like we’re in good company."
                      : "A few new faces to meet."}
              </p>
            </div>
          )}
        </div>
        {showingClients ? (
          <ClientSetup
            statusStore={statusStore}
            selected={selected}
            selectionInitialized={selectionInitialized}
            onSelection={onSelection}
            onFeedback={onFeedback}
            onFinished={() => {
              setCompleteError(null);
              setScreen("complete");
            }}
          />
        ) : welcome ? (
          <button
            type="button"
            className="lp-primary-button lp-next-button"
            disabled={setup.busy}
            onClick={() => {
              setSetupStarted(true);
              void setup.run();
            }}
          >
            Get Started
          </button>
        ) : (
          <>
            <h1 ref={heading} tabIndex={-1} className="lp-message-window">
              <span key={message} className="lp-scrolling-message">
                {message}
              </span>
            </h1>
            {complete ? (
              <button
                type="button"
                className="lp-primary-button lp-next-button lp-finish-button"
                disabled={finishing || !!busyCommand}
                onClick={() => void finish()}
              >
                {finishing ? "Opening Koed…" : "Let’s go"}
              </button>
            ) : (
              <>
                {failed && (
                  <p className="lp-setup-error-detail" role="alert">
                    {setup.error ??
                      setup.snapshot?.error ??
                      `${state.copy.name} couldn’t finish setting up. Let’s try that step again.`}
                  </p>
                )}
                <div className="lp-progress-stack">
                  <div className="lp-progress-block">
                    <div className="lp-progress-label">
                      <span>
                        {state.ready
                          ? "Setup complete"
                          : running
                            ? setup.snapshot
                              ? state.copy.label
                              : "Checking local setup"
                            : failed
                              ? state.copy.label
                              : "Ready to set up Koed"}
                      </span>
                      <span>{state.percent}%</span>
                    </div>
                    <div
                      className={`lp-progress-track ${running && state.indeterminate && !state.ready ? "is-indeterminate" : ""}`}
                      style={
                        {
                          "--lp-stage-start": `${(state.done * 100) / 6}%`,
                          "--lp-stage-size": `${100 / 6}%`
                        } as React.CSSProperties
                      }
                      role="progressbar"
                      aria-label="Overall setup progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={state.percent}
                      aria-valuetext={
                        running && state.indeterminate
                          ? `${state.percent}% confirmed; ${state.copy.label} in progress`
                          : `${state.percent}%`
                      }
                    >
                      <i
                        style={{ transform: `scaleX(${state.value / 100})` }}
                      />
                    </div>
                  </div>
                  {running && state.detail && (
                    <p className="lp-progress-detail">{state.detail}</p>
                  )}
                </div>
                {state.ready ? (
                  <button
                    type="button"
                    className="lp-primary-button lp-next-button"
                    disabled={running}
                    onClick={() => {
                      setCompleteError(null);
                      setScreen("clients");
                    }}
                  >
                    Next <Arrow />
                  </button>
                ) : (
                  !running &&
                  (setup.error && setup.snapshot?.state !== "failed" ? (
                    <button
                      type="button"
                      className="lp-primary-button lp-next-button"
                      onClick={() => void setup.inspect()}
                    >
                      Check again
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="lp-primary-button lp-next-button"
                        onClick={() => void setup.run()}
                      >
                        {failed ? "Retry step" : "Get Started"}
                      </button>
                      {failed && (
                        <p className="lp-live-detail">
                          Completed steps are retained when you retry.
                        </p>
                      )}
                    </>
                  ))
                )}
              </>
            )}
          </>
        )}
        {completeError && (
          <p className="lp-error" role="alert">
            {completeError}
          </p>
        )}
        {draftError && (
          <p className="lp-error" role="alert">
            Could not save setup progress: {draftError}{" "}
            <button
              type="button"
              className="lp-text-button"
              disabled={finishing}
              onClick={() => setDraftRetry((value) => value + 1)}
            >
              Retry saving progress
            </button>
          </p>
        )}
      </section>
      {!showingClients && !welcome && (
        <p className="lp-sr-only" role="status" aria-live="polite">
          {complete
            ? "Setup complete. Your AI Clients are connected."
            : failed
              ? `Setup paused at ${state.copy.name}. Retry to continue.`
              : state.ready
                ? "Setup complete. Choose Next to connect your AI Clients."
                : running
                  ? `Step ${state.index + 1} of 6: ${state.copy.label}. ${state.copy.description}`
                  : "Choose Get Started to prepare this device."}
        </p>
      )}
    </main>
  );
}
