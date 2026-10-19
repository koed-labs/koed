import { useCallback, useEffect, useState } from "react";
import { Button } from "@koed/ui";
import type { DesktopApi, KoedServerStatus } from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { useDesktopStatus } from "../../state/use-status.js";
import { summarizeCapabilities } from "../../views/ai-client-card.js";
import { LocalAiClientSettingsSection } from "../../views/preferences/LocalAiClientSettingsSection.js";
import {
  flatClientStatus,
  integrationConsentCopy,
  preferenceClients,
  type IntegrationMutationCommand
} from "./integration-model.js";
import { HqSettingRow, HqSettingsDialog } from "./HqSettings.js";

type Driver = "codex" | "claude" | "pi";
export function HqSettingsAgents({
  statusStore,
  localAiClients
}: {
  statusStore: DesktopStatusStore;
  localAiClients?: DesktopApi["localAiClients"];
}) {
  const snapshot = useDesktopStatus(statusStore);
  const [pending, setPending] = useState<IntegrationMutationCommand | null>(
    null
  );
  const [details, setDetails] = useState<Driver | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string | undefined>>(
    {}
  );
  const [clientErrors, setClientErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await statusStore.refresh();
    } finally {
      setRefreshing(false);
    }
  }, [statusStore]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (
    command: IntegrationMutationCommand | `check_${Driver}`
  ) => {
    setError(null);
    const checking = command.startsWith("check_");
    const driver = command.slice(command.indexOf("_") + 1);
    try {
      const result = await statusStore.run<{
        ok?: boolean;
        message?: string;
        status?: KoedServerStatus;
        capabilityRefresh?: { refreshed?: boolean };
        readiness?: {
          authentication?: string;
          profile?: { configured?: boolean };
        };
      }>(command, checking ? undefined : { operatorConsented: true });
      if (checking) {
        if (result?.capabilityRefresh?.refreshed === false) {
          setFailures((current) => ({
            ...current,
            [driver]: result.message ?? "Capability refresh failed."
          }));
          return;
        }
        if (result?.status) {
          setFailures((current) => ({ ...current, [driver]: undefined }));
          setClientErrors((current) => ({ ...current, [driver]: undefined }));
        }
        const authPending =
          result?.readiness?.profile?.configured === true &&
          (result.readiness.authentication === "unauthenticated" ||
            result.readiness.authentication === "unknown");
        if (result?.ok === false && !authPending)
          setClientErrors((current) => ({
            ...current,
            [driver]: (
              result.message ?? "AI Client capabilities need attention."
            )
              .replaceAll("mcp_recall", "MCP Recall")
              .replaceAll("local_synthesis", "Local Synthesis")
              .replaceAll("automatic_capture", "Auto-capture")
          }));
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (checking)
        setFailures((current) => ({ ...current, [driver]: message }));
      else setError(message);
    }
  };
  const status = snapshot.status;
  const verificationError = details
    ? (failures[details] ??
      (snapshot.error && status ? snapshot.error : undefined))
    : undefined;
  const readiness = details ? status?.aiClients?.[details] : undefined;
  const profile = details ? flatClientStatus(details, status) : undefined;
  const authentication =
    profile?.details?.authenticated === true
      ? "authenticated"
      : profile?.details?.authenticated === false
        ? "unauthenticated"
        : readiness?.authentication;
  const command =
    details === "claude" && authentication === "unauthenticated"
      ? "claude auth login"
      : details === "claude" &&
          authentication !== "authenticated" &&
          profile?.details?.authenticationState === "unknown"
        ? "claude auth status"
        : null;
  const authenticationStatus = Object.values(
    status?.aiClientInstances ?? status?.aiClients ?? {}
  ).flatMap((client) =>
    client
      ? [
          {
            instanceId: client.instanceId,
            authentication: client.authentication,
            observedAt: status!.generatedAt
          }
        ]
      : []
  );
  return (
    <>
      <section aria-label="AI Client integrations">
        <h3 className="hq-settings__eyebrow">Connections</h3>
        {error || snapshot.error ? (
          <p role="alert">{error ?? snapshot.error}</p>
        ) : null}
        {!status ? (
          <p role="status">
            {refreshing
              ? "Loading AI Client status…"
              : "AI Client status unavailable. Check a client or retry to get its current status."}
          </p>
        ) : snapshot.error ? (
          <p role="status">
            Showing last known AI Client results. Status could not be verified.
          </p>
        ) : null}
        {snapshot.error || !status ? (
          <Button
            disabled={refreshing || snapshot.busyCommand !== null}
            className="hq-settings__action"
            variant="outline"
            onClick={() => void refresh()}
          >
            {refreshing ? "Loading status…" : "Retry status"}
          </Button>
        ) : null}
        {preferenceClients.map(({ id, label }) => {
          const flat = flatClientStatus(id, status);
          const notConfigured = flat?.state === "not_configured";
          const mutationDisabled =
            snapshot.busyCommand !== null ||
            refreshing ||
            snapshot.error !== null;
          const current = status?.aiClients?.[id];
          const authenticationRequired =
            flat?.configured === true &&
            (current?.authentication === "unauthenticated" ||
              flat.details?.authenticated === false);
          const caps = summarizeCapabilities(current?.capabilities);
          const attention = caps.some(
            (cap) =>
              cap.dotClass === "is-attention" || cap.dotClass === "is-unknown"
          );
          const state = !flat
            ? refreshing && !status
              ? "Loading status…"
              : "Status unavailable"
            : failures[id]
              ? "Verification failed"
              : authenticationRequired
                ? id === "pi"
                  ? "Model authentication required"
                  : "Sign in required"
                : clientErrors[id] || attention
                  ? "Needs attention"
                  : flat?.state === "healthy"
                    ? "Healthy"
                    : flat?.state === "starting"
                      ? "Starting…"
                      : notConfigured
                        ? "Not set up"
                        : "Needs attention";
          return (
            <HqSettingRow
              key={id}
              title={label}
              description={
                authenticationRequired
                  ? id === "pi"
                    ? "Authenticate at least one model through Pi, then check again. Profile reinstall is not required."
                    : id === "claude"
                      ? "Run claude auth login. Claude Desktop sign-in does not authenticate Claude Code."
                      : "Authenticate Codex, then check again. Profile reinstall is not required."
                  : (current?.profile.message ??
                    flat?.message ??
                    "Check this AI Client to get its current status.")
              }
            >
              <button
                className="hq-settings__status"
                type="button"
                aria-label={`Show ${label} status details`}
                onClick={() => {
                  setDetails(id);
                  setCopied(false);
                }}
              >
                {snapshot.error && flat ? `Last known: ${state}` : state}
              </button>
              <div className="hq-settings__actions">
                {flat ? (
                  <Button
                    disabled={mutationDisabled}
                    className="hq-settings__action"
                    variant="outline"
                    onClick={() =>
                      setPending(`${notConfigured ? "setup" : "repair"}_${id}`)
                    }
                  >
                    {notConfigured ? "Set up" : "Repair"} {label}
                  </Button>
                ) : null}
                <Button
                  disabled={snapshot.busyCommand !== null}
                  variant="ghost"
                  onClick={() => void run(`check_${id}`)}
                >
                  Check {label}
                </Button>
                {flat && !notConfigured ? (
                  <Button
                    disabled={mutationDisabled}
                    className="hq-settings__danger-outline"
                    variant="destructive-outline"
                    onClick={() => setPending(`remove_${id}`)}
                  >
                    Remove {label}
                  </Button>
                ) : null}
              </div>
              {failures[id] || clientErrors[id] ? (
                <p role="alert">{failures[id] ?? clientErrors[id]}</p>
              ) : null}
            </HqSettingRow>
          );
        })}
      </section>
      <section
        className="hq-settings__group"
        aria-label="Local AI Client settings"
      >
        <LocalAiClientSettingsSection
          localAiClients={localAiClients}
          authenticationStatus={authenticationStatus}
        />
      </section>
      {pending ? (
        <HqSettingsDialog
          title={integrationConsentCopy[pending].title}
          description={integrationConsentCopy[pending].description}
          onClose={() => setPending(null)}
          actions={
            <Button
              disabled={
                snapshot.busyCommand !== null ||
                refreshing ||
                snapshot.error !== null
              }
              onClick={() => {
                const next = pending;
                setPending(null);
                void run(next);
              }}
            >
              {integrationConsentCopy[pending].confirmLabel}
            </Button>
          }
        />
      ) : null}
      {details ? (
        <HqSettingsDialog
          title={`${preferenceClients.find((client) => client.id === details)!.label} status`}
          description={
            verificationError
              ? "Showing last known results. The latest check did not verify them."
              : (profile?.message ??
                readiness?.profile.message ??
                "Koed has not yet confirmed this integration's status.")
          }
          onClose={() => setDetails(null)}
          actions={
            <Button
              disabled={snapshot.busyCommand !== null}
              onClick={() => void run(`check_${details}`)}
            >
              Check again
            </Button>
          }
        >
          {verificationError ? (
            <p role="status">
              {verificationError}{" "}
              {readiness?.observedAt &&
              Number.isFinite(Date.parse(readiness.observedAt))
                ? `Last observed: ${new Date(readiness.observedAt).toLocaleString()}`
                : "The time of the last observation is unavailable."}
            </p>
          ) : (
            <p>
              {profile?.action ??
                (authentication === "unauthenticated"
                  ? details === "pi"
                    ? "Authenticate at least one model through Pi, then check again."
                    : "Sign in to this AI Client, then check again. Profile reinstall is not required."
                  : "Check again for the latest status. Repair the integration if it still needs attention.")}
            </p>
          )}
          {profile?.details?.inspectionState === "unknown" ? (
            <p>
              Profile inspection and execution capabilities are checked
              separately. Ready Local Synthesis does not confirm Auto-capture or
              MCP Recall.
            </p>
          ) : null}
          {command ? (
            <div className="hq-settings__actions">
              <code>{command}</code>
              <Button
                className="hq-settings__action"
                variant="outline"
                onClick={() => {
                  void (async () => {
                    try {
                      if (!window.koedDesktop?.clipboard)
                        throw new Error("Clipboard unavailable.");
                      await window.koedDesktop.clipboard.writeText(command);
                      setCopied(true);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : String(cause)
                      );
                    }
                  })();
                }}
              >
                {copied ? "Copied" : "Copy command"}
              </Button>
            </div>
          ) : null}
          {command === "claude auth login" ? (
            <p>
              Run this in your terminal. Claude Desktop sign-in does not
              authenticate Claude Code.
            </p>
          ) : null}
          <dl className="hq-settings__facts">
            {summarizeCapabilities(readiness?.capabilities).map((cap) => (
              <div key={cap.id}>
                <dt>{cap.label}</dt>
                <dd>
                  {verificationError
                    ? `Last known: ${cap.statusLabel}`
                    : cap.statusLabel}
                </dd>
              </div>
            ))}
          </dl>
          {error || clientErrors[details] ? (
            <p role="alert">{error ?? clientErrors[details]}</p>
          ) : null}
        </HqSettingsDialog>
      ) : null}
    </>
  );
}
