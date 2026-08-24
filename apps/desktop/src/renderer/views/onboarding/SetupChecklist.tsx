import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Spinner
} from "@koed/ui";
import { AlertTriangle, Check, Circle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DesktopSetupSnapshot,
  DesktopSetupStage,
  DesktopSetupStageId,
  KoedServerStatus
} from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { useDesktopStatus } from "../../state/use-status.js";
import { compactHealthSummary } from "./setup-model.js";
import { TrustBoundaryGuide } from "./TrustBoundaryGuide.js";
import "./onboarding.css";

const stageCopy: Record<
  DesktopSetupStageId,
  { description: string; title: string }
> = {
  package: {
    title: "Koed package",
    description: "Prepare the local Koed service."
  },
  runtime: {
    title: "Local runtime",
    description: "Prepare storage and embedding dependencies."
  },
  model: {
    title: "Embedding model",
    description: "Download and verify the local model."
  },
  services: {
    title: "Local services",
    description: "Start Personal Memory and background processing."
  },
  integration: {
    title: "Koed core integration",
    description:
      "Prepare local credential and MCP artifacts. AI Client setup is optional."
  },
  verification: {
    title: "Verification",
    description: "Confirm the complete local setup."
  }
};

const formatBytes = (value: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let index = 0;
  while (amount >= 1_024 && index < units.length - 1) {
    amount /= 1_024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const stageProgress = (stage: DesktopSetupStage): number | null =>
  stage.completedBytes !== null &&
  stage.totalBytes !== null &&
  stage.totalBytes > 0
    ? Math.min(1, stage.completedBytes / stage.totalBytes)
    : null;

const overallProgress = (snapshot: DesktopSetupSnapshot): number => {
  const completed = snapshot.stages.filter(
    ({ state }) => state === "complete"
  ).length;
  const active = snapshot.stages.find(({ state }) => state === "running");
  return (
    (completed + (active ? (stageProgress(active) ?? 0) : 0)) /
    snapshot.stages.length
  );
};

function SetupStageRow({ stage }: { stage: DesktopSetupStage }) {
  const copy = stageCopy[stage.id];
  const progress = stageProgress(stage);
  return (
    <li className="koed-setup-step" data-state={stage.state}>
      <span className="koed-setup-state">
        {stage.state === "complete" ? (
          <Check aria-label="Complete" />
        ) : stage.state === "running" ? (
          <Spinner aria-label="In progress" />
        ) : stage.state === "failed" ? (
          <AlertTriangle aria-label="Failed" />
        ) : (
          <Circle aria-label="Pending" />
        )}
      </span>
      <span className="koed-setup-step-copy">
        <strong>{copy.title}</strong>
        <span>
          {stage.state === "running" || stage.state === "failed"
            ? stage.message
            : copy.description}
        </span>
        {stage.id === "integration" && stage.detectedAiClients?.length ? (
          <span className="koed-setup-clients" aria-label="Detected AI Clients">
            {stage.detectedAiClients.map((client) => (
              <span key={client}>{client} detected</span>
            ))}
          </span>
        ) : null}
        {stage.state === "running" &&
        stage.completedBytes !== null &&
        stage.totalBytes !== null ? (
          <span className="koed-setup-download">
            {formatBytes(stage.completedBytes)} of{" "}
            {formatBytes(stage.totalBytes)}
          </span>
        ) : null}
      </span>
      {stage.state === "complete" ? (
        <span className="koed-setup-complete">Complete</span>
      ) : progress !== null ? (
        <span className="koed-setup-percent">
          {Math.round(progress * 100)}%
        </span>
      ) : null}
    </li>
  );
}

export type SetupChecklistProps = {
  onComplete: () => Promise<void> | void;
  showTrustGuide?: boolean;
  statusStore: DesktopStatusStore;
};

export function SetupChecklist({
  onComplete,
  showTrustGuide = true,
  statusStore
}: SetupChecklistProps) {
  const setupApi = window.koedDesktop?.setup;
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showAiClients, setShowAiClients] = useState(false);
  const [showTrust, setShowTrust] = useState(false);

  const inspect = async () => {
    if (!setupApi) {
      setError("Desktop setup is unavailable.");
      return;
    }
    setError(null);
    try {
      const next = await setupApi.inspect();
      setSnapshot(next);
      if (next.state === "complete") {
        await statusStore.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!setupApi) {
      setError("Desktop setup is unavailable.");
      return;
    }
    const unsubscribe = setupApi.subscribe(setSnapshot);
    void inspect();
    return unsubscribe;
  }, [setupApi]);

  const completeOnboarding = useCallback(async () => {
    setError(null);
    try {
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onComplete]);

  const continueAfterCore = useCallback(() => {
    setShowAiClients(true);
  }, [completeOnboarding, showTrustGuide, statusStore]);

  const finishAiClientSetup = useCallback(() => {
    setShowAiClients(false);
    if (showTrustGuide) setShowTrust(true);
    else void completeOnboarding();
  }, [completeOnboarding, showTrustGuide]);

  const run = async () => {
    if (!setupApi) return;
    setConfirmOpen(false);
    setError(null);
    try {
      const result = await setupApi.run();
      setSnapshot(result);
      if (result.state === "complete") {
        await statusStore.refresh();
        continueAfterCore();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const progress = useMemo(
    () => (snapshot ? overallProgress(snapshot) : 0),
    [snapshot]
  );
  const running = snapshot?.state === "running";
  const complete = snapshot?.state === "complete";
  const failed = snapshot?.state === "failed";

  if (showTrust) {
    return <TrustBoundaryGuide onComplete={onComplete} />;
  }

  if (showAiClients) {
    return (
      <AiClientSetup
        onComplete={finishAiClientSetup}
        statusStore={statusStore}
      />
    );
  }

  return (
    <main className="koed-onboarding">
      <section
        aria-busy={running}
        aria-labelledby="koed-setup-title"
        className="koed-setup-card"
      >
        <header className="koed-setup-header">
          <div>
            <h1 id="koed-setup-title">Set up Koed</h1>
            <p>
              Koed will prepare Personal Memory and local core services.
              Detected AI Client setup remains optional.
            </p>
          </div>
          {!running ? (
            <Button
              aria-label="Check setup again"
              onClick={() => void inspect()}
              size="icon"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          ) : null}
        </header>

        {error || snapshot?.error ? (
          <p className="koed-setup-error" role="alert">
            {error ?? snapshot?.error}
          </p>
        ) : null}

        {!snapshot ? (
          <div className="koed-setup-loading" role="status">
            <Spinner aria-hidden="true" /> Checking local setup…
          </div>
        ) : (
          <>
            <div
              aria-label={`${Math.round(progress * 100)}% complete`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(progress * 100)}
              className="koed-setup-progress"
              role="progressbar"
            >
              <span style={{ inlineSize: `${progress * 100}%` }} />
            </div>
            <ol className="koed-setup-list">
              {snapshot.stages.map((stage) => (
                <SetupStageRow key={stage.id} stage={stage} />
              ))}
            </ol>
            <footer className="koed-setup-footer">
              <span aria-live="polite">
                {running
                  ? snapshot.stages.find(({ state }) => state === "running")
                      ?.message
                  : complete
                    ? "Koed is ready"
                    : failed
                      ? "Setup stopped"
                      : "Ready to set up"}
              </span>
              {complete ? (
                <Button
                  onClick={() => {
                    continueAfterCore();
                  }}
                >
                  Continue
                </Button>
              ) : (
                <Button disabled={running} onClick={() => setConfirmOpen(true)}>
                  {failed ? "Retry setup" : "Set up Koed"}
                </Button>
              )}
            </footer>
          </>
        )}
      </section>

      <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Set up Koed on this computer?</DialogTitle>
            <DialogDescription>
              Koed will install or link its local runtime, download and verify
              the embedding model, start local services, and prepare Koed core
              artifacts. Detected AI Client setup remains optional. Existing
              completed steps will be left alone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button onClick={() => void run()}>Set up Koed</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </main>
  );
}

type OnboardingClientId = "codex" | "claude" | "pi";
type AiClientSetupResultState = "configured" | "ready" | "skipped" | "failed";
type AiClientSetupResult = {
  state: AiClientSetupResultState;
  error?: string;
};

const onboardingClients: readonly {
  id: OnboardingClientId;
  label: string;
}[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "pi", label: "Pi" }
];

const clientCommand = (
  id: OnboardingClientId,
  status: KoedServerStatus | null
):
  | "check_codex"
  | "setup_codex"
  | "repair_codex"
  | "check_claude"
  | "setup_claude"
  | "repair_claude"
  | "check_pi"
  | "setup_pi"
  | "repair_pi" => {
  if (status?.aiClients?.[id]?.profile.state === "healthy") {
    return `check_${id}` as "check_codex" | "check_claude" | "check_pi";
  }
  const configured =
    status?.aiClients?.[id]?.profile.state === "needs_attention";
  if (id === "codex") return configured ? "repair_codex" : "setup_codex";
  if (id === "claude") return configured ? "repair_claude" : "setup_claude";
  return configured ? "repair_pi" : "setup_pi";
};

const resultIsOk = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  (value as { ok?: unknown }).ok === true;

const resultError = (value: unknown, fallback: string): string => {
  if (!value || typeof value !== "object") return fallback;
  const details = value as {
    action?: unknown;
    error?: unknown;
    message?: unknown;
  };
  return (
    [details.message, details.error, details.action].find(
      (item): item is string => typeof item === "string" && item.length > 0
    ) ?? fallback
  );
};

function AiClientSetup({
  onComplete,
  statusStore
}: {
  onComplete: () => void;
  statusStore: DesktopStatusStore;
}) {
  const { status, busyCommand } = useDesktopStatus(statusStore);
  const [selected, setSelected] = useState<Set<OnboardingClientId>>(
    () => new Set()
  );
  const [queue, setQueue] = useState<OnboardingClientId[]>([]);
  const [activeClient, setActiveClient] = useState<OnboardingClientId | null>(
    null
  );
  const [consentOpen, setConsentOpen] = useState(false);
  const [results, setResults] = useState<
    Partial<Record<OnboardingClientId, AiClientSetupResult>>
  >({});
  const resultSummaryRef = useRef<HTMLUListElement>(null);
  const programmaticClose = useRef(false);
  const confirming = useRef(false);

  const toggle = useCallback((id: OnboardingClientId) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const finish = useCallback(() => {
    if (busyCommand || activeClient !== null || queue.length > 0) return;
    setConsentOpen(false);
    onComplete();
  }, [activeClient, busyCommand, onComplete, queue.length]);

  useEffect(() => {
    if (
      activeClient === null &&
      queue.length === 0 &&
      Object.keys(results).length > 0
    ) {
      resultSummaryRef.current?.focus();
    }
  }, [activeClient, queue.length, results]);

  const begin = useCallback(() => {
    if (busyCommand || activeClient) return;
    const next = onboardingClients
      .map(({ id }) => id)
      .filter((id) => selected.has(id));
    if (next.length === 0) {
      finish();
      return;
    }
    setQueue(next);
    setActiveClient(next[0] ?? null);
    setConsentOpen(true);
  }, [activeClient, busyCommand, finish, selected]);

  const completeCurrent = useCallback(
    (id: OnboardingClientId, result: AiClientSetupResult) => {
      setResults((current) => ({ ...current, [id]: result }));
      const remaining = queue.slice(1);
      setQueue(remaining);
      const next = remaining[0];
      if (!next) {
        setActiveClient(null);
        setConsentOpen(false);
        return;
      }
      setActiveClient(next);
      setConsentOpen(true);
    },
    [finish, queue]
  );

  const confirm = useCallback(async () => {
    if (!activeClient || confirming.current) return;
    confirming.current = true;
    const id = activeClient;
    programmaticClose.current = true;
    setConsentOpen(false);
    const command = clientCommand(id, status);
    try {
      const operationResult = await statusStore.run<unknown>(
        command,
        command.startsWith("check_") ? undefined : { operatorConsented: true }
      );
      if (!resultIsOk(operationResult)) {
        throw new Error(
          resultError(
            operationResult,
            command.startsWith("check_")
              ? "AI Client check did not report healthy readiness."
              : "AI Client integration operation did not complete successfully."
          )
        );
      }
      if (command.startsWith("check_")) {
        completeCurrent(id, { state: "ready" });
      } else {
        const refreshedStatus = await statusStore.refresh();
        if (refreshedStatus?.aiClients?.[id]?.profile.state !== "healthy") {
          throw new Error(
            `${onboardingClients.find((client) => client.id === id)?.label ?? "AI Client"} integration was configured, but its profile was not confirmed healthy. Refresh status and retry.`
          );
        }
        completeCurrent(id, { state: "configured" });
      }
    } catch (cause) {
      completeCurrent(id, {
        state: "failed",
        error: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      programmaticClose.current = false;
      confirming.current = false;
    }
  }, [activeClient, completeCurrent, status, statusStore]);

  const cancelCurrent = useCallback(() => {
    if (!activeClient) return;
    programmaticClose.current = true;
    setConsentOpen(false);
    completeCurrent(activeClient, { state: "skipped" });
    programmaticClose.current = false;
  }, [activeClient, completeCurrent]);

  return (
    <main className="koed-onboarding">
      <section
        aria-labelledby="koed-client-setup-title"
        className="koed-setup-card"
      >
        <header className="koed-setup-header">
          <div>
            <h1 id="koed-client-setup-title">Connect AI Clients</h1>
            <p>
              Core Koed setup is complete. Choose clients independently.
              Detection only reports availability; Koed never selects one for
              you.
            </p>
          </div>
        </header>
        <fieldset
          aria-describedby="koed-client-setup-description"
          className="koed-client-fieldset"
          disabled={busyCommand !== null || activeClient !== null}
        >
          <legend id="koed-client-setup-description">
            Select AI Clients to set up or verify
          </legend>
          <div aria-label="AI Client choices" className="koed-client-grid">
            {onboardingClients.map(({ id, label }) => {
              const readiness = status?.aiClients?.[id];
              const detected = readiness?.installed.state === "healthy";
              const capabilitySummaries =
                readiness?.capabilities
                  .filter(
                    (capability) =>
                      capability.readiness !== "unknown" ||
                      [
                        "automatic_capture",
                        "mcp_recall",
                        "local_synthesis"
                      ].includes(capability.id)
                  )
                  .slice(0, 5) ?? [];
              return (
                <label
                  className="koed-client-card"
                  data-selected={selected.has(id)}
                  key={id}
                >
                  <input
                    checked={selected.has(id)}
                    onChange={() => toggle(id)}
                    type="checkbox"
                  />
                  <strong>{label}</strong>
                  <span>{detected ? "Available" : "Not detected"}</span>
                  <span>
                    Installed: {detected ? "Available" : "Unavailable"}
                  </span>
                  <span>Version: {readiness?.version ?? "Unknown"}</span>
                  <span>
                    Auth:{" "}
                    {readiness?.authentication === "authenticated"
                      ? "Authenticated"
                      : readiness?.authentication === "unauthenticated"
                        ? "Unauthenticated"
                        : "Unknown"}
                  </span>
                  {capabilitySummaries.map((capability) => (
                    <span key={capability.id}>
                      {capability.id === "automatic_capture"
                        ? "Automatic capture"
                        : capability.id === "mcp_recall"
                          ? "MCP Recall"
                          : capability.id === "local_synthesis"
                            ? "Local Synthesis"
                            : "Managed Conversation"}
                      :{" "}
                      {capability.support === "unsupported"
                        ? "Unsupported"
                        : capability.readiness === "ready"
                          ? "Ready"
                          : capability.readiness === "unknown"
                            ? "Unknown"
                            : "Needs setup"}
                    </span>
                  ))}
                </label>
              );
            })}
          </div>
        </fieldset>
        {Object.keys(results).length > 0 ? (
          <ul
            aria-atomic="true"
            aria-label="AI Client setup results"
            aria-live="polite"
            className="koed-setup-results"
            ref={resultSummaryRef}
            tabIndex={-1}
          >
            {Object.entries(results).map(([id, result]) => (
              <li key={id}>
                {onboardingClients.find((client) => client.id === id)?.label}:{" "}
                {result?.state}
                {result?.error ? ` — ${result.error}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {busyCommand ? (
          <p role="status">Setting up or checking selected AI Client…</p>
        ) : null}
        <footer className="koed-setup-footer">
          <Button
            disabled={
              busyCommand !== null || activeClient !== null || queue.length > 0
            }
            onClick={finish}
            variant="outline"
          >
            Set up later
          </Button>
          {Object.keys(results).length > 0 && !activeClient ? (
            <Button disabled={busyCommand !== null} onClick={finish}>
              Finish
            </Button>
          ) : (
            <Button
              disabled={
                busyCommand !== null ||
                activeClient !== null ||
                selected.size === 0
              }
              onClick={begin}
            >
              Continue
            </Button>
          )}
        </footer>
      </section>
      <Dialog
        onOpenChange={(open) => {
          if (!open && !programmaticClose.current) cancelCurrent();
        }}
        open={consentOpen}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {status?.aiClients?.[activeClient ?? "codex"]?.profile.state ===
              "healthy"
                ? "Verify"
                : "Set up"}{" "}
              {
                onboardingClients.find((client) => client.id === activeClient)
                  ?.label
              }
              ?
            </DialogTitle>
            <DialogDescription>
              Koed will change only its own integration block and package for
              this AI Client. Existing profile settings, credentials, and other
              clients remain untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={busyCommand !== null}
              onClick={() => void confirm()}
            >
              {status?.aiClients?.[activeClient ?? "codex"]?.profile.state ===
              "healthy"
                ? "Check integration"
                : "Allow and set up"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </main>
  );
}

export type CompactHealthAffordanceProps = {
  onOpenSetup: () => void;
  statusStore: DesktopStatusStore;
};

export function CompactHealthAffordance({
  onOpenSetup,
  statusStore
}: CompactHealthAffordanceProps) {
  const snapshot = useDesktopStatus(statusStore);
  const summary = compactHealthSummary(snapshot.status);

  if (summary.state === "healthy") return null;
  return (
    <button
      className="koed-health-affordance"
      data-state={summary.state}
      onClick={onOpenSetup}
      type="button"
    >
      {summary.state === "checking" || summary.state === "starting" ? (
        <Spinner aria-hidden="true" />
      ) : (
        <AlertTriangle aria-hidden="true" />
      )}
      <span>{summary.label}</span>
    </button>
  );
}
