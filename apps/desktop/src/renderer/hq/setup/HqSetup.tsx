import { Dialog, DialogPopup } from "@koed/ui";
import {
  AlertTriangle,
  Check,
  Circle,
  LoaderCircle,
  RefreshCw
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  DesktopSetupApi,
  DesktopSetupSnapshot,
  DesktopSetupStage,
  DesktopSetupStageId
} from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import "./hq-setup.css";

const stageCopy: Record<
  DesktopSetupStageId,
  { title: string; description: string }
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
    title: "Local models",
    description: "Download and verify the required local models."
  },
  services: {
    title: "Local services",
    description: "Start Personal Memory and background processing."
  },
  integration: {
    title: "Koed core integration",
    description: "Prepare local credential and MCP artifacts."
  },
  verification: {
    title: "Verification",
    description: "Confirm the complete local setup."
  }
};

const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const normalizedStages = (
  snapshot: DesktopSetupSnapshot
): DesktopSetupStage[] => {
  const prerequisitesComplete = snapshot.stages.every(
    ({ id, state }) => id === "verification" || state === "complete"
  );
  return snapshot.stages.map((stage) =>
    stage.id === "verification" &&
    stage.state === "complete" &&
    !prerequisitesComplete
      ? {
          ...stage,
          state: "pending",
          message:
            "Complete the preceding setup steps before final verification."
        }
      : stage
  );
};

const setupComplete = (snapshot: DesktopSetupSnapshot) =>
  snapshot.state === "complete" &&
  snapshot.stages.length === 6 &&
  (Object.keys(stageCopy) as DesktopSetupStageId[]).every((id) =>
    normalizedStages(snapshot).some(
      (stage) => stage.id === id && stage.state === "complete"
    )
  );

function StageRow({ stage }: { stage: DesktopSetupStage }) {
  const { title, description } = stageCopy[stage.id];
  const progress =
    stage.totalBytes !== null &&
    stage.totalBytes > 0 &&
    stage.completedBytes !== null
      ? Math.min(1, stage.completedBytes / stage.totalBytes)
      : null;
  return (
    <li className="hq-setup__stage" data-state={stage.state}>
      <span className="hq-setup__stage-icon" aria-hidden="true">
        {stage.state === "complete" ? (
          <Check />
        ) : stage.state === "running" ? (
          <LoaderCircle className="hq-setup__spin" />
        ) : stage.state === "failed" ? (
          <AlertTriangle />
        ) : (
          <Circle />
        )}
      </span>
      <span className="hq-setup__stage-copy">
        <strong>{title}</strong>
        <span>
          {stage.state === "running" ||
          stage.state === "failed" ||
          (stage.id === "verification" && stage.state === "pending")
            ? stage.message
            : description}
        </span>
        {stage.state === "running" &&
        stage.completedBytes !== null &&
        stage.totalBytes !== null ? (
          <small>
            {formatBytes(stage.completedBytes)} of{" "}
            {formatBytes(stage.totalBytes)}
          </small>
        ) : null}
      </span>
      <span className="hq-setup__stage-status">
        {stage.state === "complete"
          ? "Complete"
          : stage.state === "failed"
            ? "Needs attention"
            : progress !== null
              ? `${Math.round(progress * 100)}%`
              : stage.state === "running"
                ? "In progress"
                : "Pending"}
      </span>
    </li>
  );
}

