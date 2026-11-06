import { useEffect, useRef, useState } from "react";
import {
  localAiClientDefaultSpec,
  memoryModelFlowKeys
} from "@koed/shared/ai-client-flow-defaults";
import type { DesktopApi } from "../../types.js";
import type {
  LocalAiClientReadModel,
  MemoryModelInput
} from "../../ipc/local-ai-client-protocol.js";
import {
  assignmentFrom,
  modelLabel,
  snapshotFor,
  statusFor
} from "../views/preferences/local-ai-client-settings-helpers.js";

type Selection = Omit<MemoryModelInput, "limits">;
export type MemoryModelApi = Pick<
  NonNullable<DesktopApi["localAiClients"]>,
  "list" | "refresh" | "setMemoryModel"
>;
const matches = (a: Selection | null, b: Selection | null) =>
  !!a &&
  !!b &&
  a.provider === b.provider &&
  a.ai_client_instance_id === b.ai_client_instance_id &&
  a.model === b.model &&
  a.reasoning_effort === b.reasoning_effort;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// Claude can report a versioned display name but require an alias such as "haiku" to run it.
const onboardingModelNames = {
  codex: /(?:^|\/)(?:gpt[ -])?6[ -]luna$/i,
  claude:
    /(?:^|\/)(?:claude[ -])?(?:haiku[ -]5[.-]5|5[.-]5[ -]haiku)(?:-\d{8})?(?:\[1m\]| \(1m context\))?$/i
};
const onboardingModelLabel = (model: Parameters<typeof modelLabel>[0]) =>
  modelLabel(model)
    .replace(/\s*\(recommended\)$/i, "")
    .trim() ||
  model.model ||
  model.id;

function executionLimits(read: LocalAiClientReadModel) {
  const limits: Partial<MemoryModelInput["limits"]> = {};
  for (const key of memoryModelFlowKeys) {
    const limit =
      assignmentFrom(read, key) ?? read.defaults[key].executionLimits;
    if (
      !limit ||
      limit.timeout_ms < 1_000 ||
      limit.timeout_ms > 1_800_000 ||
      limit.max_attempts < 1 ||
      limit.max_attempts > 25
    ) {
      const prefix = localAiClientDefaultSpec[key].prefix;
      const timeout =
        key === "mcp_memory_answer" ? "HARD_TIMEOUT_MS" : "TIMEOUT_MS";
      return {
        error: `Check ${prefix}_${timeout} (1,000–1,800,000 milliseconds) and ${prefix}_MAX_ATTEMPTS (1–25) in the installation configuration.`,
        limits: null
      };
    }
    limits[key] = {
      timeout_ms: limit.timeout_ms,
      max_attempts: limit.max_attempts
    };
  }
  return { error: "", limits: limits as MemoryModelInput["limits"] };
}

