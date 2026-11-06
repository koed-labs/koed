import { useEffect, useState } from "react";
import { Button, Card } from "@koed/ui";
import { memoryModelFlowKeys } from "@koed/shared/ai-client-flow-defaults";
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
import { ProjectChoice } from "./project-management/controls.js";
import "./memory-model-settings.css";

type Selection = Omit<MemoryModelInput, "limits">;
type Api = Pick<
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

function executionLimits(
  read: LocalAiClientReadModel
): MemoryModelInput["limits"] | null {
  const limits: Partial<MemoryModelInput["limits"]> = {};
  for (const key of memoryModelFlowKeys) {
    const assignment = assignmentFrom(read, key);
    if (
      !assignment ||
      assignment.timeout_ms < 1_000 ||
      assignment.timeout_ms > 1_800_000 ||
      assignment.max_attempts < 1 ||
      assignment.max_attempts > 25
    )
      return null;
    limits[key] = {
      timeout_ms: assignment.timeout_ms,
      max_attempts: assignment.max_attempts
    };
  }
  return limits as MemoryModelInput["limits"];
}

export function MemoryModelSettings({ api }: { api?: Api }) {
  const [read, setRead] = useState<LocalAiClientReadModel | null>(null);
  const [draft, setDraft] = useState<Selection | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    setRead(null);
    setDraft(null);
    setSaved(false);
    setError("");
    setRefreshing(true);
    if (api)
      void (async () => {
        try {
          const cached = await api.list();
          if (!active) return;
          setRead(cached.readModel);
          const latest = await api.refresh();
          if (active) {
            setRead(latest.readModel);
            setError(latest.refreshError ?? "");
          }
        } catch (cause) {
          if (active) setError(errorText(cause));
        } finally {
          if (active) setRefreshing(false);
        }
      })();
    return () => {
      active = false;
    };
  }, [api]);
  const assignments = read
    ? memoryModelFlowKeys.map((key) => assignmentFrom(read, key))
    : [];
  const first = assignments[0] ?? null;
  const common = assignments.every((item) => matches(item, first))
    ? first
    : null;
  const choice = draft ?? common;
  const instances =
    read?.instances.filter(
      (instance) =>
        statusFor(read, instance.instanceId).available &&
        snapshotFor(read, instance.instanceId)?.models.some(
          (model) => model.reasoningEfforts.length
        )
    ) ?? [];
  const instance = instances.find(
    (i) =>
      i.instanceId === choice?.ai_client_instance_id &&
      i.driverId === choice.provider
  );
  const modelsFor = (id: string) =>
    read
      ? (snapshotFor(read, id)?.models.filter(
          (m) => m.reasoningEfforts.length
        ) ?? [])
      : [];
  const models = instance ? modelsFor(instance.instanceId) : [];
  const model = models.find((m) => m.id === choice?.model);
  const effort = model?.reasoningEfforts.find(
    (value) => value === choice?.reasoning_effort
  );
  const edit = (next: Selection) => {
    setDraft(next);
    setSaved(false);
    setError("");
  };
  const select = (id: string, modelId?: string) => {
    const client = instances.find((i) => i.instanceId === id);
    const available = modelsFor(id);
    const next = modelId
      ? available.find((m) => m.id === modelId)
      : available[0];
    if (!client || !next) return;
    edit({
      provider: client.driverId,
      ai_client_instance_id: id,
      model: next.id,
      reasoning_effort:
        choice && next.reasoningEfforts.includes(choice.reasoning_effort)
          ? choice.reasoning_effort
          : next.reasoningEfforts[0]!
    });
  };
  const limits = read && executionLimits(read);
  const persist = async () => {
    if (
      !api?.setMemoryModel ||
      !choice ||
      !limits ||
      !instance ||
      !model ||
      !effort ||
      saving ||
      refreshing
    )
      return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await api.setMemoryModel({
        provider: instance.driverId,
        ai_client_instance_id: instance.instanceId,
        model: model.id,
        reasoning_effort: effort,
        limits
      });
      setRead(response.readModel);
      setDraft(null);
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  const blocked = saving || !limits || !api?.setMemoryModel;
  const field = (
    label: string,
    value: string | null,
    options: { label: string; value: string }[],
    placeholder: string,
    onChange: (v: string) => void
  ) => (
    <div className="memory-model-row">
      <span>{label}</span>
      <ProjectChoice
        label={label}
        value={value}
        options={options}
        placeholder={placeholder}
        portalContainer={portal}
        disabled={blocked || !options.length}
        onChange={onChange}
      />
    </div>
  );
  return (
    <section
      className="memory-model-settings v1-project-ui"
      aria-label="Memory Model"
      ref={setPortal}
    >
      <h4>Memory Model</h4>
      <p>
        Choose the AI Client and model for Memory Answers from recalled
        evidence, LCM summaries, captured-session titles, and Curated Memory
        reviews.
      </p>
      {read && instances.length > 0 ? (
        <Card>
          {field(
            "AI Client",
            instance?.instanceId ?? null,
            instances.map((i) => ({
              label: i.displayName,
              value: i.instanceId
            })),
            "Choose an AI Client",
            (id) => select(id)
          )}
          {field(
            "Model",
            model?.id ?? null,
            models.map((m) => ({ value: m.id, label: modelLabel(m) })),
            "Choose a model",
            (id) => {
              if (instance) select(instance.instanceId, id);
            }
          )}
          {field(
            "Reasoning",
            effort ?? null,
            (model?.reasoningEfforts ?? []).map((e) => ({
              value: e,
              label:
                e === "xhigh"
                  ? "Extra high"
                  : e.charAt(0).toUpperCase() + e.slice(1)
            })),
            "Choose reasoning",
            (value) => {
              if (choice) edit({ ...choice, reasoning_effort: value });
            }
          )}
          <div className="memory-model-footer">
            <Button
              size="sm"
              disabled={
                blocked || refreshing || !effort || matches(choice, common)
              }
              onClick={() => void persist()}
            >
              {saving ? "Saving…" : "Save Memory Model"}
            </Button>
          </div>
        </Card>
      ) : (
        <p role="status">
          {api && !read && refreshing
            ? "Loading AI Clients…"
            : "Connect an authenticated AI Client that supports local synthesis to choose a Memory Model."}
        </p>
      )}
      {read && !limits ? (
        <p role="status">
          Review this installation’s execution limits before saving a shared
          model.
        </p>
      ) : (
        read &&
        !common &&
        !draft && (
          <p role="status">
            The memory tasks have different assignments. Choose a model to apply
            it to all four.
          </p>
        )
      )}
      {read && common && !draft && (!model || !effort) && (
        <p role="status">
          The configured model or reasoning level is unavailable.
        </p>
      )}
      {saved && <p role="status">Memory Model saved for all four tasks.</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