export function HqSetup({
  onComplete,
  statusStore,
  setupApi = window.koedDesktop?.setup
}: {
  onComplete: () => Promise<void> | void;
  statusStore: DesktopStatusStore;
  setupApi?: DesktopSetupApi;
}) {
  const titleId = useId();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const ownedGeneration = ++generation.current;
    alive.current = true;
    busy.current = false;
    setPending(false);
    setSnapshot(null);
    setConfirmOpen(false);
    const isCurrent = () =>
      alive.current && generation.current === ownedGeneration;
    if (!setupApi) {
      setError("Desktop setup is unavailable.");
      return () => {
        alive.current = false;
        generation.current += 1;
      };
    }
    setError(null);
    let receivedProgress = false;
    const unsubscribe = setupApi.subscribe((next) => {
      if (isCurrent()) {
        receivedProgress = true;
        setSnapshot(next);
      }
    });
    void setupApi
      .inspect()
      .then(async (next) => {
        if (!isCurrent() || receivedProgress) return;
        setSnapshot(next);
        if (setupComplete(next)) await statusStore.refresh();
      })
      .catch((cause: unknown) => {
        if (isCurrent())
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive.current = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [setupApi, statusStore]);

  const inspect = async () => {
    if (!setupApi || busy.current) return;
    const ownedGeneration = generation.current;
    const isCurrent = () =>
      alive.current && generation.current === ownedGeneration;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await setupApi.inspect();
      if (!isCurrent()) return;
      setSnapshot(next);
      if (setupComplete(next)) await statusStore.refresh();
    } catch (cause) {
      if (isCurrent())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  const run = async () => {
    if (!setupApi || busy.current) return;
    const ownedGeneration = generation.current;
    const isCurrent = () =>
      alive.current && generation.current === ownedGeneration;
    busy.current = true;
    setConfirmOpen(false);
    setPending(true);
    setError(null);
    try {
      const result = await setupApi.run();
      if (!isCurrent()) return;
      setSnapshot(result);
      if (setupComplete(result)) await statusStore.refresh();
    } catch (cause) {
      if (isCurrent())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  const continueToKoed = async () => {
    if (!setupApi || busy.current) return;
    const ownedGeneration = generation.current;
    const isCurrent = () =>
      alive.current && generation.current === ownedGeneration;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const current = await setupApi.inspect();
      if (!isCurrent()) return;
      setSnapshot(current);
      if (!setupComplete(current)) {
        setError("Complete all local setup steps before continuing.");
        return;
      }
      await statusStore.refresh();
      if (isCurrent()) await onComplete();
    } catch (cause) {
      if (isCurrent())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  const stages = snapshot ? normalizedStages(snapshot) : [];
  const active = stages.find(({ state }) => state === "running");
  const progress = stages.length
    ? (stages.filter(({ state }) => state === "complete").length +
        (active && active.totalBytes && active.completedBytes
          ? Math.min(1, active.completedBytes / active.totalBytes)
          : 0)) /
      stages.length
    : 0;
  const running = snapshot?.state === "running" || pending;
  const complete = snapshot !== null && setupComplete(snapshot);

  return (
    <main
      className="hq-setup"
      data-hq-setup=""
      data-state={snapshot?.state ?? "checking"}
      aria-labelledby={titleId}
    >
      <div className="hq-setup__body" aria-busy={running}>
        <div className="hq-setup__eyebrow">Your Koed setup</div>
        <h1 id={titleId}>Set up Koed</h1>
        <p className="hq-setup__intro">
          Prepare Personal Memory and the local services on this computer.
        </p>
        <div className="hq-setup__toolbar">
          <span>{complete ? "Ready on this computer" : "Local setup"}</span>
          <button
            type="button"
            className="hq-setup__refresh"
            aria-label="Check setup again"
            disabled={running || !setupApi}
            onClick={() => void inspect()}
          >
            <RefreshCw aria-hidden="true" /> Check again
          </button>
        </div>
        {error || snapshot?.error ? (
          <p className="hq-setup__error" role="alert">
            {error ?? snapshot?.error}
          </p>
        ) : null}
        {snapshot ? (
          <>
            <div
              className="hq-setup__progress"
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <span style={{ width: `${progress * 100}%` }} />
            </div>
            <ol className="hq-setup__stages">
              {stages.map((stage) => (
                <StageRow key={stage.id} stage={stage} />
              ))}
            </ol>
            <div className="hq-setup__actions">
              {complete ? (
                <button
                  type="button"
                  className="hq-setup__primary"
                  disabled={running}
                  onClick={() => void continueToKoed()}
                >
                  Continue to Koed
                </button>
              ) : (
                <button
                  type="button"
                  className="hq-setup__primary"
                  disabled={running}
                  onClick={() => setConfirmOpen(true)}
                >
                  {snapshot.state === "failed" ? "Retry setup" : "Set up Koed"}
                </button>
              )}
            </div>
          </>
        ) : error ? null : (
          <p className="hq-setup__loading" role="status">
            <LoaderCircle className="hq-setup__spin" aria-hidden="true" />{" "}
            Checking local setup…
          </p>
        )}
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogPopup
          ref={dialogRef}
          initialFocus={dialogRef}
          className="hq-setup__dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogDescriptionId}
          showCloseButton={false}
        >
          <h2 id={dialogTitleId}>Set up Koed on this computer?</h2>
          <p id={dialogDescriptionId}>
            Koed will prepare the local runtime, download and verify required
            models, start local services, and prepare core integration
            artifacts. Existing completed steps stay in place. AI Client setup
            remains a separate choice.
          </p>
          <div className="hq-setup__dialog-actions">
            <button type="button" onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="hq-setup__primary"
              onClick={() => void run()}
            >
              Set up Koed
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    </main>
  );
}