export function useMemoryModel(
  api?: MemoryModelApi,
  connectedProviders?: readonly Selection["provider"][]
) {
  const [read, setRead] = useState<LocalAiClientReadModel | null>(null);
  const [draft, setDraft] = useState<Selection | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const [saved, setSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(!!api);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setRead(null);
    setDraft(null);
    setSaved(false);
    setSaveError("");
    setLoadError("");
    setRefreshing(!!api);
    if (api)
      void (async () => {
        try {
          const cached = await api.list();
          if (!active) return;
          setRead(cached.readModel);
          const latest = await api.refresh();
          if (active) {
            setRead(latest.readModel);
            setLoadError(latest.refreshError ?? "");
          }
        } catch (cause) {
          if (active) setLoadError(errorText(cause));
        } finally {
          if (active) setRefreshing(false);
        }
      })();
    return () => {
      active = false;
    };
  }, [api, revision]);

  const assignments = read
    ? memoryModelFlowKeys.map((key) => assignmentFrom(read, key))
    : [];
  const first = assignments[0] ?? null;
  const common = assignments.every((item) => matches(item, first))
    ? first
    : null;
  const modelsFor = (id: string) =>
    read
      ? (snapshotFor(read, id)?.models.filter(
          (m) =>
            m.reasoningEfforts.length &&
            !(
              connectedProviders &&
              (m.model ?? m.id).split("/").at(-1)?.toLowerCase() === "default"
            )
        ) ?? [])
      : [];
  const eligible =
    read?.instances.filter(
      (i) =>
        statusFor(read, i.instanceId).available &&
        modelsFor(i.instanceId).length
    ) ?? [];
  const instances = connectedProviders
    ? connectedProviders.flatMap((provider) =>
        eligible.filter((instance) => instance.driverId === provider)
      )
    : eligible;
  type Instance = (typeof instances)[number];
  const selectionFor = (
    instance: Instance,
    model: ReturnType<typeof modelsFor>[number],
    effort?: string
  ): Selection => ({
    provider: instance.driverId,
    ai_client_instance_id: instance.instanceId,
    model: model.id,
    reasoning_effort:
      effort && model.reasoningEfforts.includes(effort)
        ? effort
        : connectedProviders && model.reasoningEfforts.includes("medium")
          ? "medium"
          : model.reasoningEfforts[0]!
  });
  function startingSelection(instance: Instance, previousEffort?: string) {
    const models = modelsFor(instance.instanceId);
    if (!connectedProviders || instance.driverId === "pi") {
      return selectionFor(instance, models[0]!, previousEffort);
    }
    const pattern = onboardingModelNames[instance.driverId];
    const preferred = models.find((model) =>
      [model.id, model.model, onboardingModelLabel(model), model.fullId].some(
        (name) => name && pattern.test(name.trim())
      )
    );
    return selectionFor(instance, preferred ?? models[0]!);
  }

  // A saved choice takes precedence over first-run suggestions.
  let initial: Selection | null = common;
  if (connectedProviders) {
    const persisted =
      read &&
      memoryModelFlowKeys.every((key) =>
        read.settings.some((s) => s.flowKey === key)
      );
    const current = instances.find(
      (i) =>
        i.instanceId === common?.ai_client_instance_id &&
        i.driverId === common.provider
    );
    const reusable =
      current &&
      common &&
      modelsFor(current.instanceId).some(
        (m) =>
          m.id === common.model &&
          m.reasoningEfforts.includes(common.reasoning_effort)
      );
    if (!persisted || !reusable) {
      initial = instances[0] ? startingSelection(instances[0]) : null;
    }
  }
  const choice = draft ?? initial;
  const instance = instances.find(
    (i) =>
      i.instanceId === choice?.ai_client_instance_id &&
      i.driverId === choice.provider
  );
  const models = instance ? modelsFor(instance.instanceId) : [];
  const model = models.find((m) => m.id === choice?.model);
  const effort = model?.reasoningEfforts.find(
    (e) => e === choice?.reasoning_effort
  );
  const execution = read && executionLimits(read);
  const edit = (next: Selection) => {
    setDraft(next);
    setSaved(false);
    setSaveError("");
  };
  const fields = [
    {
      label: "AI Client",
      value: instance?.instanceId ?? null,
      placeholder: connectedProviders
        ? "Choose a connected client"
        : "Choose an AI Client",
      options: instances.map((i) => ({
        label: i.displayName,
        value: i.instanceId
      })),
      onChange: (id: string) => {
        const next = instances.find((i) => i.instanceId === id);
        if (next)
          edit(
            startingSelection(
              next,
              connectedProviders ? undefined : choice?.reasoning_effort
            )
          );
      }
    },
    {
      label: "Model",
      value: model?.id ?? null,
      placeholder:
        connectedProviders && !instance
          ? "Choose an AI Client first"
          : "Choose a model",
      options: models.map((m) => ({
        value: m.id,
        label: connectedProviders ? onboardingModelLabel(m) : modelLabel(m)
      })),
      onChange: (id: string) => {
        const next = models.find((m) => m.id === id);
        if (instance && next)
          edit(selectionFor(instance, next, choice?.reasoning_effort));
      }
    },
    {
      label: "Reasoning",
      value: effort ?? null,
      placeholder:
        connectedProviders && !model
          ? "Choose a model first"
          : "Choose reasoning",
      options: (model?.reasoningEfforts ?? []).map((e) => ({
        value: e,
        label:
          e === "xhigh" ? "Extra high" : e.charAt(0).toUpperCase() + e.slice(1)
      })),
      onChange: (value: string) => {
        if (choice) edit({ ...choice, reasoning_effort: value });
      }
    }
  ] as const;
  const canSave =
    !!(
      api?.setMemoryModel &&
      instance &&
      model &&
      effort &&
      execution?.limits
    ) &&
    !saving &&
    !refreshing;
  async function save() {
    if (
      !canSave ||
      !api?.setMemoryModel ||
      !choice ||
      !execution?.limits ||
      writing.current
    )
      return false;
    writing.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const response = await api.setMemoryModel({
        provider: choice.provider,
        ai_client_instance_id: choice.ai_client_instance_id,
        model: choice.model,
        reasoning_effort: choice.reasoning_effort,
        limits: execution.limits
      });
      setRead(response.readModel);
      setDraft(null);
      setSaved(true);
      return true;
    } catch (cause) {
      setSaveError(errorText(cause));
      return false;
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }
  return {
    fields,
    hasClients: !!instances.length,
    canSave,
    save,
    saved,
    saving,
    refreshing,
    unchanged: matches(choice, common),
    mixed: !!read && !common && !draft,
    unavailable: !!common && !draft && (!model || !effort),
    loadError,
    error: saveError || execution?.error || loadError,
    retry: () => setRevision((n) => n + 1)
  };
}
