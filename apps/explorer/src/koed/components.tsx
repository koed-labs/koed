import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CpuIcon,
  LoaderCircleIcon,
  SendIcon,
  SettingsIcon,
  SparklesIcon
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";

import {
  Button,
  cn,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Spinner
} from "@koed/ui";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "../components/ui/sidebar";
import { apiBaseUrl } from "./api";
import { codexIdePromptUserText } from "./codexIdePrompt";
import { PatchBody } from "./PatchDisclosure";
import {
  eventActorLabel,
  eventDisplayText,
  eventIcon,
  eventTone,
  firstLine,
  formatDate,
  toolEventSummary
} from "./graph";
import { KoedMarkdown } from "./KoedMarkdown";
import {
  memoryQuestionPreview,
  questionEvidence,
  questionRetrieval
} from "./memory";
import type { MemoryScopeCommand } from "./memoryComposerCommands";
import { MemoryComposerEditor } from "./MemoryComposerEditor";
import type {
  AiClient,
  GroupedMemoryQuestions,
  GraphEvent,
  GraphNode,
  LocalMemoryAgentFlowKey,
  LocalMemoryAgentFlowSettings,
  LocalMemoryAgentSettings,
  ManualMemoryQuestionWorkerConfig,
  MemoryQuestionRecord,
  MemoryQuestionStatus,
  SearchDomain,
  ThemePreference,
  ThreadGroup
} from "./types";
import { aiClientOptions, themeOptions } from "./types";

const memoryComposerMinHeight = 72;
const memoryComposerDefaultHeight = 96;
const memoryComposerMaxHeight = 260;
const memoryComposerHeightStep = 12;

function clampMemoryComposerHeight(value: number) {
  return Math.min(
    memoryComposerMaxHeight,
    Math.max(memoryComposerMinHeight, value)
  );
}

