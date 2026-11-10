import { useEffect, useRef, useState } from "react";
import { Download, HardDrive, ShieldCheck } from "lucide-react";
import {
  Button,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from "@koed/ui";
import type {
  AccelerationPreference,
  DesktopAccelerationApi
} from "@koed-labs/server";
import { Group, Row } from "./settings-controls.js";
import { useAcceleration } from "./use-acceleration.js";
import {
  accelerationDiskRequirement,
  accelerationErrorMessage
} from "./acceleration-copy.js";
import "./acceleration-settings.css";

const fallbackMessage =
  "Your GPU is unavailable. CPU keeps your memories searchable.";
const backendLabel = (backend: string) =>
  backend === "metal" ? "Metal" : backend.toUpperCase();
const providerLabel = (provider: string | null) =>
  provider === "coreml"
    ? "Core ML"
    : (provider?.toUpperCase() ?? "Unavailable");

export function AccelerationSettings({
  api
}: {
  api?: DesktopAccelerationApi;
}) {
  const portal = useRef<HTMLDivElement>(null);
  const acceleration = useAcceleration(api);
  const { snapshot, operation, busy } = acceleration;
  const [choice, setChoice] = useState<AccelerationPreference>("cpu");
  useEffect(() => {
    if (snapshot) setChoice(snapshot.preference);
  }, [snapshot?.revision]);
  const gpu = snapshot?.hardware.backend;
  const cudaInstalled =
    snapshot && ["installed", "outdated"].includes(snapshot.cuda.state);
  const needsCuda = gpu === "cuda" && !cudaInstalled;
  const canUseGpu =
    snapshot?.hardware.state === "available" &&
    !!gpu &&
    (!needsCuda || snapshot.cuda.canInstall);
  const installCuda = choice === "auto" && needsCuda;
  const changed = !!snapshot && choice !== snapshot.preference;
  const readOnly = !snapshot || !!snapshot.readOnlyReason || busy;
  const canApply =
    !readOnly && (changed || installCuda) && (choice === "cpu" || canUseGpu);
  const fallback =
    !busy &&
    snapshot?.embedding.state === "ready" &&
    snapshot.embedding.backend === "cpu" &&
    !!snapshot.embedding.fallbackReason;
  const active = busy
    ? "Applying change…"
    : snapshot?.embedding.state === "ready" && snapshot.embedding.backend
      ? `Using ${backendLabel(snapshot.embedding.backend)}${fallback ? " · fallback" : ""}`
      : snapshot?.embedding.state === "stopped"
        ? "Services stopped"
        : snapshot?.embedding.state === "starting"
          ? "Services starting"
          : "Active backend unavailable";
  const privacy = snapshot?.privacy;
  const privacyText =
    privacy?.state === "absent"
      ? "Not installed"
      : busy
        ? "Updating…"
        : privacy?.state === "ready"
          ? `${providerLabel(privacy.provider)}${privacy.fallbackReason ? " · fallback" : ""}`
          : privacy?.state === "stopped"
            ? "Services stopped"
            : "Unavailable";
  const failed =
    operation?.state === "failed" || operation?.state === "interrupted";
  const error = accelerationErrorMessage(
    acceleration.error ?? (failed ? operation?.message : null)
  );
  const footer = error
    ? error
    : operation?.state === "cancelled"
      ? operation.message
      : busy
        ? (operation?.message ?? "Applying this change…")
        : changed || installCuda
          ? snapshot?.embedding.state === "stopped"
            ? "Applies when services next start."
            : "Applying this change restarts local services."
          : fallback
            ? fallbackMessage
            : snapshot?.embedding.state === "unavailable"
              ? "The active backend could not be checked. Check service status."
              : "";
  const processingDescription = snapshot?.readOnlyReason
    ? snapshot.readOnlyReason
    : !fallback && snapshot?.hardware.state !== "available"
      ? snapshot?.hardware.reason
      : "Use your GPU when available, with CPU fallback.";
  const processingOptions = [
    { value: "cpu" as const, label: "CPU", disabled: false },
    ...(gpu || snapshot?.preference === "auto"
      ? [
          {
            value: "auto" as const,
            label: gpu ? `GPU · ${backendLabel(gpu)}` : "Automatic",
            disabled: !canUseGpu
          }
        ]
      : [])
  ];
  return (
    <div className="acceleration-settings" ref={portal}>
      <Group title="Hardware Acceleration">
        {!acceleration.available ? (
          <Row
            title="Processing controls unavailable"
            description="Open this page in Koed Desktop to manage local processing."
          />
        ) : !snapshot ? (
          <Row
            title={
              acceleration.error
                ? "Could not inspect processing"
                : "Checking this device…"
            }
          />
        ) : (
          <>
            <Row title="Processing" description={processingDescription}>
              <Select
                items={processingOptions}
                value={choice}
                disabled={readOnly}
                onValueChange={(value) => {
                  if (value !== null) setChoice(value);
                }}
              >
                <SelectTrigger
                  aria-label="Local AI processing"
                  className="acceleration-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup
                  portalContainer={portal}
                  align="end"
                  alignItemWithTrigger={false}
                >
                  {processingOptions.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Row>
            <div className="acceleration-model">
              <span>
                <HardDrive size={15} aria-hidden="true" />
                {snapshot.model.label}
              </span>
              <span
                className="acceleration-status"
                data-state={
                  busy
                    ? "pending"
                    : fallback
                      ? "fallback"
                      : snapshot.embedding.state
                }
                role="status"
                title={
                  !busy
                    ? snapshot.embedding.fallbackReason?.replaceAll("_", " ")
                    : undefined
                }
              >
                <i aria-hidden="true" />
                {active}
              </span>
            </div>
            {needsCuda && (choice === "auto" || !canUseGpu) && (
              <div className="acceleration-download">
                <p>
                  <Download size={14} aria-hidden="true" />
                  <span>
                    {snapshot.cuda.downloadBytes === null
                      ? "CUDA download size unavailable"
                      : snapshot.cuda.downloadBytes === 0
                        ? "CUDA assets ready for verification"
                        : `CUDA download · ${Math.ceil(snapshot.cuda.downloadBytes / 1_048_576).toLocaleString()} MB`}
                  </span>
                  <small>{accelerationDiskRequirement(snapshot.cuda)}</small>
                </p>
                {(!snapshot.cuda.canInstall ||
                  snapshot.hardware.state !== "available") && (
                  <p>{snapshot.cuda.reason}</p>
                )}
                {installCuda && canUseGpu && (
                  <p className="sr-only">
                    Apply downloads and enables the optional CUDA runtime.
                  </p>
                )}
              </div>
            )}
            <div
              className="acceleration-privacy"
              title="This preference also applies to an installed Privacy Filter. Its provider is checked separately; changing processing does not install Privacy Filter."
            >
              <ShieldCheck size={15} aria-hidden="true" />
              <span>Privacy Filter</span>
              <small>{privacyText}</small>
            </div>
          </>
        )}
        {(snapshot || acceleration.error) && (
          <div className="acceleration-footer">
            <span
              className="acceleration-footer-copy"
              data-warning={(fallback && !changed && !error) || undefined}
            >
              <span className="acceleration-footer-reserve" aria-hidden="true">
                {fallbackMessage}
              </span>
              <span
                className="acceleration-footer-message"
                role={error ? "alert" : "status"}
              >
                {footer}
              </span>
            </span>
            {(error || snapshot?.embedding.state === "unavailable") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !acceleration.available}
                onClick={() => void acceleration.inspect(true)}
              >
                Check again
              </Button>
            )}
            {operation?.state === "running" && operation.cancellable ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void acceleration.cancel()}
              >
                Cancel
              </Button>
            ) : snapshot ? (
              <Button
                size="sm"
                disabled={!canApply}
                aria-label={installCuda ? "Apply and install CUDA" : "Apply"}
                onClick={() =>
                  void acceleration.apply({
                    preference: choice,
                    installCuda,
                    expectedRevision: snapshot.revision
                  })
                }
              >
                Apply
              </Button>
            ) : null}
          </div>
        )}
      </Group>
    </div>
  );
}
