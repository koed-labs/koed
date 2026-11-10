import { useEffect, useRef, useState } from "react";
import {
  Check,
  Cpu,
  Download,
  HardDrive,
  Monitor,
  RotateCcw,
  Zap
} from "lucide-react";
import type { AccelerationChoice } from "@koed-labs/server";
import { useAcceleration } from "../use-acceleration.js";
import { accelerationDiskRequirement } from "../acceleration-copy.js";
import { Arrow } from "./ClientSetup.js";
import "./hardware-step.css";

export function ProcessingReadiness() {
  const { snapshot, error, available } = useAcceleration();
  const embedding = snapshot?.embedding;
  if (available && !error && (!snapshot || embedding?.state === "starting"))
    return null;
  const detail =
    !available || error
      ? "The active backend could not be checked. Check Hardware Acceleration in Settings."
      : embedding?.state === "ready"
        ? `Using ${embedding.backend?.toUpperCase()}${embedding.fallbackReason ? " · CPU fallback" : ""}.`
        : embedding?.state === "stopped"
          ? "Embedding services are stopped."
          : "The active embedding backend is unavailable. Check Hardware Acceleration in Settings.";
  return (
    <p className="lp-live-detail" role="status">
      {snapshot && <>{snapshot.model.label} · </>}
      {detail}
    </p>
  );
}

