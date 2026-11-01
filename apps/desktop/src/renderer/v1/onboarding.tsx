import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopSetupSnapshot,
  DesktopSetupStage,
  KoedServerStatus
} from "../../types.js";
import type { DesktopStatusStore } from "../services/desktop-commands.js";
import { useDesktopStatus } from "../state/use-status.js";
import {
  AgentLookPicker,
  DEFAULT_AGENT_LOOK,
  Pixelkin,
  V1Composer,
  type AgentLook
} from "./visual.js";
import "./onboarding.css";

export type OnboardingAgent = { name: string; look: AgentLook };
export type MemoryDemoResult = { message: string; evidence?: string };
export type OnboardingDraft = {
  agent: OnboardingAgent;
  step: "maker" | "intro" | "ai" | "memory" | "summary";
  introWhat: boolean;
  whatQuestion: string | null;
  aiMode: "intro" | "scan" | "manual";
  aiActions: string[];
  skippedFrom: "intro" | "ai" | "memory" | null;
  composerText: string;
  submittedNote: string | null;
  guidanceTurns: { user: string; reply: string }[];
  scanned: boolean;
  clientResults: Partial<Record<ClientId, ClientResult>>;
  note: string;
  demoResult: MemoryDemoResult | null;
};
export type V1OnboardingProps = {
  savedAgent?: OnboardingAgent | null;
  savedDraft?: OnboardingDraft | null;
  onSaveDraft?: (draft: OnboardingDraft) => Promise<void> | void;
  onSaveAgent: (agent: OnboardingAgent) => Promise<void> | void;
  onComplete: () => Promise<void> | void;
  onMemoryDemo?: (text: string) => Promise<MemoryDemoResult>;
  statusStore: DesktopStatusStore;
  userName?: string | null;
};

type ClientId = "codex" | "claude" | "pi";
type ClientResult = {
  state: "ready" | "sign-in" | "unknown-auth" | "failed";
  detail?: string;
};
const clients: { id: ClientId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" }
];
const stageNames: Record<DesktopSetupStage["id"], string> = {
  package: "Koed package",
  runtime: "Local runtime",
  model: "Memory models",
  services: "Local services",
  integration: "Koed core integration",
  verification: "Verification"
};
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const operationOk = (
  value: unknown
): value is {
  ok: true;
  authenticationState?: string;
  profileConfigured?: boolean;
} =>
  !!value &&
  typeof value === "object" &&
  (value as { ok?: unknown }).ok === true;
const configured = (id: ClientId, status: KoedServerStatus | null) =>
  id === "codex"
    ? status?.codex.configured === true
    : id === "claude"
      ? status?.claudeCode?.configured === true
      : status?.pi?.configured === true;
const commandFor = (id: ClientId, status: KoedServerStatus | null) => {
  const item = status?.aiClients?.[id];
  const missingRegistration = item?.capabilities.some((c) =>
    c.diagnostics.some((d) => d.code === "instance_not_registered")
  );
  return item?.profile.state === "healthy" && !missingRegistration
    ? (`check_${id}` as const)
    : ((configured(id, status) || missingRegistration
        ? `repair_${id}`
        : `setup_${id}`) as
        | "setup_codex"
        | "setup_claude"
        | "setup_pi"
        | "repair_codex"
        | "repair_claude"
        | "repair_pi");
};
const clientAuthenticationGuidance = (
  id: ClientId,
  state: string
): string | null => {
  if (state === "Sign in required") {
    if (id === "claude")
      return "Run `claude auth login` in your terminal, then check again. Claude Desktop sign-in does not authenticate Claude Code.";
    if (id === "pi")
      return "Authenticate at least one model through Pi, then check again. Profile reinstall is not required.";
    return "Sign in to Codex, then check again. Profile reinstall is not required.";
  }
  if (state === "Check sign-in") {
    if (id === "claude")
      return "Run `claude auth status`, resolve its error, then check again.";
    if (id === "pi")
      return "Fix Pi model discovery, then check again. Pi-executed work remains unavailable.";
    return "Check Codex sign-in and refresh its capabilities.";
  }
  return null;
};

