import { useRef, useState } from "react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem
} from "@koed/ui";
import { Ellipsis } from "lucide-react";
import { clients, type ClientId } from "./onboarding/model.js";
import { aiClientHealth } from "./client-health.js";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import { ConfirmAction, Group } from "./settings-controls.js";
import { MemoryModelSettings } from "./MemoryModelSettings.js";
import type { DesktopApi } from "../../types.js";
import type {
  DesktopCommand,
  DesktopStatusStore,
  StatusSnapshot
} from "../services/desktop-commands.js";
type Mutation =
  | `setup_${ClientId}`
  | `repair_${ClientId}`
  | `remove_${ClientId}`;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
export function SettingsModels({
  api,
  statusStore,
  snapshot
}: {
  api?: DesktopApi["localAiClients"];
  statusStore: DesktopStatusStore;
  snapshot: StatusSnapshot;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    label: string;
    client: string;
    command: Mutation;
  } | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const portal = useRef<HTMLDivElement>(null);
  const runCheck = async (id: ClientId) => {
    setActionError(null);
    try {
      const result = await statusStore.run<{
        ok?: boolean;
        message?: string;
        capabilityRefresh?: { refreshed?: boolean };
      }>(`check_${id}` as DesktopCommand);
      if (
        result?.capabilityRefresh?.refreshed === false ||
        result?.ok === false
      )
        throw new Error(result.message ?? "AI Client check needs attention.");
      await statusStore.refresh();
      setModelRevision((value) => value + 1);
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  const runMutation = async () => {
    if (!pending) return;
    const command = pending.command;
    setActionError(null);
    try {
      const result = await statusStore.run<{ ok?: boolean; message?: string }>(
        command,
        { operatorConsented: true }
      );
      if (result?.ok === false)
        throw new Error(
          result.message ??
            "AI Client integration did not complete successfully."
        );
      await statusStore.refresh();
      setModelRevision((value) => value + 1);
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  return (
    <>
      {snapshot.error && <p role="alert">{snapshot.error}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      <Group title="AI Clients">
        {clients.map(({ id, label }) => {
          const health = aiClientHealth(id, snapshot.status);
          const { configured, installed, needsAttention } = health;
          const disabled = !!snapshot.busyCommand || !snapshot.status;
          const ready = configured && health.description === "Connected";
          const change = (action: "Connect" | "Repair" | "Disconnect") =>
            setPending({
              label: action,
              client: label,
              command:
                action === "Connect"
                  ? `setup_${id}`
                  : action === "Repair"
                    ? `repair_${id}`
                    : `remove_${id}`
            });
          return (
            <div key={id} className="client-row">
              <span className={"client-icon " + id}>
                <AiClientLogo id={id} />
              </span>
              <div className="row-copy">
                <strong>{label}</strong>
                <small>
                  {configured && !ready
                    ? health.description
                    : !installed && !configured
                      ? "Client unavailable on this device"
                      : "Local AI Client"}
                  {health.version && " · " + health.version}
                </small>
              </div>
              <Badge variant={ready ? "outline" : "neutral"}>
                {ready && <i className="status-dot" />}
                {ready
                  ? "Ready"
                  : needsAttention
                    ? "Needs attention"
                    : configured
                      ? health.description
                      : !snapshot.status
                        ? "Checking…"
                        : installed
                          ? "Disconnected"
                          : "Not installed"}
              </Badge>
              {!configured && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Connect ${label}`}
                  disabled={disabled || !installed}
                  onClick={() => change("Connect")}
                >
                  Connect
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
                    Check connection
                  </DropdownMenuItem>
                  {configured && (
                    <>
                      <DropdownMenuItem onClick={() => change("Repair")}>
                        Repair integration
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => change("Disconnect")}>
                        Disconnect
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuPopup>
              </DropdownMenu>
            </div>
          );
        })}
      </Group>
      <MemoryModelSettings key={modelRevision} api={api} />
      <div ref={portal} />
      {pending && (
        <ConfirmAction
          title={pending.label + " " + pending.client + "?"}
          label={pending.label}
          destructive={pending.label === "Disconnect"}
          description={
            pending.label === "Disconnect"
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