export function KoedMessage({
  event,
  isSelected,
  onSelect
}: {
  event: GraphEvent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  if (event.actor === "tool") {
    return (
      <ToolEventRow event={event} isSelected={isSelected} onSelect={onSelect} />
    );
  }

  const Icon = eventIcon(event.actor);
  const text = eventDisplayText(event);

  return (
    <article
      className={cn(
        "group grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-card/50",
        isSelected && "ring-2 ring-inset ring-ring/45",
        event.invalidatedAt && "opacity-60"
      )}
      onClick={onSelect}
    >
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
          eventTone(event.actor)
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">
            {eventActorLabel(event)}
          </span>
          <span>{formatDate(event.timestamp)}</span>
          <span>{event.visibility}</span>
          {event.linkedNodeIds.length > 0 ? (
            <span>{event.linkedNodeIds.length} LCM links</span>
          ) : null}
        </div>
        <KoedMarkdown text={text} />
      </div>
    </article>
  );
}

function ToolEventRow({
  event,
  isSelected,
  onSelect
}: {
  event: GraphEvent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = eventIcon(event.actor);
  const summary = toolEventSummary(event);
  const fullText = eventDisplayText(event);
  const hasPatch = Boolean(summary.patch);
  const isExpanded = hasPatch || expanded;
  const Caret = isExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <article
      className={cn(
        "group grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-card/50",
        isSelected && "ring-2 ring-inset ring-ring/45",
        event.invalidatedAt && "opacity-60"
      )}
      onClick={onSelect}
    >
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
          eventTone(event.actor)
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-2">
          {hasPatch ? null : (
            <Button
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse tool call" : "Expand tool call"}
              className="mt-0.5 shrink-0"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              size="icon-xs"
              variant="ghost"
            >
              <Caret className="size-3.5" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">
                {summary.label}
              </span>
              {summary.toolName ? <span>{summary.toolName}</span> : null}
              {summary.status ? <span>{summary.status}</span> : null}
              <span>{formatDate(event.timestamp)}</span>
              {summary.toolCallId ? (
                <span className="max-w-36 truncate">{summary.toolCallId}</span>
              ) : null}
            </div>
            {hasPatch ? null : (
              <div className="truncate text-muted-foreground text-sm">
                {summary.preview}
              </div>
            )}
            {isExpanded ? (
              hasPatch && summary.patch ? (
                <PatchBody className="mt-2" patch={summary.patch} />
              ) : (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-secondary/35 p-2.5 font-mono text-[12px] leading-relaxed text-foreground">
                  {fullText}
                </pre>
              )
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ThemeSelect({
  onChange,
  value
}: {
  onChange: (value: ThemePreference) => void;
  value: ThemePreference;
}) {
  return (
    <Select
      onValueChange={(next) => {
        if (next === "system" || next === "light" || next === "dark") {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label="Theme preference" className="w-28" size="xs">
        <SelectValue>
          {themeOptions.find((option) => option.value === value)?.label ??
            "System"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {themeOptions.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function configSnippet(client: AiClient, apiToken: string) {
  const token = apiToken.trim() || "paste_token_here";
  const cliPath =
    "/absolute/path/to/koed-self-hosted/packages/mcp-server/dist/cli.js";
  const hookPath =
    "/absolute/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js";
  const clientName =
    aiClientOptions.find((option) => option.value === client)?.label ??
    "AI client";
  const hookEvents = [
    ["SessionStart", 10],
    ["UserPromptSubmit", 10],
    ["PostToolUse", 10],
    ["Stop", 30],
    ["SubagentStart", 10],
    ["SubagentStop", 30]
  ] as const;
  const hookBlocks = hookEvents
    .map(
      ([eventName, timeout]) => `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = "node ${hookPath}"
timeout = ${timeout}`
    )
    .join("\n\n");

  return `# ${clientName}: add this Koed MCP + capture hook configuration.
[mcp_servers.koed]
command = "node"
args = ["${cliPath}"]
enabled = true

[mcp_servers.koed.env]
MEMORY_API_URL = "${apiBaseUrl}"
MEMORY_API_TOKEN = "${token}"
MEMORY_CODEX_APP_SERVER_BINARY = "codex"

${hookBlocks}`;
}

export function SettingsPanel({
  apiToken,
  localAgentSettings,
  localAgentSettingsError,
  saveLocalAgentFlowSetting,
  selectedClient,
  setApiToken,
  setSelectedClient
}: {
  apiToken: string;
  localAgentSettings: LocalMemoryAgentSettings | null;
  localAgentSettingsError: string | null;
  saveLocalAgentFlowSetting: (
    flowKey: LocalMemoryAgentFlowKey,
    setting: Pick<
      LocalMemoryAgentFlowSettings,
      "provider" | "model" | "reasoningEffort" | "timeoutMs" | "maxAttempts"
    >
  ) => Promise<void>;
  selectedClient: AiClient;
  setApiToken: (value: string) => void;
  setSelectedClient: (value: AiClient) => void;
}) {
  const flows = localAgentSettings?.flows;
  const localAgentReady = Boolean(
    localAgentSettings?.aiClients.some(
      (client) => client.id === "codex" && client.status === "ready"
    )
  );
  return (
    <section className="border-border border-b bg-card/55 px-3 py-3 sm:px-5">
      <div className="mx-auto grid w-full max-w-5xl gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-background/80 p-3">
          <div className="mb-3 flex items-center gap-2 font-medium text-sm">
            <SettingsIcon className="size-4 text-primary" />
            Koed client settings
          </div>
          <label
            className="block text-muted-foreground text-xs"
            htmlFor="koed-ai-client"
          >
            AI client
          </label>
          <select
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="koed-ai-client"
            onChange={(event) => {
              const next = event.target.value;
              if (next === "codex") {
                setSelectedClient(next);
              }
            }}
            value={selectedClient}
          >
            {aiClientOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label
            className="mt-3 block text-muted-foreground text-xs"
            htmlFor="koed-api-token"
          >
            API token
          </label>
          <input
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="koed-api-token"
            onChange={(event) => setApiToken(event.target.value)}
            placeholder="cmt_..."
            type="password"
            value={apiToken}
          />
          <div className="mt-4 border-border border-t pt-3">
            <div className="mb-2 flex items-center gap-2 font-medium text-sm">
              <BotIcon className="size-4 text-primary" />
              Local agents
            </div>
            {localAgentSettingsError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-destructive-foreground text-xs">
                {localAgentSettingsError}
              </div>
            ) : null}
            <div className="space-y-2">
              {(localAgentSettings?.aiClients ?? []).map((client) => (
                <div
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary/35 px-2 py-1.5 text-xs"
                  key={client.id}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <CpuIcon className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{client.label}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5",
                      client.status === "ready"
                        ? "bg-success/12 text-success-foreground"
                        : "bg-destructive/10 text-destructive-foreground"
                    )}
                  >
                    {client.status === "ready" ? "Ready" : "Unavailable"}
                  </span>
                </div>
              ))}
              {!localAgentSettings && !localAgentSettingsError ? (
                <div className="rounded-md border border-border bg-secondary/25 px-2 py-1.5 text-muted-foreground text-xs">
                  Waiting for local bridge settings
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background/80 p-3">
          <div className="mb-2 font-medium text-sm">config.toml snippet</div>
          <pre className="max-h-64 overflow-auto rounded-md bg-secondary/45 p-3 text-[11px] leading-relaxed">
            {configSnippet(selectedClient, apiToken)}
          </pre>
          {localAgentSettings?.modelListError ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-destructive-foreground text-xs">
              {localAgentSettings.modelListError}
            </div>
          ) : null}
          <div className="mt-3 grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <AgentFlowSettingsCard
              flow={flows?.mcpMemoryAnswer}
              flowKey="mcp_memory_answer"
              label="MCP memory answer"
              localAgentReady={localAgentReady}
              modelOptions={localAgentSettings?.modelOptions ?? []}
              onSave={saveLocalAgentFlowSetting}
            />
            <AgentFlowSettingsCard
              flow={flows?.lcmSummary}
              flowKey="lcm_summary"
              label="LCM summaries"
              localAgentReady={localAgentReady}
              modelOptions={localAgentSettings?.modelOptions ?? []}
              onSave={saveLocalAgentFlowSetting}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentFlowSettingsCard({
  flow,
  flowKey,
  localAgentReady,
  modelOptions,
  onSave,
  label
}: {
  flow: LocalMemoryAgentSettings["flows"]["mcpMemoryAnswer"] | undefined;
  flowKey: LocalMemoryAgentFlowKey;
  localAgentReady: boolean;
  modelOptions: LocalMemoryAgentSettings["modelOptions"];
  onSave: (
    flowKey: LocalMemoryAgentFlowKey,
    setting: Pick<
      LocalMemoryAgentFlowSettings,
      "provider" | "model" | "reasoningEffort" | "timeoutMs" | "maxAttempts"
    >
  ) => Promise<void>;
  label: string;
}) {
  const [draft, setDraft] = useState(() => ({
    provider: "codex" as const,
    model: flow?.model ?? modelOptions[0]?.model ?? "",
    reasoningEffort: flow?.reasoningEffort ?? "high",
    timeoutMs: flow?.timeoutMs ?? 120_000,
    maxAttempts: flow?.maxAttempts ?? 2
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft({
      provider: "codex",
      model: flow?.model ?? modelOptions[0]?.model ?? "",
      reasoningEffort: flow?.reasoningEffort ?? "high",
      timeoutMs: flow?.timeoutMs ?? 120_000,
      maxAttempts: flow?.maxAttempts ?? 2
    });
  }, [flow, modelOptions]);
  const selectedModel =
    modelOptions.find((option) => option.model === draft.model) ?? null;
  const reasoningOptions =
    selectedModel && selectedModel.supportedReasoningEfforts.length > 0
      ? selectedModel.supportedReasoningEfforts
      : [{ reasoningEffort: draft.reasoningEffort }];
  const save = async () => {
    if (!draft.model.trim()) {
      setError("Select a Codex model before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(flowKey, draft);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError)
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0 rounded-md border border-border bg-secondary/25 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-foreground">{label}</div>
        <span className="rounded bg-background/80 px-1.5 py-0.5 text-muted-foreground">
          {flow?.source === "db" ? "Saved" : "Default"}
        </span>
      </div>
      {flow ? (
        <div className="mt-2 grid min-w-0 gap-2">
          <label className="grid min-w-0 gap-1">
            <span className="text-muted-foreground">AI client</span>
            <select
              className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled
              value="codex"
            >
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="text-muted-foreground">Model</span>
            <select
              className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={!localAgentReady || saving}
              onChange={(event) => {
                const model = event.target.value;
                const option = modelOptions.find(
                  (item) => item.model === model
                );
                setDraft((current) => ({
                  ...current,
                  model,
                  reasoningEffort:
                    option?.defaultReasoningEffort ??
                    option?.supportedReasoningEfforts[0]?.reasoningEffort ??
                    current.reasoningEffort
                }));
              }}
              value={draft.model}
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.model}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="text-muted-foreground">Reasoning</span>
            <select
              className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={!localAgentReady || saving}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  reasoningEffort: event.target.value
                }))
              }
              value={draft.reasoningEffort}
            >
              {reasoningOptions.map((option) => (
                <option
                  key={option.reasoningEffort}
                  value={option.reasoningEffort}
                >
                  {option.reasoningEffort}
                </option>
              ))}
            </select>
          </label>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <label className="grid min-w-0 gap-1">
              <span className="text-muted-foreground">Timeout</span>
              <input
                className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={saving}
                max={600}
                min={1}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    timeoutMs: Math.max(
                      1_000,
                      Math.min(600_000, Number(event.target.value) * 1000)
                    )
                  }))
                }
                type="number"
                value={Math.max(1, Math.round(draft.timeoutMs / 1000))}
              />
            </label>
            <label className="grid min-w-0 gap-1">
              <span className="text-muted-foreground">Attempts</span>
              <input
                className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={saving}
                max={25}
                min={1}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    maxAttempts: Math.max(
                      1,
                      Math.min(25, Number(event.target.value))
                    )
                  }))
                }
                type="number"
                value={draft.maxAttempts}
              />
            </label>
          </div>
          {error ? (
            <div className="rounded border border-destructive/30 bg-destructive/8 px-2 py-1 text-destructive-foreground">
              {error}
            </div>
          ) : null}
          <Button
            disabled={!localAgentReady || saving || !draft.model}
            onClick={() => {
              void save();
            }}
            size="sm"
            variant="secondary"
          >
            {saving ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>
      ) : (
        <div className="mt-1 text-muted-foreground">Waiting for bridge</div>
      )}
    </div>
  );
}

export function MemoryComposer({
  canAsk,
  disabled,
  localAgentReady,
  localAgentSettings,
  manualWorkerConfig,
  onAsk,
  question,
  scopeCommand,
  scopeLocked,
  scopeUnavailable,
  searchDomain,
  selectedThread,
  setManualWorkerConfig,
  setQuestion,
  setSearchDomain
}: {
  canAsk: boolean;
  disabled: boolean;
  localAgentReady: boolean;
  localAgentSettings: LocalMemoryAgentSettings | null;
  manualWorkerConfig: ManualMemoryQuestionWorkerConfig | null;
  onAsk: () => void;
  question: string;
  scopeCommand: MemoryScopeCommand | null;
  scopeLocked: boolean;
  scopeUnavailable: boolean;
  searchDomain: SearchDomain;
  selectedThread: ThreadGroup | undefined;
  setManualWorkerConfig: (value: ManualMemoryQuestionWorkerConfig) => void;
  setQuestion: (value: string) => void;
  setSearchDomain: (value: SearchDomain) => void;
}) {
  const sessionDisabled = !selectedThread;
  const [composerHeight, setComposerHeight] = useState(
    memoryComposerDefaultHeight
  );
  const resizeStateRef = useRef<{
    pointerId: number;
    previousCursor: string;
    previousUserSelect: string;
    rail: HTMLDivElement;
    startHeight: number;
    startY: number;
  } | null>(null);

  const finishResize = useCallback((pointerId?: number) => {
    const resizeState = resizeStateRef.current;
    if (
      !resizeState ||
      (pointerId !== undefined && resizeState.pointerId !== pointerId)
    ) {
      return;
    }
    if (resizeState.rail.hasPointerCapture(resizeState.pointerId)) {
      resizeState.rail.releasePointerCapture(resizeState.pointerId);
    }
    document.body.style.cursor = resizeState.previousCursor;
    document.body.style.userSelect = resizeState.previousUserSelect;
    resizeStateRef.current = null;
  }, []);

  useEffect(() => () => finishResize(), [finishResize]);

  return (
    <div className="shrink-0 border-border border-t bg-background/90 px-3 py-3 backdrop-blur sm:px-5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative rounded-xl border border-border bg-card shadow-lg">
          <div
            aria-label="Resize memory composer"
            aria-orientation="horizontal"
            aria-valuemax={memoryComposerMaxHeight}
            aria-valuemin={memoryComposerMinHeight}
            aria-valuenow={composerHeight}
            className="-top-1 absolute inset-x-0 z-10 flex h-2 cursor-row-resize touch-none items-start justify-center rounded-t-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setComposerHeight((height) =>
                  clampMemoryComposerHeight(height + memoryComposerHeightStep)
                );
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setComposerHeight((height) =>
                  clampMemoryComposerHeight(height - memoryComposerHeightStep)
                );
              } else if (event.key === "Home") {
                event.preventDefault();
                setComposerHeight(memoryComposerMinHeight);
              } else if (event.key === "End") {
                event.preventDefault();
                setComposerHeight(memoryComposerMaxHeight);
              }
            }}
            onLostPointerCapture={(event) => finishResize(event.pointerId)}
            onPointerCancel={(event) => finishResize(event.pointerId)}
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              resizeStateRef.current = {
                pointerId: event.pointerId,
                previousCursor: document.body.style.cursor,
                previousUserSelect: document.body.style.userSelect,
                rail: event.currentTarget,
                startHeight: composerHeight,
                startY: event.clientY
              };
              document.body.style.cursor = "row-resize";
              document.body.style.userSelect = "none";
            }}
            onPointerMove={(event) => {
              const resizeState = resizeStateRef.current;
              if (!resizeState || resizeState.pointerId !== event.pointerId) {
                return;
              }
              event.preventDefault();
              setComposerHeight(
                clampMemoryComposerHeight(
                  resizeState.startHeight + resizeState.startY - event.clientY
                )
              );
            }}
            onPointerUp={(event) => finishResize(event.pointerId)}
            role="separator"
            tabIndex={0}
          >
            <span className="mt-0.5 h-1 w-10 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/40" />
          </div>
          <MemoryComposerEditor
            disabled={disabled}
            height={composerHeight}
            onChange={setQuestion}
            onSubmit={onAsk}
            placeholder="Ask memory about the selected project..."
            value={question}
          />
          <div className="flex flex-wrap items-center gap-2 border-border border-t px-2.5 py-2">
            <SparklesIcon className="size-3.5 text-primary" />
            <ManualAgentSelect
              disabled={disabled}
              localAgentReady={localAgentReady}
              manualWorkerConfig={manualWorkerConfig}
              settings={localAgentSettings}
              setManualWorkerConfig={setManualWorkerConfig}
            />
            <select
              aria-label="Memory search scope"
              className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-70"
              disabled={scopeLocked}
              onChange={(event) => {
                if (!scopeLocked) {
                  setSearchDomain(event.target.value as SearchDomain);
                }
              }}
              value={searchDomain}
            >
              <option value="project">Project</option>
              <option disabled={sessionDisabled} value="session">
                Session
              </option>
              <option value="global">Global</option>
            </select>
            {scopeCommand ? (
              <span className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {scopeCommand.command}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
              {scopeUnavailable
                ? "Select a session to use /session"
                : searchDomain === "session"
                  ? (selectedThread?.name ?? "No session selected")
                  : searchDomain === "project"
                    ? (selectedThread?.projectName ?? "Selected project")
                    : "All visible memory"}
            </span>
            <Button
              disabled={disabled || !canAsk || !localAgentReady}
              onClick={onAsk}
              size="icon-sm"
              variant="default"
            >
              {disabled ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <SendIcon className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function isReasoningEffort(
  value: unknown
): value is ManualMemoryQuestionWorkerConfig["reasoningEffort"] {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function ManualAgentSelect({
  disabled,
  localAgentReady,
  manualWorkerConfig,
  settings,
  setManualWorkerConfig
}: {
  disabled: boolean;
  localAgentReady: boolean;
  manualWorkerConfig: ManualMemoryQuestionWorkerConfig | null;
  settings: LocalMemoryAgentSettings | null;
  setManualWorkerConfig: (value: ManualMemoryQuestionWorkerConfig) => void;
}) {
  const manual = settings?.flows.manualMemoryAnswer;
  const modelOptions = settings?.modelOptions ?? [];
  const selectedModel =
    manualWorkerConfig?.model ?? manual?.model ?? modelOptions[0]?.model ?? "";
  const selectedReasoning =
    manualWorkerConfig?.reasoningEffort ??
    (isReasoningEffort(manual?.reasoningEffort)
      ? manual.reasoningEffort
      : "high");
  const selectedModelOption =
    modelOptions.find((option) => option.model === selectedModel) ?? null;
  const reasoningOptions =
    selectedModelOption &&
    selectedModelOption.supportedReasoningEfforts.length > 0
      ? selectedModelOption.supportedReasoningEfforts
      : [{ reasoningEffort: selectedReasoning }];
  const unavailable = !settings || !localAgentReady || !selectedModel;
  const persist = (
    model: string,
    reasoningEffort: ManualMemoryQuestionWorkerConfig["reasoningEffort"]
  ) => {
    setManualWorkerConfig({
      provider: "codex",
      model,
      reasoningEffort,
      ...(typeof manual?.timeoutMs === "number"
        ? { timeoutMs: manual.timeoutMs }
        : {}),
      ...(typeof manual?.maxAttempts === "number"
        ? { maxAttempts: manual.maxAttempts }
        : {})
    });
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        disabled={disabled || unavailable}
        onValueChange={(value) => {
          if (!value) {
            return;
          }
          const option = modelOptions.find((item) => item.model === value);
          persist(
            value,
            isReasoningEffort(option?.defaultReasoningEffort)
              ? option.defaultReasoningEffort
              : isReasoningEffort(
                    option?.supportedReasoningEfforts[0]?.reasoningEffort
                  )
                ? option.supportedReasoningEfforts[0]!.reasoningEffort
                : selectedReasoning
          );
        }}
        value={selectedModel}
      >
        <SelectTrigger
          aria-label="Manual memory model"
          className="max-w-44"
          size="xs"
          variant="ghost"
        >
          <BotIcon className="size-3.5" />
          <SelectValue>
            {selectedModel ? `Codex · ${selectedModel}` : "Codex unavailable"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {modelOptions.map((option) => (
            <SelectItem hideIndicator key={option.model} value={option.model}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs">{option.label}</span>
                <span className="truncate text-muted-foreground text-[11px]">
                  Codex
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select
        disabled={disabled || unavailable}
        onValueChange={(value) => {
          if (isReasoningEffort(value)) {
            persist(selectedModel, value);
          }
        }}
        value={selectedReasoning}
      >
        <SelectTrigger
          aria-label="Manual memory reasoning effort"
          className="w-24"
          size="xs"
          variant="ghost"
        >
          <SelectValue>{selectedReasoning}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {reasoningOptions.map((option) => (
            <SelectItem
              hideIndicator
              key={option.reasoningEffort}
              value={option.reasoningEffort}
            >
              {option.reasoningEffort}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function MemoryQuestionSidebar({
  groupedQuestions,
  onSelectQuestion,
  queryActive,
  selectedQuestionId
}: {
  groupedQuestions: GroupedMemoryQuestions;
  onSelectQuestion: (questionId: string) => void;
  queryActive: boolean;
  selectedQuestionId: string | null;
}) {
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(["global"])
  );
  const lastAutoExpandedQuestionId = useRef<string | null>(null);
  const total =
    groupedQuestions.global.length +
    groupedQuestions.projects.reduce(
      (count, project) =>
        count +
        project.projectQuestions.length +
        project.sessions.reduce(
          (sessionCount, session) => sessionCount + session.questions.length,
          0
        ),
      0
    );
  const toggleGroup = (groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };
  useEffect(() => {
    if (
      !selectedQuestionId ||
      lastAutoExpandedQuestionId.current === selectedQuestionId
    ) {
      return;
    }
    const groupIds = selectedQuestionGroupIds(
      groupedQuestions,
      selectedQuestionId
    );
    if (groupIds.length === 0) {
      return;
    }
    lastAutoExpandedQuestionId.current = selectedQuestionId;
    setExpandedGroupIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const groupId of groupIds) {
        if (!next.has(groupId)) {
          changed = true;
          next.add(groupId);
        }
      }
      return changed ? next : current;
    });
  }, [groupedQuestions, selectedQuestionId]);
  const groupIsExpanded = (groupId: string) =>
    queryActive || expandedGroupIds.has(groupId);

  return (
    <>
      {total === 0 ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <div className="px-3 py-8 text-center text-muted-foreground text-sm">
              No memory questions yet.
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      {groupedQuestions.global.length > 0 ? (
        <SidebarGroup>
          <MemoryQuestionGroupButton
            count={groupedQuestions.global.length}
            expanded={groupIsExpanded("global")}
            icon={<SparklesIcon className="size-3.5" />}
            label="Global"
            onClick={() => toggleGroup("global")}
          />
          {groupIsExpanded("global") ? (
            <SidebarGroupContent>
              <MemoryQuestionMenu
                onSelectQuestion={onSelectQuestion}
                questions={groupedQuestions.global}
                selectedQuestionId={selectedQuestionId}
              />
            </SidebarGroupContent>
          ) : null}
        </SidebarGroup>
      ) : null}
      {groupedQuestions.projects.map((project) => {
        const projectCount =
          project.projectQuestions.length +
          project.sessions.reduce(
            (count, session) => count + session.questions.length,
            0
          );
        const projectGroupId = `project:${project.id}`;
        const projectExpanded = groupIsExpanded(projectGroupId);
        return (
          <SidebarGroup key={project.id}>
            <MemoryQuestionGroupButton
              count={projectCount}
              expanded={projectExpanded}
              icon={<SparklesIcon className="size-3.5" />}
              label={project.name}
              onClick={() => toggleGroup(projectGroupId)}
            />
            {projectExpanded ? (
              <SidebarGroupContent>
                {project.projectQuestions.length > 0 ? (
                  <MemoryQuestionMenu
                    onSelectQuestion={onSelectQuestion}
                    questions={project.projectQuestions}
                    selectedQuestionId={selectedQuestionId}
                  />
                ) : null}
                {project.sessions.map((session) => {
                  const sessionGroupId = `session:${project.id}:${session.id}`;
                  const sessionExpanded = groupIsExpanded(sessionGroupId);
                  return (
                    <div className="mt-2" key={session.id}>
                      <MemoryQuestionGroupButton
                        count={session.questions.length}
                        dense
                        expanded={sessionExpanded}
                        label={session.name}
                        onClick={() => toggleGroup(sessionGroupId)}
                      />
                      {sessionExpanded ? (
                        <MemoryQuestionMenu
                          onSelectQuestion={onSelectQuestion}
                          questions={session.questions}
                          selectedQuestionId={selectedQuestionId}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </SidebarGroupContent>
            ) : null}
          </SidebarGroup>
        );
      })}
    </>
  );
}

function selectedQuestionGroupIds(
  groupedQuestions: GroupedMemoryQuestions,
  questionId: string
) {
  if (groupedQuestions.global.some((question) => question.id === questionId)) {
    return ["global"];
  }
  for (const project of groupedQuestions.projects) {
    if (
      project.projectQuestions.some((question) => question.id === questionId)
    ) {
      return [`project:${project.id}`];
    }
    const session = project.sessions.find((candidate) =>
      candidate.questions.some((question) => question.id === questionId)
    );
    if (session) {
      return [`project:${project.id}`, `session:${project.id}:${session.id}`];
    }
  }
  return [];
}

function MemoryQuestionGroupButton({
  count,
  dense = false,
  expanded,
  icon,
  label,
  onClick
}: {
  count: number;
  dense?: boolean;
  expanded: boolean;
  icon?: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      className={cn(
        "flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        dense && "h-7 pl-4"
      )}
      onClick={onClick}
      type="button"
    >
      {expanded ? (
        <ChevronDownIcon className="size-3.5 shrink-0" />
      ) : (
        <ChevronRightIcon className="size-3.5 shrink-0" />
      )}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground/70">{count}</span>
    </button>
  );
}

function MemoryQuestionMenu({
  onSelectQuestion,
  questions,
  selectedQuestionId
}: {
  onSelectQuestion: (questionId: string) => void;
  questions: MemoryQuestionRecord[];
  selectedQuestionId: string | null;
}) {
  return (
    <SidebarMenu>
      {questions.map((question) => (
        <SidebarMenuItem key={question.id}>
          <SidebarMenuButton
            className="h-auto items-start py-2"
            isActive={question.id === selectedQuestionId}
            onClick={() => onSelectQuestion(question.id)}
          >
            <MemoryQuestionStatusIcon status={question.status} />
            <span className="min-w-0">
              <span className="block truncate text-sm">{question.query}</span>
              <span className="block truncate text-muted-foreground text-xs">
                {memoryQuestionOriginLabel(question)} -{" "}
                {formatDate(question.createdAt)} - {question.retrievalScope}
              </span>
              <span className="block truncate text-muted-foreground/75 text-xs">
                {memoryQuestionPreview(question)}
              </span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function MemoryQuestionStatusIcon({
  status
}: {
  status: MemoryQuestionStatus;
}) {
  if (status === "pending") {
    return <Spinner className="mt-0.5 size-4 text-primary" aria-hidden />;
  }
  if (status === "error") {
    return <CircleAlertIcon className="mt-0.5 size-4 text-destructive" />;
  }
  return <SparklesIcon className="mt-0.5 size-4 text-primary" />;
}

function memoryQuestionOriginLabel(question: MemoryQuestionRecord) {
  return question.origin === "mcp_memory_answer"
    ? "MCP memory answer"
    : "Explorer ask";
}

const memoryQuestionPendingPhrases = [
  "Searching",
  "Gathering",
  "Reading",
  "Tracing",
  "Reviewing",
  "Considering",
  "Distilling",
  "Koeding",
  "Composing"
] as const;

function MemoryQuestionPendingStatus() {
  const [phraseIndex, setPhraseIndex] = useState(() =>
    Math.floor(Math.random() * memoryQuestionPendingPhrases.length)
  );
  const [visibleLength, setVisibleLength] = useState(1);

  useEffect(() => {
    const phrase = memoryQuestionPendingPhrases[phraseIndex]!;
    const delay = visibleLength >= phrase.length ? 850 : 32;
    const timeout = window.setTimeout(() => {
      if (visibleLength >= phrase.length) {
        setPhraseIndex((current) => {
          if (memoryQuestionPendingPhrases.length < 2) {
            return current;
          }
          const offset =
            1 +
            Math.floor(
              Math.random() * (memoryQuestionPendingPhrases.length - 1)
            );
          return (current + offset) % memoryQuestionPendingPhrases.length;
        });
        setVisibleLength(1);
        return;
      }
      setVisibleLength((current) => current + 1);
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [phraseIndex, visibleLength]);

  const phrase = memoryQuestionPendingPhrases[phraseIndex]!;
  const visibleText = phrase.slice(0, visibleLength);

  return (
    <>
      <span className="sr-only">Searching memory...</span>
      <span className="inline-block min-w-[5.75rem]" aria-hidden>
        {visibleText}
      </span>
    </>
  );
}

export function MemoryQuestionDetail({
  question
}: {
  question: MemoryQuestionRecord;
}) {
  const evidence = questionEvidence(question);
  const retrieval = questionRetrieval(question);

  return (
    <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/8 text-primary">
        <SparklesIcon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">
            {memoryQuestionOriginLabel(question)}
          </span>
          <span>{question.searchDomain}</span>
          <span>{question.retrievalScope}</span>
          <span>{formatDate(question.createdAt)}</span>
          {evidence.length > 0 ? (
            <span>{evidence.length} evidence items</span>
          ) : null}
        </div>
        <div className="mb-3 rounded-lg border border-border bg-card/60 px-3 py-2 text-muted-foreground text-sm">
          {question.query}
        </div>
        {question.status === "pending" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2 text-muted-foreground text-sm">
            <Spinner className="size-4 text-primary" aria-hidden />
            <MemoryQuestionPendingStatus />
          </div>
        ) : null}
        {question.status === "error" ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive-foreground text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              {question.errorMessage ??
                question.error ??
                "Memory answer failed."}
            </span>
          </div>
        ) : null}
        {question.status === "answered" ? (
          <KoedMarkdown
            text={question.answerMarkdown ?? question.response?.markdown ?? ""}
          />
        ) : null}
        {retrieval ? (
          <div className="mt-3 flex flex-wrap gap-2 text-muted-foreground text-xs">
            {"mode" in retrieval && retrieval.mode ? (
              <span>{retrieval.mode}</span>
            ) : null}
            {"retrievalMode" in retrieval && retrieval.retrievalMode ? (
              <span>{retrieval.retrievalMode}</span>
            ) : null}
            {"vectorHitsCount" in retrieval &&
            typeof retrieval.vectorHitsCount === "number" ? (
              <span>{retrieval.vectorHitsCount} vector hits</span>
            ) : null}
            {"textHitsCount" in retrieval &&
            typeof retrieval.textHitsCount === "number" ? (
              <span>{retrieval.textHitsCount} text hits</span>
            ) : null}
          </div>
        ) : null}
        {evidence.length > 0 ? (
          <details className="mt-3 rounded-lg border border-border bg-card/50 px-3 py-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Evidence returned by Koed
            </summary>
            <div className="mt-2 space-y-2">
              {evidence.slice(0, 10).map((item, index) => (
                <div
                  className="rounded-md bg-secondary/40 p-2"
                  key={`${item.nodeId ?? item.sourceId ?? "evidence"}:${index}`}
                >
                  <div className="mb-1 flex flex-wrap gap-2 text-muted-foreground">
                    <span>#{index + 1}</span>
                    {item.visibility ? <span>{item.visibility}</span> : null}
                    {item.lcmNodeSummaryStatus ? (
                      <span>{item.lcmNodeSummaryStatus}</span>
                    ) : null}
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {item.summaryText
                      ? codexIdePromptUserText(item.summaryText)
                      : "No summary text"}
                  </p>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function LcmNodeCard({
  expanded,
  node,
  onToggle
}: {
  expanded: boolean;
  node: GraphNode;
  onToggle: () => void;
}) {
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <article className="rounded-lg border border-border bg-card/60">
      <button
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
        onClick={onToggle}
        type="button"
      >
        <ToggleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2 text-xs">
            <strong>
              {node.kind} depth {node.depth}
            </strong>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5",
                node.summaryStatus === "pending"
                  ? "bg-warning/12 text-warning-foreground"
                  : "bg-success/12 text-success-foreground"
              )}
            >
              {node.summaryStatus}
            </span>
          </span>
          <span
            className={cn(
              "mt-1 block text-muted-foreground text-xs leading-relaxed",
              !expanded && "line-clamp-3"
            )}
          >
            {node.summaryText}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="border-border border-t px-3 py-2 text-muted-foreground text-[11px]">
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
            <dt>Sources</dt>
            <dd>{node.sourceEventCount}</dd>
            <dt>Embeddings</dt>
            <dd>{node.embeddingCount}</dd>
            <dt>Model</dt>
            <dd className="truncate">{node.summaryModel ?? "placeholder"}</dd>
            <dt>Prompt</dt>
            <dd className="truncate">
              {node.summaryPromptVersion ?? "unknown"}
            </dd>
            <dt>ID</dt>
            <dd className="truncate">{node.id}</dd>
          </dl>
        </div>
      ) : null}
    </article>
  );
}

export { firstLine, formatDate, memoryQuestionPreview };
