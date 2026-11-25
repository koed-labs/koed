import { useRef, useState, type Ref } from "react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem
} from "@koed-labs/ui";
import { Ellipsis } from "lucide-react";
import { clients, type ClientId } from "./onboarding/model.js";
import {
  aiClientHealth,
  clientModelLimitation,
  clientSignedOut,
  savedMemoryModelProblems
} from "./client-health.js";
import { useMemoryModel } from "./use-memory-model.js";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import { ConfirmAction, Group } from "./settings-controls.js";
import { MemoryModelSettings } from "./MemoryModelSettings.js";
import type { DesktopApi } from "../../types.js";
import type {
  DesktopStatusStore,
  StatusSnapshot
} from "../services/desktop-commands.js";

type Mutation = "Connect" | "Repair" | "Disconnect";
const mutationCommands = {
  Connect: "setup",
  Repair: "repair",
  Disconnect: "remove"
} as const;
const loginCommand = "claude auth login";
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function SettingsModels({
  api,
  statusStore,
  snapshot,
  focusClient,
  focusRef
}: {
  api?: DesktopApi["localAiClients"];
  statusStore: DesktopStatusStore;
  snapshot: StatusSnapshot;
  focusClient: ClientId | null | undefined;
  focusRef: Ref<HTMLDivElement>;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    action: Mutation;
    id: ClientId;
    label: string;
  } | null>(null);
  const picker = useMemoryModel(api);
  const problems = savedMemoryModelProblems(
    picker.confirmedRead,
    snapshot.status
  );
  const portal = useRef<HTMLDivElement>(null);
  const disabled = !!snapshot.busyCommand || !snapshot.status;
  const runCheck = async (id: ClientId) => {
    setActionError(null);
    setNotice(null);
    try {
      const result = await statusStore.run<{
        message?: string;
        capabilityRefresh?: { refreshed?: boolean };
      }>(`check_${id}`);
      if (result?.capabilityRefresh?.refreshed === false) {
        setNotice(
          result.message ?? "Couldn’t check AI Client capabilities. Try again."
        );
      } else picker.reread();
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  const runMutation = async () => {
    if (!pending) return;
    setActionError(null);
    try {
      const result = await statusStore.run<{ ok?: boolean; message?: string }>(
        `${mutationCommands[pending.action]}_${pending.id}`,
        { operatorConsented: true }
      );
      if (result?.ok === false)
        throw new Error(
          result.message ??
            "AI Client integration did not complete successfully."
        );
      picker.reread();
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  const copyLogin = async () => {
    setActionError(null);
    try {
      const clipboard = window.koedDesktop?.clipboard;
      if (!clipboard) throw new Error("Clipboard is unavailable.");
      await clipboard.writeText(loginCommand);
      setNotice("Login command copied.");
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  return (
    <>
      {notice && <p role="status">{notice}</p>}
      {snapshot.error && <p role="alert">{snapshot.error}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      <Group title="AI Clients">
        {clients.map(({ id, label }) => {
          const health = aiClientHealth(id, snapshot.status);
          const limitation =
            clientModelLimitation(id, picker.confirmedRead, snapshot.status) ??
            problems.find(({ provider }) => provider === id)?.reason;
          const login =
            id === "claude" &&
            clientSignedOut(id, picker.confirmedRead, snapshot.status);
          const change = (action: Mutation) =>
            setPending({ action, id, label });
          return (
            <div
              key={id}
              className="client-row"
              data-client={id}
              role="group"
              aria-label={label}
              tabIndex={-1}
              ref={id === focusClient ? focusRef : undefined}
            >
              <span className={"client-icon " + id}>
                <AiClientLogo id={id} />
              </span>
              <div className="row-copy">
                <strong>{label}</strong>
                <small>
                  {health.needsAttention
                    ? health.description
                    : health.captureReady && health.mcpInstalled
                      ? "Capture ready · MCP installed"
                      : health.installed || health.configured
                        ? "Local AI Client"
                        : "Client unavailable on this device"}
                  {health.version && " · " + health.version}
                </small>
              </div>
              <Badge variant={health.connected ? "outline" : "neutral"}>
                {health.connected && <i className="status-dot" />}
                {health.connected
                  ? "Connected"
                  : health.needsAttention
                    ? "Needs attention"
                    : health.unknown
                      ? "Status unsure"
                      : health.installed
                        ? "Disconnected"
                        : "Not installed"}
              </Badge>
              {!health.configured && !health.repairable && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Connect ${label}`}
                  disabled={disabled || !health.installed || health.unknown}
                  onClick={() => change("Connect")}
                >
                  Connect
                </Button>
              )}
              {health.needsAttention && !health.repairable && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void runCheck(id)}
                >
                  Check integration again
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={label + " actions"}
                    />
                  }
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuPopup align="end" portalContainer={portal}>
                  <DropdownMenuItem onClick={() => void runCheck(id)}>
                    Check again
                  </DropdownMenuItem>
                  {health.repairable && (
                    <DropdownMenuItem onClick={() => change("Repair")}>
                      Repair integration
                    </DropdownMenuItem>
                  )}
                  {health.configured && (
                    <DropdownMenuItem onClick={() => change("Disconnect")}>
                      Disconnect
                    </DropdownMenuItem>
                  )}
                </DropdownMenuPopup>
              </DropdownMenu>
              {limitation && (
                <div className="client-model-note">
                  <small>
                    Memory Model:{" "}
                    {login
                      ? "Sign in to Claude Code in your terminal, then check again."
                      : limitation}
                  </small>
                  {login && (
                    <small>
                      Recall through Claude Code is unavailable until you sign
                      in to its CLI. Claude Desktop sign-in doesn’t sign in the
                      CLI.
                    </small>
                  )}
                  <div>
                    {login && (
                      <>
                        <code>{loginCommand}</code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void copyLogin()}
                        >
                          Copy command
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => void runCheck(id)}
                    >
                      Check again
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Group>
      <MemoryModelSettings
        picker={picker}
        writable={!!api?.setMemoryModel}
        problems={problems}
        busy={disabled || picker.refreshing}
        onCheck={(id) => void runCheck(id)}
      />
      <div ref={portal} />
      {pending && (
        <ConfirmAction
          title={`${pending.action} ${pending.label}?`}
          label={pending.action}
          destructive={pending.action === "Disconnect"}
          description={
            pending.action === "Disconnect"
              ? "Remove the Koed integration from this AI Client’s local profile."
              : "Configure the Koed integration in this AI Client’s local profile."
          }
          close={() => setPending(null)}
          confirm={() => void runMutation()}
        />
      )}
    </>
  );
}
