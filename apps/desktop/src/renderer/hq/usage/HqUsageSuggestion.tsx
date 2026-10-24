import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import type { DesktopApi } from "../../../types.js";
import type { ManagedConversationLaunchOptions } from "../../../ipc/managed-conversation-protocol.js";
import type { HqSelection } from "../conversation/hq-conversation-model.js";
import { useHqUsage } from "./use-hq-usage.js";
import {
  usageSilenceUntil,
  usageSuggestion,
  type UsageChoice
} from "./hq-usage-suggestion.js";
import "./hq-usage-suggestion.css";

export function HqUsageSuggestion({
  draft,
  selection,
  options,
  localAiClients,
  authorityKey,
  dismissalScopeKey,
  projectHq = false,
  running = false,
  refreshKey,
  onUse,
  onUndo,
  onNewChat,
  previousChoice
}: {
  draft: string;
  selection: HqSelection;
  options: ManagedConversationLaunchOptions | null;
  localAiClients?: DesktopApi["localAiClients"];
  authorityKey?: string;
  dismissalScopeKey?: string;
  projectHq?: boolean;
  running?: boolean;
  refreshKey?: string;
  onUse?: (instanceId: string) => void;
  onUndo?: () => void;
  onNewChat?: (instanceId: string) => void;
  previousChoice?: string | null;
}) {
  const usage = useHqUsage(
    localAiClients,
    authorityKey ?? "",
    Boolean(draft.trim()),
    refreshKey
  );
  const [silenced, setSilenced] = useState<{
    key: string;
    until: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const decisionScope = useRef("");
  decisionScope.current = JSON.stringify([
    authorityKey,
    dismissalScopeKey,
    usage.usageScopeId,
    selection.instanceId,
    selection.model,
    projectHq,
    running
  ]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!draft.trim() || !options || !selection.instanceId || !usage.readModel)
    return null;
  if (previousChoice && onUndo)
    return (
      <div
        className="hq-usage-suggestion hq-usage-suggestion--chosen"
        role="status"
      >
        <Check size={15} aria-hidden="true" />
        <span>
          Using{" "}
          {options.instances.find(
            (item) => item.instanceId === selection.instanceId
          )?.displayName ?? "the selected AI"}{" "}
          for this chat.
        </span>
        <button type="button" onClick={onUndo}>
          Undo
        </button>
      </div>
    );
  const choices: UsageChoice[] = options.instances.map((item) => ({
    instanceId: item.instanceId,
    driverId: item.driverId,
    displayName: item.displayName,
    model:
      item.instanceId === selection.instanceId
        ? selection.model
        : (item.models.find((model) => model.isDefault)?.id ??
          item.models[0]?.id ??
          ""),
    ready: item.ready && Boolean(item.models.length)
  }));
  const selected = choices.find(
    (choice) => choice.instanceId === selection.instanceId
  );
  if (!selected) return null;
  const warning = usageSuggestion(
    usage.readings,
    selected,
    choices,
    projectHq,
    now
  );
  const storageKey =
    usage.usageScopeId && dismissalScopeKey && warning
      ? `hq-usage-keep:${dismissalScopeKey}:${usage.usageScopeId}:${warning.silenceKey}`
      : null;
  const dismissalKey =
    storageKey ??
    `${authorityKey ?? ""}:${usage.usageScopeId}:${warning?.silenceKey ?? ""}`;
  let storedUntil = 0;
  if (storageKey) {
    try {
      storedUntil = Number(window.localStorage.getItem(storageKey)) || 0;
    } catch {
      /* Storage can be unavailable in a restricted renderer. */
    }
  }
  if (
    !warning ||
    (silenced?.key === dismissalKey && silenced.until > now) ||
    storedUntil > now
  )
    return null;
  const canOffer =
    !projectHq && warning.alternative && (running ? onNewChat : onUse);
  return (
    <div className="hq-usage-suggestion" role="status">
      <AlertTriangle size={15} aria-hidden="true" />
      <span>
        {warning.message}{" "}
        {projectHq || (!canOffer && warning.alternative)
          ? ""
          : warning.alternative
            ? running
              ? `New chat with ${warning.alternative?.displayName}?`
              : `Use ${warning.alternative?.displayName} for this chat?`
            : "No other AI reports room right now."}
      </span>
      <div className="hq-usage-suggestion__actions">
        {canOffer ? (
          <button
            type="button"
            className="hq-usage-suggestion__primary"
            onClick={() => {
              void (async () => {
                if (!localAiClients?.usage || !usage.usageScopeId) return;
                const expectedScope = decisionScope.current;
                let response;
                try {
                  response = await localAiClients.usage();
                } catch {
                  return;
                }
                if (
                  !mounted.current ||
                  decisionScope.current !== expectedScope ||
                  response.usageScopeId !== usage.usageScopeId
                )
                  return;
                const fresh = usageSuggestion(
                  response.usage ?? [],
                  selected,
                  choices,
                  projectHq,
                  Date.now()
                );
                if (
                  !fresh?.alternative ||
                  fresh.alternative.instanceId !==
                    warning.alternative?.instanceId ||
                  !response.usageScopeId
                )
                  return;
                if (running) onNewChat?.(fresh.alternative.instanceId);
                else onUse?.(fresh.alternative.instanceId);
              })();
            }}
          >
            {running ? "New chat with" : "Use"}{" "}
            {warning.alternative?.displayName}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            const value = {
              key: dismissalKey,
              until: usageSilenceUntil(warning, Date.now())
            };
            if (storageKey) {
              try {
                window.localStorage.setItem(storageKey, String(value.until));
              } catch {
                /* Keep this dismissal for the current mount. */
              }
            }
            setSilenced(value);
          }}
        >
          Keep {selected.displayName}
        </button>
      </div>
    </div>
  );
}
