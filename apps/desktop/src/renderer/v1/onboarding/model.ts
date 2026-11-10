import type {
  DesktopSetupSnapshot,
  DesktopSetupStageId,
  KoedServerStatus
} from "../../../types.js";
import type { AccelerationChoice } from "@koed-labs/server";
import {
  DEFAULT_AGENT_LOOK,
  normalizeAgentLook,
  type AgentLook
} from "../pixelkin/agent-kin.js";

export type OnboardingAgent = { name: string; look: AgentLook };
export type ClientId = "codex" | "claude" | "pi";
export const clients = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "pi", label: "Pi" }
] as const;
export type OnboardingDraft = {
  version: 2;
  step: "setup" | "hardware" | "clients" | "memory-model" | "complete";
  selected: ClientId[];
  selectionInitialized: boolean;
  agent?: OnboardingAgent;
  processing?: AccelerationChoice;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function restoreOnboarding(value: unknown): OnboardingDraft {
  const draft = record(value) ? value : {};
  return {
    version: 2,
    // Legacy drafts always re-enter setup inspection, without their chat transcript.
    step:
      draft.version === 2 &&
      (draft.step === "hardware" ||
        draft.step === "clients" ||
        draft.step === "memory-model" ||
        draft.step === "complete")
        ? draft.step
        : "setup",
    selected: Array.isArray(draft.selected)
      ? clients
          .filter(
            (c) =>
              draft.selected instanceof Array && draft.selected.includes(c.id)
          )
          .map((c) => c.id)
      : [],
    selectionInitialized:
      draft.version === 2 && draft.selectionInitialized === true,
    ...(draft.version === 2 &&
    record(draft.processing) &&
    (draft.processing.preference === "cpu" ||
      draft.processing.preference === "auto") &&
    typeof draft.processing.installCuda === "boolean" &&
    typeof draft.processing.expectedRevision === "string" &&
    /^[a-f0-9]{64}$/.test(draft.processing.expectedRevision)
      ? {
          processing: {
            preference: draft.processing.preference,
            installCuda: draft.processing.installCuda,
            expectedRevision: draft.processing.expectedRevision
          }
        }
      : {})
  };
}
export function restoreAgent(
  saved: OnboardingAgent | null | undefined,
  draft: unknown
): OnboardingAgent {
  const legacy = record(draft) && record(draft.agent) ? draft.agent : null;
  return {
    name:
      saved?.name.trim() ||
      (typeof legacy?.name === "string" && legacy.name.trim().slice(0, 80)) ||
      "Koed",
    look: normalizeAgentLook(
      saved?.name.trim()
        ? saved.look
        : (legacy?.look ?? saved?.look ?? DEFAULT_AGENT_LOOK)
    )
  };
}

// Copy and message cadence follow the retained loading prototype. Progress never uses its demo durations.
export const stages: Record<
  DesktopSetupStageId,
  { name: string; label: string; description: string; messages: string[] }
> = {
  package: {
    name: "Koed package",
    label: "Installing Koed",
    description: "Prepare the local Koed service.",
    messages: [
      "Unpacking a little possibility…",
      "Finding a home for Koed…",
      "Some assembly. No tiny screws."
    ]
  },
  runtime: {
    name: "Local runtime",
    label: "Setting up the local runtime",
    description: "Prepare storage and embedding dependencies.",
    messages: [
      "Making room for your mind…",
      "Putting everything in its place…",
      "Fluffing the memory cushions…"
    ]
  },
  model: {
    name: "Memory models",
    label: "Downloading memory models",
    description: "Verify the models used to protect, index, and recall Memory.",
    messages: [
      "Teaching the dots to connect…",
      "Remembering how to remember…",
      "Giving your future self a head start…",
      "Reticulating recollections…"
    ]
  },
  services: {
    name: "Local services",
    label: "Starting local services",
    description: "Start Personal Memory and background processing.",
    messages: [
      "Waking up the quiet helpers…",
      "A little hum behind the scenes…",
      "Getting the good ideas together…"
    ]
  },
  acceleration: {
    name: "CUDA acceleration",
    label: "Preparing CUDA acceleration",
    description: "Verify GPU offload with the installed embedding model.",
    messages: [
      "A little help from your hardware…",
      "Checking how the dots connect…",
      "Getting your GPU ready…"
    ]
  },
  integration: {
    name: "Koed core integration",
    label: "Connecting Koed components",
    description: "Prepare local credential and MCP artifacts.",
    messages: [
      "Introducing all the moving parts…",
      "Connecting a few useful dots…",
      "Practising our secret handshake…"
    ]
  },
  verification: {
    name: "Verification",
    label: "Running final checks",
    description: "Confirm the complete local setup.",
    messages: [
      "Checking every little thing…",
      "Dotting the i’s. Crossing the memories…",
      "One last check, then we’re yours."
    ]
  }
};
export const stageIds: DesktopSetupStageId[] = [
  "package",
  "runtime",
  "model",
  "services",
  "integration",
  "verification"
];
export function setupState(snapshot: DesktopSetupSnapshot | null) {
  const ids = snapshot?.stages.some(({ id }) => id === "acceleration")
    ? [...stageIds.slice(0, 3), "acceleration" as const, ...stageIds.slice(3)]
    : stageIds;
  const rows = ids.map((id) =>
    snapshot?.stages.find((stage) => stage.id === id)
  );
  const ready =
    snapshot?.state === "complete" &&
    rows.every((row) => row?.state === "complete");
  const activeId =
    snapshot?.activeStage ??
    rows.find((row) => row?.state !== "complete")?.id ??
    "verification";
  const active = rows.find((row) => row?.id === activeId);
  const fraction =
    active?.totalBytes &&
    active.totalBytes > 0 &&
    active.completedBytes !== null
      ? Math.max(0, Math.min(1, active.completedBytes / active.totalBytes))
      : null;
  const done = rows.filter(
    (row) => row?.state === "complete" && (row.id !== "verification" || ready)
  ).length;
  const value = ready
    ? 100
    : Math.min(
        99,
        (100 * (done + (active?.state === "running" ? (fraction ?? 0) : 0))) /
          ids.length
      );
  const formatBytes = (bytes: number) =>
    `${Math.round(bytes / 1_048_576).toLocaleString()} MB`;
  const detail =
    active?.state === "running" &&
    active.completedBytes !== null &&
    active.completedBytes !== undefined
      ? active.progressPhase === "verifying" ||
        active.progressPhase === "complete"
        ? "Checking the download…"
        : active.totalBytes && active.totalBytes > 0
          ? `${formatBytes(active.completedBytes)} of ${formatBytes(active.totalBytes)}`
          : `${formatBytes(active.completedBytes)} downloaded`
      : null;
  return {
    ready,
    activeId,
    copy: stages[activeId],
    index: ids.indexOf(activeId),
    total: ids.length,
    done,
    fraction,
    detail,
    indeterminate:
      fraction === null ||
      active?.progressPhase === "verifying" ||
      active?.progressPhase === "complete",
    value,
    percent: Math.floor(value)
  };
}
export function clientDetected(
  id: ClientId,
  status: KoedServerStatus | null
): boolean {
  const client = status?.aiClients?.[id];
  return (
    !!client &&
    client.snapshotState !== "stale" &&
    // A fresh install can be detected before it has a capability snapshot.
    // Capability and authentication checks still gate clientReady below.
    client.installed.state === "healthy"
  );
}
export function clientReady(
  id: ClientId,
  status: KoedServerStatus | null
): boolean {
  if (
    !status ||
    status.lifecycle?.state === "stopped" ||
    status.lifecycle?.state === "unavailable" ||
    status.api.state !== "healthy"
  )
    return false;
  const client = status.aiClients?.[id];
  return (
    !!client &&
    client.snapshotState !== "stale" &&
    client.snapshotState !== "unknown" &&
    client.profile.state === "healthy" &&
    client.authentication === "authenticated"
  );
}
export function clientCommand(id: ClientId, status: KoedServerStatus | null) {
  const client = status?.aiClients?.[id];
  const missingRegistration = client?.capabilities.some((c) =>
    c.diagnostics.some((d) => d.code === "instance_not_registered")
  );
  if (client?.profile.state === "healthy" && !missingRegistration)
    return `check_${id}` as const;
  const configured =
    client?.profile.state === "needs_attention" ||
    missingRegistration ||
    (id === "codex"
      ? status?.codex.configured
      : id === "claude"
        ? status?.claudeCode?.configured
        : status?.pi?.configured);
  return configured ? (`repair_${id}` as const) : (`setup_${id}` as const);
}
export const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
export function operationError(result: unknown): string | null {
  if (!record(result) || result.ok !== true)
    return record(result)
      ? ([result.message, result.error, result.action].find(
          (v): v is string => typeof v === "string" && !!v
        ) ?? "AI Client connection did not complete.")
      : "AI Client connection did not complete.";
  return null;
}
export function authenticationGuidance(
  id: ClientId,
  status: KoedServerStatus | null
): string {
  const client = status?.aiClients?.[id];
  if (client?.authentication === "unauthenticated")
    return id === "claude"
      ? "Run `claude auth login` in your terminal, then check again. Claude Desktop sign-in does not authenticate Claude Code."
      : id === "pi"
        ? "Authenticate at least one model through Pi, then check again."
        : "Sign in to Codex, then check again.";
  if (client?.profile.state !== "healthy")
    return "The Koed profile is not confirmed ready. Try connecting again.";
  if (client.authentication === "unknown")
    return id === "claude"
      ? "Run `claude auth status`, resolve its error, then check again."
      : id === "pi"
        ? "Fix Pi model discovery, then check again."
        : "Check Codex sign-in, then check again.";
  return "Koed readiness could not be confirmed. Check again.";
}
