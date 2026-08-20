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
import { useEffect, useMemo, useState } from "react";

import type {
  DesktopSetupSnapshot,
  DesktopSetupStage,
  DesktopSetupStageId
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
    title: "AI Client integrations",
    description: "Configure capture and recall for each detected AI Client."
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

const formatClientList = (clients: readonly string[]): string =>
  clients.length < 2
    ? (clients[0] ?? "detected AI Clients")
    : clients.length === 2
      ? clients.join(" and ")
      : `${clients.slice(0, -1).join(", ")}, and ${clients.at(-1)}`;

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

  const completeOnboarding = async () => {
    setError(null);
    try {
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const run = async () => {
    if (!setupApi) return;
    setConfirmOpen(false);
    setError(null);
    try {
      const result = await setupApi.run();
      setSnapshot(result);
      if (result.state === "complete") {
        await statusStore.refresh();
        if (showTrustGuide) setShowTrust(true);
        else await completeOnboarding();
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
              Koed will prepare Personal Memory and connect your detected AI
              Clients.
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
                    if (showTrustGuide) setShowTrust(true);
                    else void completeOnboarding();
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
              the embedding model, start local services, and configure
              {snapshot?.stages.find(({ id }) => id === "integration")
                ?.detectedAiClients?.length
                ? ` ${formatClientList(
                    snapshot.stages.find(({ id }) => id === "integration")!
                      .detectedAiClients!
                  )}`
                : " detected AI Clients"}
              . Existing completed steps will be left alone.
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
