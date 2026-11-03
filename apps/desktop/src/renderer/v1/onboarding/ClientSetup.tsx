import { useEffect, useRef, useState } from "react";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { useDesktopStatus } from "../../state/use-status.js";
import {
  authenticationGuidance,
  clientCommand,
  clientDetected,
  clientReady,
  clients,
  errorText,
  operationError,
  type ClientId
} from "./model.js";
import openaiIcon from "./icons/openai.svg";
import claudeIcon from "./icons/anthropic.svg";
import piIcon from "./icons/pi-coding-agent.svg";

const icons = { codex: openaiIcon, claude: claudeIcon, pi: piIcon };
type Result = {
  state: "queued" | "connecting" | "success" | "error";
  message?: string;
  detail?: string;
};
export function Arrow() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8h10m-4-4 4 4-4 4" />
    </svg>
  );
}
export function Spinner() {
  return <span className="lp-spinner" aria-hidden="true" />;
}
function ResultIcon({ success }: { success: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={success ? "m4 9 3.3 3.3L14 5" : "m5 5 8 8m0-8-8 8"} />
    </svg>
  );
}
export function ClientSetup({
  statusStore,
  selected,
  selectionInitialized,
  onSelection,
  onFeedback,
  onFinished
}: {
  statusStore: DesktopStatusStore;
  selected: ClientId[];
  selectionInitialized: boolean;
  onSelection: (ids: ClientId[]) => void;
  onFeedback: (state: {
    found: number;
    scanned: boolean;
    failed: boolean;
  }) => void;
  onFinished: () => void;
}) {
  const { status, busyCommand } = useDesktopStatus(statusStore);
  const [scanning, setScanning] = useState(true);
  const [scanned, setScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"choose" | "connecting" | "results">(
    "choose"
  );
  const [results, setResults] = useState<Partial<Record<ClientId, Result>>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const connecting = useRef(false);
  const initialized = useRef(selectionInitialized);
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  const detected = clients.filter((c) => clientDetected(c.id, status));
  // Results for deselected clients must not drive retries or readiness.
  const resultFor = (id: ClientId) =>
    selected.includes(id) ? results[id] : undefined;
  const successful = clients.filter(
    (c) => resultFor(c.id)?.state === "success" && clientReady(c.id, status)
  );
  const unresolved = clients.filter(
    (c) =>
      resultFor(c.id) &&
      resultFor(c.id)?.state !== "queued" &&
      resultFor(c.id)?.state !== "connecting" &&
      !successful.includes(c)
  );
  const hasFailure = unresolved.length > 0;
  const busy = scanning || phase === "connecting" || !!busyCommand;
  const canContinue = phase === "results" && successful.length > 0 && !busy;

  async function scan() {
    if (connecting.current) return;
    const request = ++sequence.current;
    setScanning(true);
    setScanError(null);
    try {
      const next = await statusStore.refresh();
      if (!next || !next.api.url || next.lifecycle?.state === "unavailable")
        throw new Error(
          statusStore.current().error ??
            "Could not check AI Clients. Try again."
        );
      if (!mounted.current || sequence.current !== request) return;
      setScanned(true);
      if (!initialized.current) {
        initialized.current = true;
        selectionCallback.current(
          clients.filter((c) => clientDetected(c.id, next)).map((c) => c.id)
        );
      }
    } catch (cause) {
      if (mounted.current && sequence.current === request) {
        setScanError(errorText(cause));
        setScanned(false);
      }
    } finally {
      if (mounted.current && sequence.current === request) setScanning(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    void scan();
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [statusStore]);
  useEffect(() => {
    onFeedback({
      found: scanned ? detected.length : 0,
      scanned,
      failed: hasFailure || !!scanError
    });
  }, [detected.length, scanned, hasFailure, scanError, onFeedback]);
  useEffect(() => {
    if (phase === "results") heading.current?.focus();
  }, [phase]);

  async function connect(ids: ClientId[]) {
    if (!ids.length || connecting.current || busyCommand || scanning) return;
    connecting.current = true;
    const request = ++sequence.current;
    setPhase("connecting");
    setScanError(null);
    setResults((previous) => ({
      ...previous,
      ...Object.fromEntries(ids.map((id) => [id, { state: "queued" }]))
    }));
    for (const id of ids) {
      if (!mounted.current || request !== sequence.current) break;
      setResults((previous) => ({
        ...previous,
        [id]: { state: "connecting" }
      }));
      try {
        const command = clientCommand(id, statusStore.current().status);
        const { result, status: fresh } =
          await statusStore.runWithStatus<unknown>(
            command,
            command.startsWith("check_")
              ? undefined
              : { operatorConsented: true }
          );
        const failure = operationError(result);
        if (failure) throw new Error(failure);
        if (!fresh)
          throw new Error(
            statusStore.current().error ??
              "Could not confirm AI Client readiness. Check again."
          );
        if (mounted.current && request === sequence.current) {
          const ready = clientReady(id, fresh);
          setResults((previous) => ({
            ...previous,
            [id]: ready
              ? { state: "success" }
              : { state: "error", message: authenticationGuidance(id, fresh) }
          }));
        }
      } catch (cause) {
        if (mounted.current && request === sequence.current)
          setResults((previous) => ({
            ...previous,
            [id]: { state: "error", detail: errorText(cause) }
          }));
      }
    }
    connecting.current = false;
    if (mounted.current && request === sequence.current) setPhase("results");
  }
  const intro =
    phase === "connecting"
      ? "Making the introductions. Just a moment…"
      : phase === "results"
        ? hasFailure
          ? successful.length
            ? "Some introductions need another try. You can continue with the rest."
            : "We couldn’t connect just yet. Connect at least one AI Client to continue."
          : "Everyone’s connected. You’re ready to go."
        : scanning
          ? "Kin’s finding your AI Clients. We’ll tick each one as it appears."
          : scanError
            ? "We couldn’t check this device. Try scanning again."
            : !detected.length
              ? clients.every(
                  (c) =>
                    status?.aiClients?.[c.id]?.installed.state ===
                    "not_configured"
                )
                ? "No AI Clients found. Install Codex, Claude Code, or Pi, then scan again."
                : "We couldn’t confirm an installed AI Client. Check availability, then scan again."
              : selected.length
                ? "Found your familiar faces. Keep the ones you want to connect."
                : "Choose at least one AI Client to continue.";
  return (
    <div className="lp-client-panel">
      <h1 ref={heading} tabIndex={-1}>
        Connect your AI Clients.
      </h1>
      <p className="lp-client-intro">{intro}</p>
      {scanError && (
        <p className="lp-error" role="alert">
          {scanError}
        </p>
      )}
      <div className="lp-client-list" aria-label="Available AI Clients">
        {clients.map((client) => {
          const observed = status?.aiClients?.[client.id];
          const found = scanned && clientDetected(client.id, status);
          const choosing = phase === "choose";
          const result = resultFor(client.id);
          const success =
            result?.state === "success" && clientReady(client.id, status);
          const failed =
            !!result &&
            (result.state === "error" ||
              (result.state === "success" && !success));
          const resultState = failed ? "error" : result?.state;
          const message = failed
            ? (result?.message ??
              (result?.state === "success"
                ? authenticationGuidance(client.id, status)
                : "Couldn’t connect. Try again."))
            : null;
          const detail =
            failed && result?.detail !== message ? result?.detail : null;
          const availability = scanning
            ? "Checking this device…"
            : !scanned ||
                !observed ||
                observed.snapshotState === "stale" ||
                (observed.snapshotState === "unknown" &&
                  observed.installed.state !== "healthy")
              ? "Availability unknown"
              : observed.installed.state === "not_configured"
                ? "Not found on this device"
                : observed.installed.state !== "healthy"
                  ? (observed.installed.message ?? "Check availability")
                  : observed.version
                    ? `v${observed.version}`
                    : "Installed";
          return (
            <div
              key={client.id}
              className={`lp-client-card ${found ? "is-detected" : "is-searching"} ${selected.includes(client.id) ? "is-selected" : ""} ${choosing ? "" : "is-locked"} ${resultState ? `is-${resultState}` : ""}`}
              data-provider={client.id}
              data-connection={resultState ?? "idle"}
            >
              <label className="lp-client-card-top">
                <span
                  className={`lp-client-icon lp-client-icon-${client.id}`}
                  style={{ maskImage: `url("${icons[client.id]}")` }}
                  aria-hidden="true"
                />
                <span className="lp-client-name">
                  <strong>{client.label}</strong>
                  <small>{message ?? availability}</small>
                </span>
                {choosing ? (
                  <input
                    type="checkbox"
                    aria-label={`Enable ${client.label}`}
                    checked={selected.includes(client.id)}
                    disabled={busy || !found}
                    onChange={() =>
                      onSelection(
                        selected.includes(client.id)
                          ? selected.filter((id) => id !== client.id)
                          : [...selected, client.id]
                      )
                    }
                  />
                ) : (
                  <span
                    className={`lp-connection-result is-${resultState ?? "skipped"}`}
                    role="img"
                    aria-label={`${client.label}: ${success ? "connected" : failed ? "needs attention" : (resultState ?? "not selected")}`}
                  >
                    {result?.state === "connecting" ? (
                      <Spinner />
                    ) : result?.state === "queued" ? (
                      <span aria-hidden="true">…</span>
                    ) : result ? (
                      <ResultIcon success={success} />
                    ) : (
                      <span aria-hidden="true">—</span>
                    )}
                  </span>
                )}
              </label>
              {detail && (
                <details className="lp-client-details" key={detail}>
                  <summary aria-label={`${client.label} connection details`}>
                    Details
                  </summary>
                  <p>{detail}</p>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <div className="lp-client-actions">
        {phase === "choose" ? (
          <>
            <button
              type="button"
              className="lp-text-button"
              disabled={busy}
              onClick={() => void scan()}
            >
              Scan again
            </button>
            <button
              type="button"
              className="lp-primary-button lp-connect-button"
              disabled={
                busy ||
                !scanned ||
                !!scanError ||
                !selected.some((id) => detected.some((c) => c.id === id))
              }
              onClick={() =>
                void connect(
                  selected.filter((id) => detected.some((c) => c.id === id))
                )
              }
            >
              Connect <Arrow />
            </button>
          </>
        ) : phase === "connecting" ? (
          <button
            type="button"
            className="lp-primary-button lp-connect-button"
            disabled
            aria-busy="true"
            aria-label="Connecting AI Clients"
          >
            <Spinner />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="lp-text-button"
              disabled={busy}
              onClick={() => setPhase("choose")}
            >
              Change selection
            </button>
            {hasFailure && (
              <button
                type="button"
                className={canContinue ? "lp-text-button" : "lp-primary-button"}
                disabled={busy}
                onClick={() => void connect(unresolved.map((c) => c.id))}
              >
                {canContinue ? "Retry failed" : "Retry connections"}
              </button>
            )}
            {successful.length > 0 && (
              <button
                type="button"
                className="lp-primary-button"
                disabled={!canContinue}
                onClick={onFinished}
              >
                Continue <Arrow />
              </button>
            )}
          </>
        )}
      </div>
      <p className="lp-sr-only" role="status" aria-live="polite">
        {phase === "choose"
          ? scanning
            ? "Looking for your AI Clients."
            : scanError
              ? "AI Client discovery failed."
              : `Discovery complete. ${detected.length} AI Clients detected.`
          : `${successful.length} AI Clients connected. ${unresolved.length} need attention.${canContinue ? " You can continue." : ""}`}
      </p>
    </div>
  );
}