function SetupProgress({
  snapshot,
  error,
  busy,
  onRun,
  onInspect
}: {
  snapshot: DesktopSetupSnapshot | null;
  error: string | null;
  busy: boolean;
  onRun: () => void;
  onInspect: () => void;
}) {
  const stages = snapshot?.stages ?? [];
  const done = stages.filter((s) => s.state === "complete").length;
  const active = stages.find((s) => s.state === "running");
  const fraction =
    active?.totalBytes && active.completedBytes !== null
      ? Math.min(1, active.completedBytes / active.totalBytes)
      : 0;
  const percent = stages.length
    ? Math.round((100 * (done + fraction)) / stages.length)
    : 0;
  const ready =
    snapshot?.state === "complete" &&
    stages.every((s) => s.state === "complete");
  return (
    <div className="v1-ob-card v1-ob-prep" aria-live="polite">
      <div className="v1-ob-card-head">
        <strong>
          {ready
            ? "Koed is ready on this Mac"
            : busy || snapshot?.state === "running"
              ? "Getting Koed ready"
              : "Prepare Koed on this Mac"}
        </strong>
        {snapshot && <span>{ready ? "Ready" : `${percent}%`}</span>}
      </div>
      {!ready && (
        <>
          <div
            className="v1-ob-progress"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          {(snapshot?.state === "failed" ? stages : []).map((stage) => (
            <div className="v1-ob-stage" key={stage.id}>
              <span>
                {stage.state === "complete"
                  ? "✓"
                  : stage.state === "failed"
                    ? "!"
                    : stage.state === "running"
                      ? "◌"
                      : "·"}
              </span>
              <span>{stageNames[stage.id]}</span>
              <small>
                {stage.state === "running" || stage.state === "failed"
                  ? stage.message
                  : stage.state === "complete"
                    ? "Done"
                    : "Waiting"}
              </small>
            </div>
          ))}
          {(error || snapshot?.error) && (
            <p role="alert" className="v1-ob-error">
              {error || snapshot?.error}
            </p>
          )}
          {!snapshot && error && (
            <button
              type="button"
              className="v1-ob-mini"
              disabled={busy}
              onClick={onInspect}
            >
              Check again
            </button>
          )}
          {snapshot && !busy && snapshot.state !== "running" && (
            <button type="button" className="v1-ob-mini" onClick={onRun}>
              {snapshot?.state === "failed" ? "Try again" : "Set up Koed"}
            </button>
          )}
          {snapshot?.state === "failed" && (
            <p className="v1-ob-muted">
              Completed steps are retained if you retry.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function V1Onboarding({
  savedAgent,
  savedDraft,
  onSaveDraft,
  onSaveAgent,
  onComplete,
  onMemoryDemo,
  statusStore,
  userName
}: V1OnboardingProps) {
  const { status } = useDesktopStatus(statusStore);
  const [agent, setAgent] = useState<OnboardingAgent>(
    savedDraft?.agent ?? savedAgent ?? { name: "", look: DEFAULT_AGENT_LOOK }
  );
  const [step, setStep] = useState<OnboardingDraft["step"]>(
    savedDraft?.step ?? "maker"
  );
  const [introWhat, setIntroWhat] = useState(savedDraft?.introWhat ?? false);
  const [whatQuestion, setWhatQuestion] = useState(
    savedDraft?.whatQuestion ?? null
  );
  const [aiMode, setAiMode] = useState<OnboardingDraft["aiMode"]>(
    savedDraft?.aiMode ?? "intro"
  );
  const [aiActions, setAiActions] = useState(savedDraft?.aiActions ?? []);
  const [skippedFrom, setSkippedFrom] = useState<
    OnboardingDraft["skippedFrom"]
  >(savedDraft?.skippedFrom ?? null);
  const [skipError, setSkipError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState(
    savedDraft?.composerText ?? ""
  );
  const [submittedNote, setSubmittedNote] = useState(
    savedDraft?.submittedNote ?? null
  );
  const [guidanceTurns, setGuidanceTurns] = useState(
    savedDraft?.guidanceTurns ?? []
  );
  const [setup, setSetup] = useState<DesktopSetupSnapshot | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupConfirm, setSetupConfirm] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanned, setScanned] = useState(savedDraft?.scanned ?? false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [clientBusy, setClientBusy] = useState<ClientId | null>(null);
  const [clientConfirm, setClientConfirm] = useState<ClientId | null>(null);
  const [clientResults, setClientResults] = useState<
    Partial<Record<ClientId, ClientResult>>
  >(savedDraft?.clientResults ?? {});
  const [note, setNote] = useState(savedDraft?.note ?? "");
  const [demoResult, setDemoResult] = useState<MemoryDemoResult | null>(
    savedDraft?.demoResult ?? null
  );
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const saveDraftRef = useRef(onSaveDraft);
  const draftSequence = useRef(0);
  const draftWrites = useRef<Promise<void>>(Promise.resolve());
  saveDraftRef.current = onSaveDraft;
  useEffect(() => {
    const sequence = ++draftSequence.current;
    const draft = {
      agent,
      step,
      introWhat,
      whatQuestion,
      aiMode,
      aiActions,
      skippedFrom,
      composerText,
      submittedNote,
      guidanceTurns,
      scanned,
      clientResults,
      note,
      demoResult
    };
    draftWrites.current = draftWrites.current
      .catch(() => undefined)
      .then(() => saveDraftRef.current?.(draft));
    void draftWrites.current
      .then(() => {
        if (draftSequence.current === sequence) setDraftError(null);
      })
      .catch((cause) => {
        if (draftSequence.current === sequence) setDraftError(errorText(cause));
      });
  }, [
    agent,
    step,
    introWhat,
    whatQuestion,
    aiMode,
    aiActions,
    skippedFrom,
    composerText,
    submittedNote,
    guidanceTurns,
    scanned,
    clientResults,
    note,
    demoResult
  ]);
  const setupApi = window.koedDesktop?.setup;
  const inspectSetup = async () => {
    if (!setupApi) {
      setSetupError("Desktop setup is unavailable.");
      return;
    }
    setSetupBusy(true);
    setSetupError(null);
    try {
      setSetup(await setupApi.inspect());
    } catch (cause) {
      setSetupError(errorText(cause));
    } finally {
      setSetupBusy(false);
    }
  };
  useEffect(() => {
    if (step === "maker") return;
    if (!setupApi) {
      setSetupError("Desktop setup is unavailable.");
      return;
    }
    const unsubscribe = setupApi.subscribe(setSetup);
    void inspectSetup();
    return unsubscribe;
  }, [setupApi, step === "maker"]);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [
    step,
    setup,
    clientResults,
    demoResult,
    guidanceTurns,
    submittedNote,
    introWhat,
    aiActions
  ]);
  const greeting = userName?.trim()
    ? `Hi ${userName.trim()}, welcome to Koed.`
    : "Hi, welcome to Koed.";
  const prepared =
    setup?.state === "complete" &&
    setup.stages.every((s) => s.state === "complete");
  const connected = useMemo(
    () =>
      clients.filter(({ id }) => {
        const readiness = status?.aiClients?.[id];
        return (
          readiness?.profile.state === "healthy" &&
          readiness.authentication === "authenticated"
        );
      }),
    [status]
  );
  const saveAgent = async (typedName?: string) => {
    const name = (typedName ?? agent.name).trim();
    if (!name) {
      setNameError("Give your agent a name.");
      return;
    }
    setSaveBusy(true);
    setNameError(null);
    try {
      await onSaveAgent({ ...agent, name });
      setAgent((a) => ({ ...a, name }));
      setStep("intro");
    } catch (cause) {
      setNameError(errorText(cause));
    } finally {
      setSaveBusy(false);
    }
  };
  const runSetup = async () => {
    if (!setupApi || setupBusy) return;
    setSetupConfirm(false);
    setSetupBusy(true);
    setSetupError(null);
    try {
      const next = await setupApi.run();
      setSetup(next);
      if (next.state === "complete") await statusStore.refresh();
    } catch (cause) {
      setSetupError(errorText(cause));
    } finally {
      setSetupBusy(false);
    }
  };
  const scan = async () => {
    setScanBusy(true);
    setScanned(false);
    setScanError(null);
    setAiMode("scan");
    setAiActions((current) => [...current, "Look for them"]);
    try {
      const next = await statusStore.refresh();
      if (!next)
        throw new Error(
          statusStore.current().error ?? "Could not check AI Clients."
        );
      setScanned(true);
    } catch (cause) {
      setScanError(errorText(cause));
    } finally {
      setScanBusy(false);
    }
  };
  const chooseManual = () => {
    setAiMode("manual");
    setAiActions((current) => [...current, "I’ll add them myself"]);
  };
  const skipSetup = () => {
    if (connected.length === 0) {
      setSkipError(
        "I need at least one ready AI Client to do anything for you. Connect one, then you can skip the rest."
      );
      return;
    }
    setSkipError(null);
    setSkippedFrom(step === "intro" || step === "ai" ? step : "memory");
    setStep("summary");
  };
  const connect = async (id: ClientId) => {
    if (clientBusy) return;
    setClientConfirm(null);
    setClientBusy(id);
    const command = commandFor(id, status);
    try {
      const result = await statusStore.run<unknown>(
        command,
        command.startsWith("check_") ? undefined : { operatorConsented: true }
      );
      if (!operationOk(result))
        throw new Error("AI Client integration did not complete successfully.");
      const refreshed = await statusStore.refresh();
      const auth =
        result.authenticationState ??
        refreshed?.aiClients?.[id]?.authentication ??
        "unknown";
      const profileConfirmed =
        refreshed?.aiClients?.[id]?.profile.state === "healthy" ||
        (result.profileConfigured && configured(id, refreshed));
      if (!profileConfirmed)
        throw new Error(
          "Integration completed, but the client profile is not confirmed ready. Check sign-in and retry."
        );
      setClientResults((current) => ({
        ...current,
        [id]: {
          state:
            auth === "unauthenticated"
              ? "sign-in"
              : auth === "unknown"
                ? "unknown-auth"
                : "ready"
        }
      }));
    } catch (cause) {
      setClientResults((current) => ({
        ...current,
        [id]: { state: "failed", detail: errorText(cause) }
      }));
    } finally {
      setClientBusy(null);
    }
  };
  const runDemo = async (value: string) => {
    if (!onMemoryDemo || !value.trim() || demoBusy) return;
    setSubmittedNote(value.trim());
    setDemoBusy(true);
    setDemoError(null);
    setDemoResult(null);
    try {
      setDemoResult(await onMemoryDemo(value.trim()));
      setNote(value.trim());
    } catch (cause) {
      setDemoError(errorText(cause));
    } finally {
      setDemoBusy(false);
    }
  };
  const finish = async () => {
    if (completeBusy) return;
    setCompleteBusy(true);
    setCompleteError(null);
    try {
      await onComplete();
    } catch (cause) {
      setCompleteError(errorText(cause));
      setCompleteBusy(false);
    }
  };
  const submitText = () => {
    const text = composerText.trim();
    if (
      !text ||
      saveBusy ||
      demoBusy ||
      completeBusy ||
      setupConfirm ||
      clientConfirm
    )
      return;
    setComposerText("");
    if (/^skip\b/i.test(text)) {
      skipSetup();
      return;
    }
    if (/what.*koed|who are you|what are you/i.test(text)) {
      setIntroWhat(true);
      setWhatQuestion(text);
      return;
    }
    if (/^(yes|yeah|yep|ok|okay|sure|go|let'?s go|continue|y)\b/i.test(text)) {
      if (step === "intro") setStep("ai");
      else if (step === "ai") {
        if (aiMode === "intro") void scan();
        else setStep("memory");
      } else if (step === "memory") setStep("summary");
      else if (step === "summary" && connected.length > 0) void finish();
      else
        setGuidanceTurns((current) => [
          ...current,
          {
            user: text,
            reply:
              "Let’s finish setup first. Give your agent a name, or use the button above."
          }
        ]);
      return;
    }
    if (step === "maker") {
      const name = text
        .replace(
          /^(call (you|yourself)|your name is|you'?re|you are|name:?)\s+/i,
          ""
        )
        .replace(/[.!?"“”]/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(" ");
      if (name) void saveAgent(name.charAt(0).toUpperCase() + name.slice(1));
      return;
    }
    if (step === "memory") {
      if (onMemoryDemo) void runDemo(text);
      else
        setGuidanceTurns((current) => [
          ...current,
          {
            user: text,
            reply:
              "A live memory demo is unavailable here. You can finish setup and try recall later."
          }
        ]);
      return;
    }
    setGuidanceTurns((current) => [
      ...current,
      {
        user: text,
        reply:
          "Let’s finish setup first. Use a button above, or say “skip” once an AI Client is ready."
      }
    ]);
  };
  const stepNumber =
    step === "maker"
      ? 1
      : step === "intro" || step === "ai"
        ? 2
        : step === "memory"
          ? 3
          : 4;
  return (
    <main className="v1-ob">
      <div className="v1-ob-top">
        <div className="v1-ob-steps" aria-label="Setup progress">
          {["Your agent", "Your AI", "Memory"].map((label, index) => (
            <span
              className={
                stepNumber > index + 1
                  ? "is-done"
                  : stepNumber === index + 1
                    ? "is-current"
                    : ""
              }
              aria-current={stepNumber === index + 1 ? "step" : undefined}
              key={label}
            >
              <i>{stepNumber > index + 1 ? "✓" : index + 1}</i>
              {label}
            </span>
          ))}
        </div>
        {stepNumber >= 2 && stepNumber <= 3 && (
          <button type="button" className="v1-ob-skip" onClick={skipSetup}>
            Skip setup
          </button>
        )}
      </div>
      <div className="v1-ob-thread">
        {skipError && (
          <p role="alert" className="v1-ob-error">
            {skipError}
          </p>
        )}
        {draftError && (
          <p role="alert" className="v1-ob-error">
            Could not save setup progress: {draftError}
          </p>
        )}
        <div className="v1-ob-message">
          <Pixelkin look={agent.look} size={32} />
          <div>
            <p>{greeting}</p>
            <p>
              I’m your new agent, your chief of staff. I work on the AI you
              already use, and Koed remembers your work so you never start from
              zero.
            </p>
            <p>
              First, make me yours. What should I be called, and how should I
              look?
            </p>
          </div>
        </div>
        <div
          className={`v1-ob-card v1-ob-maker ${step !== "maker" ? "is-done" : ""}`}
        >
          <div className="v1-ob-preview">
            <Pixelkin look={agent.look} size={step === "maker" ? 112 : 40} />
            <strong>{agent.name || "Your agent"}</strong>
          </div>
          <div className="v1-ob-maker-controls">
            {step === "maker" ? (
              <>
                <label>
                  Name
                  <input
                    value={agent.name}
                    maxLength={24}
                    placeholder="Give me a name"
                    onChange={(event) =>
                      setAgent((a) => ({ ...a, name: event.target.value }))
                    }
                  />
                </label>
                <div className="v1-ob-suggestions">
                  {["Juno", "Atlas", "Pip", "Mika", "Orbit"].map((name) => (
                    <button
                      type="button"
                      key={name}
                      className="v1-ob-mini"
                      onClick={() => setAgent((a) => ({ ...a, name }))}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <AgentLookPicker
                  look={agent.look}
                  onChange={(look) => setAgent((a) => ({ ...a, look }))}
                />
                {nameError && (
                  <p role="alert" className="v1-ob-error">
                    {nameError}
                  </p>
                )}
                <button
                  type="button"
                  className="v1-ob-primary"
                  disabled={saveBusy}
                  onClick={() => void saveAgent()}
                >
                  {saveBusy ? "Saving…" : "That’s me"}
                </button>
              </>
            ) : (
              <p>Change my name or look any time in Settings.</p>
            )}
          </div>
        </div>
        {step !== "maker" && (
          <>
            <div className="v1-ob-user">I’ll call you {agent.name}.</div>
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>{agent.name} it is. Nice to meet you.</p>
                <p>While we talk, I’m getting Koed ready on this Mac.</p>
              </div>
            </div>
            <SetupProgress
              snapshot={setup}
              error={setupError}
              busy={setupBusy}
              onRun={() => setSetupConfirm(true)}
              onInspect={() => void inspectSetup()}
            />
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>Two quick things:</p>
                <p>
                  1. <strong>Your AI.</strong> Koed connects to AI Clients you
                  use.
                  <br />
                  2. <strong>Memory.</strong> What Koed can recall from your
                  work.
                </p>
              </div>
            </div>
          </>
        )}
        {step === "intro" && (
          <div className="v1-ob-actions">
            <button
              className="v1-ob-primary"
              type="button"
              onClick={() => setStep("ai")}
            >
              Let’s go
            </button>
            {!introWhat && (
              <button
                className="v1-ob-mini"
                type="button"
                onClick={() => {
                  setIntroWhat(true);
                  setWhatQuestion("What is Koed?");
                }}
              >
                What is Koed?
              </button>
            )}
          </div>
        )}
        {introWhat && (
          <>
            <div className="v1-ob-user">{whatQuestion ?? "What is Koed?"}</div>
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>
                  Koed is where you work with your agent. I run on your own AI
                  Clients, and Koed remembers your projects, decisions and
                  preferences, so every conversation can start with relevant
                  context.
                </p>
              </div>
            </div>
          </>
        )}
        {(step === "ai" ||
          step === "memory" ||
          (step === "summary" && skippedFrom !== "intro")) && (
          <>
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>
                  Koed doesn’t come with its own AI. It connects to the AI
                  Clients you already use: Claude Code, Codex and Pi. You pick a
                  model for each conversation.
                </p>
                <p>
                  Can I look for them on this Mac? I check what’s installed and
                  whether Koed can connect.
                </p>
              </div>
            </div>
            <div className="v1-ob-actions">
              <button
                className="v1-ob-mini"
                type="button"
                disabled={scanBusy || !!clientBusy}
                onClick={() => void scan()}
              >
                {scanBusy ? "Looking…" : "Look for them"}
              </button>
              <button
                className="v1-ob-mini"
                type="button"
                onClick={chooseManual}
              >
                I’ll add them myself
              </button>
            </div>
            {aiActions.map((action, index) => (
              <div className="v1-ob-user" key={`${index}:${action}`}>
                {action}
              </div>
            ))}
            {scanError && (
              <p role="alert" className="v1-ob-error">
                {scanError}
              </p>
            )}
            {aiMode !== "intro" && (
              <div className="v1-ob-card v1-ob-clients">
                {clients.map(({ id, label }) => {
                  const readiness = status?.aiClients?.[id];
                  const result = clientResults[id];
                  const installed = readiness?.installed.state === "healthy";
                  const healthy = readiness?.profile.state === "healthy";
                  const authenticated =
                    readiness?.authentication === "authenticated";
                  const state =
                    healthy && authenticated
                      ? "Ready"
                      : result?.state === "failed"
                        ? "Needs attention"
                        : result?.state === "sign-in" ||
                            (healthy &&
                              readiness?.authentication === "unauthenticated")
                          ? "Sign in required"
                          : result?.state === "unknown-auth" ||
                              (healthy &&
                                readiness?.authentication === "unknown")
                            ? "Check sign-in"
                            : result?.state === "ready" && !readiness
                              ? "Not checked"
                              : installed
                                ? "Installed"
                                : scanned
                                  ? "Not found"
                                  : "Not checked";
                  const guidance = clientAuthenticationGuidance(id, state);
                  return (
                    <div className="v1-ob-client" key={id}>
                      <div>
                        <strong>{label}</strong>
                        <small>
                          {readiness?.version
                            ? `Version ${readiness.version}`
                            : installed
                              ? "Installed"
                              : scanned
                                ? "Not installed"
                                : "Check availability"}
                        </small>
                        {result?.detail && (
                          <small className="v1-ob-error">{result.detail}</small>
                        )}
                        {guidance && <small>{guidance}</small>}
                      </div>
                      <span>{state}</span>
                      <button
                        type="button"
                        className="v1-ob-mini"
                        disabled={!!clientBusy || scanBusy}
                        onClick={() => setClientConfirm(id)}
                      >
                        {clientBusy === id
                          ? "Working…"
                          : healthy
                            ? "Check again"
                            : result?.state === "failed"
                              ? "Retry"
                              : "Connect"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {aiMode !== "intro" && (
              <div className="v1-ob-message">
                <Pixelkin look={agent.look} size={32} />
                <div>
                  <p>
                    {connected.length
                      ? `Connected ${connected.map((c) => c.label).join(", ")}. Add another, or carry on.`
                      : scanned
                        ? "I didn’t find a ready AI Client yet. Choose one above to configure it, or try again."
                        : "Pick the AI Clients you use. Koed will configure only the one you choose."}
                  </p>
                </div>
              </div>
            )}
            {step === "ai" && (
              <div className="v1-ob-actions">
                <button
                  className="v1-ob-primary"
                  type="button"
                  onClick={() => setStep("memory")}
                >
                  Next: memory
                </button>
              </div>
            )}
          </>
        )}
        {(step === "memory" ||
          (step === "summary" &&
            (skippedFrom === null || skippedFrom === "memory"))) && (
          <>
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>Now the part your AI subscription can’t do on its own.</p>
              </div>
            </div>
            <div className="v1-ob-card v1-ob-compare">
              <strong>Your AI on its own</strong>
              <strong>
                <Pixelkin look={agent.look} size={18} /> Your AI with Koed
              </strong>
              <span>Starts every conversation from zero</span>
              <span>Can recall relevant context from your captured work</span>
              <span>Each AI Client has its own context</span>
              <span>
                Personal Memory can be recalled through supported clients
              </span>
              <span>You re-explain prior decisions</span>
              <span>
                Koed returns evidence; your AI Client uses it to answer
              </span>
            </div>
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>Let me show you. Tell me one thing about how you work.</p>
              </div>
            </div>
            {submittedNote && <div className="v1-ob-user">{submittedNote}</div>}
            {step === "memory" && (
              <div className="v1-ob-card v1-ob-memory">
                <div className="v1-ob-suggestions">
                  {[
                    "Keep answers short",
                    "I build in Rust and Next.js",
                    "I’m in Madrid, so CET"
                  ].map((value) => (
                    <button
                      type="button"
                      className="v1-ob-mini"
                      key={value}
                      onClick={() => setNote(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <label>
                  Something to remember
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="For example, keep answers short"
                  />
                </label>
                {onMemoryDemo ? (
                  <button
                    type="button"
                    className="v1-ob-mini"
                    disabled={demoBusy || !note.trim()}
                    onClick={() => void runDemo(note)}
                  >
                    {demoBusy ? "Working…" : "Try memory"}
                  </button>
                ) : (
                  <p className="v1-ob-muted">
                    A live memory demo is unavailable here. You can try recall
                    after setup.
                  </p>
                )}
                {demoResult && (
                  <div role="status">
                    <strong>{demoResult.message}</strong>
                    {demoResult.evidence && (
                      <p>Saved note: {demoResult.evidence}</p>
                    )}
                  </div>
                )}
                {demoError && (
                  <p role="alert" className="v1-ob-error">
                    {demoError}
                  </p>
                )}
              </div>
            )}
            {step === "summary" && demoResult && (
              <div className="v1-ob-card v1-ob-memory" role="status">
                <strong>{demoResult.message}</strong>
                {demoResult.evidence && (
                  <p>Saved note: {demoResult.evidence}</p>
                )}
              </div>
            )}
            {step === "memory" && (
              <div className="v1-ob-actions">
                <button
                  type="button"
                  className="v1-ob-primary"
                  onClick={() => setStep("summary")}
                >
                  Finish setup
                </button>
              </div>
            )}
          </>
        )}
        {step === "summary" && (
          <>
            {skippedFrom && <div className="v1-ob-user">Skip setup</div>}
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>You’re set.</p>
              </div>
            </div>
            <div className="v1-ob-card v1-ob-summary">
              <div>
                <strong>Your agent</strong>
                <span>{agent.name}, your chief of staff</span>
              </div>
              <div>
                <strong>Your AI</strong>
                <span>
                  {connected.length
                    ? connected.map((c) => c.label).join(", ")
                    : "Connect an AI Client in Settings"}
                </span>
              </div>
              <div>
                <strong>Memory</strong>
                <span>
                  {demoResult
                    ? demoResult.message
                    : "Ready to use when an AI Client is connected"}
                </span>
              </div>
              <div>
                <strong>This Mac</strong>
                <span>
                  {prepared
                    ? "Ready"
                    : setup?.state === "failed"
                      ? "Setup needs attention"
                      : setup?.state === "running"
                        ? "Still getting ready in the background"
                        : "Setup is not complete"}
                </span>
              </div>
            </div>
            {completeError && (
              <p role="alert" className="v1-ob-error">
                {completeError}
              </p>
            )}
            <div className="v1-ob-actions">
              <button
                type="button"
                className="v1-ob-primary"
                disabled={completeBusy || connected.length === 0}
                onClick={() => void finish()}
              >
                {completeBusy ? "Saving…" : "Start using Koed"}
              </button>
              {connected.length === 0 && (
                <p className="v1-ob-muted">
                  Connect at least one ready AI Client to continue.
                </p>
              )}
            </div>
          </>
        )}
        {guidanceTurns.map((turn, index) => (
          <div key={index}>
            <div className="v1-ob-user">{turn.user}</div>
            <div className="v1-ob-message">
              <Pixelkin look={agent.look} size={32} />
              <div>
                <p>{turn.reply}</p>
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="v1-ob-dock">
        <V1Composer
          value={composerText}
          onChange={setComposerText}
          onSend={submitText}
          inputLabel="Message Koed during setup"
          placeholder={
            step === "maker"
              ? "Give me a name…"
              : step === "memory"
                ? "Tell me how you work…"
                : "Message your agent…"
          }
          disabled={setupConfirm || clientConfirm !== null || completeBusy}
        />
      </div>
      {setupConfirm && (
        <div
          className="v1-ob-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Set up Koed"
        >
          <div className="v1-ob-card">
            <h2>Set up Koed on this Mac?</h2>
            <p>
              Koed will prepare its runtime, start local services, and configure
              core integration. It may install local memory models. Completed
              steps are kept on retry.
            </p>
            <div className="v1-ob-actions">
              <button
                type="button"
                className="v1-ob-mini"
                onClick={() => setSetupConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v1-ob-primary"
                onClick={() => void runSetup()}
              >
                Set up Koed
              </button>
            </div>
          </div>
        </div>
      )}
      {clientConfirm && (
        <div
          className="v1-ob-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Connect AI Client"
        >
          <div className="v1-ob-card">
            <h2>
              {commandFor(clientConfirm, status).startsWith("check_")
                ? "Check"
                : "Configure"}{" "}
              {clients.find((c) => c.id === clientConfirm)?.label}?
            </h2>
            <p>
              Koed will{" "}
              {commandFor(clientConfirm, status).startsWith("check_")
                ? "check this AI Client’s integration and readiness."
                : "change this AI Client’s local configuration so it can use Koed. You may need to sign in to the client separately."}
            </p>
            <div className="v1-ob-actions">
              <button
                type="button"
                className="v1-ob-mini"
                onClick={() => setClientConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="v1-ob-primary"
                onClick={() => void connect(clientConfirm)}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