export function SetupAccelerationActions({
  failed,
  onCpu
}: {
  failed: boolean;
  onCpu: (choice: AccelerationChoice) => void;
}) {
  const status = useAcceleration();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = async () => {
    setChecking(true);
    setError(null);
    try {
      const current = await status.inspect(true);
      if (!current?.snapshot)
        throw new Error(
          "Check the current processing configuration before continuing."
        );
      if (current.snapshot.readOnlyReason)
        throw new Error(current.snapshot.readOnlyReason);
      onCpu({
        preference: "cpu",
        installCuda: false,
        expectedRevision: current.snapshot.revision
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "CPU recovery could not start."
      );
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      {failed ? (
        <button
          type="button"
          className="lp-primary-button lp-next-button"
          disabled={checking || status.busy || !status.available}
          onClick={() => void recover()}
        >
          Continue with CPU <Arrow />
        </button>
      ) : (
        status.operation?.cancellable && (
          <button
            type="button"
            className="lp-text-button"
            onClick={() => void status.cancel()}
          >
            Cancel CUDA setup
          </button>
        )
      )}
      {(error || status.error) && (
        <p className="lp-error" role="alert">
          {error ?? status.error}
        </p>
      )}
    </>
  );
}

export function HardwareStep({
  draft,
  onChoice,
  onContinue,
  onBack
}: {
  draft?: AccelerationChoice;
  onChoice: (choice: AccelerationChoice) => void;
  onContinue: (choice?: AccelerationChoice) => void;
  onBack: () => void;
}) {
  const status = useAcceleration();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const { snapshot } = status;
  const hardware = snapshot?.hardware;
  const gpu = hardware?.backend;
  const gpuLabel =
    gpu === "metal"
      ? "Metal acceleration"
      : gpu === "cuda"
        ? "CUDA acceleration"
        : "Automatic processing";
  const installed =
    snapshot && ["installed", "outdated"].includes(snapshot.cuda.state);
  const gpuAvailable =
    hardware?.state === "available" &&
    (gpu === "metal" ||
      installed ||
      (gpu === "cuda" && snapshot?.cuda.canInstall));
  const readOnly = !!snapshot?.readOnlyReason;
  const managed =
    snapshot?.source === "environment" || snapshot?.source === "external";
  const choice: AccelerationChoice | undefined = snapshot
    ? draft?.expectedRevision === snapshot.revision
      ? draft
      : {
          preference:
            snapshot.source === "saved"
              ? snapshot.preference
              : snapshot.recommendedPreference === "auto" &&
                  gpuAvailable &&
                  (snapshot.source !== "default" || gpu !== "cuda" || installed)
                ? "auto"
                : "cpu",
          installCuda:
            snapshot.source === "saved" &&
            snapshot.preference === "auto" &&
            gpu === "cuda" &&
            !installed &&
            !!snapshot.cuda.canInstall,
          expectedRevision: snapshot.revision
        }
    : undefined;
  const busy = status.busy;
  const bytes = snapshot?.cuda.downloadBytes;
  const download =
    bytes === null || bytes === undefined
      ? "Download size unavailable"
      : `${Math.ceil(bytes / 1_048_576).toLocaleString()} MB`;
  const disabled = busy || readOnly || !snapshot;
  return (
    <div className="lp-client-panel lp-hardware-panel">
      <p className="lp-hardware-eyebrow">Make yourself at home</p>
      <h1 ref={heading} tabIndex={-1}>
        A little help from
        <br />
        your hardware.
      </h1>
      <p className="lp-client-intro">
        Choose how Koed processes memories on this device.
        <br />
        The model stays the same, whichever you choose.
      </p>
      <div className="lp-hardware-device" role="status">
        <Monitor aria-hidden="true" />
        <div>
          <strong>{hardware?.name ?? "Checking your device…"}</strong>
          <small>
            {hardware?.memoryBytes
              ? `${Math.round(hardware.memoryBytes / 1_073_741_824)} GB graphics memory`
              : (hardware?.reason ?? "Detecting available processing options.")}
          </small>
        </div>
        {hardware?.state === "available" && (
          <Check className="lp-hardware-detected" aria-label="Detected" />
        )}
      </div>
      <fieldset
        className="lp-client-list lp-hardware-options"
        disabled={disabled}
      >
        <legend className="lp-sr-only">Embedding processing</legend>
        <label
          className={`lp-client-card lp-hardware-option ${choice?.preference === "cpu" ? "is-selected" : ""}`}
        >
          <Cpu aria-hidden="true" />
          <span>
            <strong>CPU processing</strong>
            <span>A dependable start on any supported device.</span>
            <small>Included · no extra download</small>
          </span>
          <input
            type="radio"
            name="embedding-processing"
            value="cpu"
            checked={choice?.preference === "cpu"}
            onChange={() =>
              choice &&
              onChoice({ ...choice, preference: "cpu", installCuda: false })
            }
          />
        </label>
        {(gpu || choice?.preference === "auto") && (
          <label
            className={`lp-client-card lp-hardware-option ${choice?.preference === "auto" ? "is-selected" : ""} ${!gpuAvailable ? "is-locked" : ""}`}
          >
            <Zap aria-hidden="true" />
            <span>
              <strong>{gpuLabel}</strong>
              <span>
                {gpu === "metal"
                  ? "Use your Apple GPU for local embeddings."
                  : gpu === "cuda"
                    ? "Use your NVIDIA GPU for local embeddings."
                    : "Use an available GPU, with CPU fallback."}
              </span>
              <small>
                {!gpu ? (
                  "Your saved processing preference"
                ) : gpu === "metal" ? (
                  "Included · no extra download"
                ) : installed ? (
                  snapshot.cuda.state === "outdated" ? (
                    "Compatible CUDA runtime installed · update available"
                  ) : (
                    "CUDA runtime installed"
                  )
                ) : (
                  <>
                    <Download aria-hidden="true" /> Additional download ·{" "}
                    {download}
                  </>
                )}
              </small>
              {gpu === "cuda" && !installed && snapshot && (
                <small>{accelerationDiskRequirement(snapshot.cuda)}</small>
              )}
            </span>
            <input
              type="radio"
              name="embedding-processing"
              value="auto"
              disabled={!gpuAvailable}
              checked={choice?.preference === "auto"}
              onChange={() =>
                choice &&
                onChoice({
                  ...choice,
                  preference: "auto",
                  installCuda: gpu === "cuda" && !installed
                })
              }
            />
          </label>
        )}
      </fieldset>
      <div className="lp-hardware-model">
        <HardDrive aria-hidden="true" />
        <div>
          <small>Embedding model</small>
          <strong>
            {snapshot?.model.label ?? "Checking the embedding model…"}
          </strong>
          <small>Turns your memories into searchable connections.</small>
        </div>
      </div>
      {snapshot?.embedding.state === "ready" && (
        <p className="lp-hardware-note" role="status">
          Currently using {snapshot.embedding.backend?.toUpperCase()}
          {snapshot.embedding.fallbackReason ? " · CPU fallback" : ""}.
        </p>
      )}
      <p className="lp-hardware-note">
        {snapshot?.readOnlyReason ??
          (hardware && hardware.state !== "available"
            ? hardware.reason
            : gpu === "cuda" && !gpuAvailable
              ? snapshot?.cuda.reason
              : "Koed will use CPU if GPU acceleration becomes unavailable. You can change this in Settings.")}
      </p>
      {managed && (
        <p className="lp-hardware-note">
          Effective setting: {snapshot.effectivePolicy.toUpperCase()}. Continue
          keeps the Operator’s configuration.
        </p>
      )}
      {draft && snapshot && draft.expectedRevision !== snapshot.revision && (
        <p className="lp-hardware-note" role="status">
          Your device or configuration changed. Review the current choice before
          continuing.
        </p>
      )}
      {status.operation?.state === "interrupted" && (
        <p className="lp-hardware-note" role="status">
          {status.operation.message}
        </p>
      )}
      {(!status.available || status.error) && (
        <p className="lp-error" role="alert">
          {status.error ??
            "Device detection is unavailable. Reopen Koed and try again."}
        </p>
      )}
      <div className="lp-client-actions">
        <button
          type="button"
          className="lp-text-button"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="lp-text-button lp-hardware-recheck"
          disabled={busy || !status.available}
          onClick={() => void status.inspect(true)}
        >
          <RotateCcw aria-hidden="true" /> Check again
        </button>
        <button
          type="button"
          className="lp-primary-button"
          disabled={
            !snapshot ||
            busy ||
            (readOnly && !managed) ||
            (choice?.preference === "auto" &&
              !gpuAvailable &&
              !managed &&
              snapshot.preference !== "auto")
          }
          onClick={() => onContinue(readOnly ? undefined : choice)}
        >
          Continue <Arrow />
        </button>
      </div>
    </div>
  );
}
