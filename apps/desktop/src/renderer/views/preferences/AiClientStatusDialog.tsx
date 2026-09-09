import { useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle
} from "@koed/ui";
import type { AiClientReadiness, ComponentStatus } from "../../../types.js";
import { summarizeCapabilities } from "../ai-client-card.js";

export function AiClientStatusDialog({
  label,
  driverId,
  profile,
  readiness,
  busy,
  error,
  onCheck,
  onClose
}: {
  label: string;
  driverId: "codex" | "claude" | "pi";
  profile?: ComponentStatus;
  readiness?: AiClientReadiness;
  busy: boolean;
  error: string | null;
  onCheck: () => Promise<void>;
  onClose: () => void;
}) {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const authentication =
    profile?.details?.authenticated === true || profile?.state === "healthy"
      ? "authenticated"
      : profile?.details?.authenticated === false
        ? "unauthenticated"
        : readiness?.authentication;
  const command =
    driverId === "claude" && authentication === "unauthenticated"
      ? "claude auth login"
      : driverId === "claude" &&
          authentication !== "authenticated" &&
          profile?.details?.authenticationState === "unknown"
        ? "claude auth status"
        : null;
  const action =
    profile?.action ??
    (authentication === "unauthenticated"
      ? driverId === "pi"
        ? "Authenticate at least one model through Pi, then check again."
        : "Sign in to the AI Client, then check again. Profile reinstall is not required."
      : profile?.state === "healthy"
        ? null
        : "Check again to get the latest status. If the issue persists, repair the integration from its card.");
  const copy = async () => {
    if (!command) return;
    setCopyError(null);
    try {
      if (!window.koedDesktop?.clipboard)
        throw new Error("Clipboard unavailable.");
      await window.koedDesktop.clipboard.writeText(command);
      setCopiedCommand(command);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const capabilities = summarizeCapabilities(readiness?.capabilities);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{label} status</DialogTitle>
          <DialogDescription>
            {profile?.message ??
              readiness?.profile.message ??
              "Koed has not yet confirmed this integration's status."}
          </DialogDescription>
        </DialogHeader>
        <div className="koed-client-status-details">
          {action ? <p>{action}</p> : null}
          {profile?.details?.inspectionState === "unknown" ? (
            <p>
              Profile inspection and execution capabilities are checked
              separately. Ready Local Synthesis does not confirm that automatic
              capture or MCP Recall is ready.
            </p>
          ) : null}
          {command ? (
            <div className="koed-client-status-command">
              <code>{command}</code>
              <Button variant="outline" onClick={() => void copy()}>
                {copiedCommand === command ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {copiedCommand === command ? "Copied" : "Copy command"}
              </Button>
            </div>
          ) : null}
          {command === "claude auth login" ? (
            <p>
              Run this in your terminal. Claude Desktop sign-in does not
              authenticate Claude Code.
            </p>
          ) : null}
          {copyError ? (
            <p role="alert" className="koed-diagnostic-error">
              {copyError}
            </p>
          ) : null}
          {capabilities.length ? (
            <ul className="koed-client-status-capabilities">
              {capabilities.map((capability) => (
                <li key={capability.id}>
                  <span>{capability.label}</span>
                  <strong>{capability.statusLabel}</strong>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p role="alert" className="koed-diagnostic-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          <Button disabled={busy} onClick={() => void onCheck()}>
            {busy ? "Checking…" : "Check again"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
