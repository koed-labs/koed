import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Collapsible,
  Separator,
  Slider
} from "@koed-labs/ui";
import {
  Check,
  ChevronDown,
  Gauge,
  Leaf,
  RotateCcw,
  SlidersHorizontal,
  Zap
} from "lucide-react";
import {
  resourceProfileValues,
  type PerformancePreference,
  type ResourceProfile,
  type ResourceValues
} from "@koed-labs/server/performance";
import type { DesktopPerformanceApi } from "@koed-labs/server";
import { PageHeading } from "./settings-controls.js";
import { usePerformance } from "./use-performance.js";
import "./performance-settings.css";

const profiles = [
  {
    id: "low",
    label: "Low",
    icon: Leaf,
    description: "Give other apps priority. Memory indexing may take longer."
  },
  {
    id: "balanced",
    label: "Balanced",
    icon: Gauge,
    description: "Keep Memory moving while leaving room for other work."
  },
  {
    id: "full",
    label: "Full",
    icon: Zap,
    description: "Use all available CPU threads for embedding work."
  }
] as const;
const fields = [
  {
    key: "backgroundNice",
    label: "Background priority",
    description: "How much priority Koed gets when other apps need the CPU."
  },
  {
    key: "embeddingThreads",
    label: "Embedding threads",
    description: "CPU threads available to the Embedding Service."
  },
  {
    key: "transcriptPollMs",
    label: "Transcript checks",
    description:
      "How often Koed checks for new Codex transcripts. This currently applies to Codex only."
  }
] as const;
const priorityLabel = (value: number) =>
  value === 0 ? "Normal" : value >= 15 ? "Lowest" : "Reduced";
const valueLabel = (key: keyof ResourceValues, value: number) =>
  key === "backgroundNice"
    ? priorityLabel(value)
    : key === "embeddingThreads"
      ? `${value} ${value === 1 ? "thread" : "threads"}`
      : `Every ${value / 1000} s`;
const equal = (a: PerformancePreference, b: PerformancePreference) =>
  a.profile === b.profile &&
  fields.every(({ key }) => a.overrides[key] === b.overrides[key]);

export function PerformanceSettings({
  onBack,
  api,
  onApplied
}: {
  onBack: () => void;
  api?: DesktopPerformanceApi;
  onApplied?: () => void;
}) {
  const { snapshot, operation, error, busy, available, inspect, apply } =
    usePerformance(api);
  const [draft, setDraft] = useState<{
    preference: PerformancePreference;
    revision: string;
  } | null>(null);
  useEffect(() => {
    if (operation?.state === "complete") {
      setDraft(null);
      onApplied?.();
    }
  }, [operation?.id, operation?.state]);
  const preference = draft?.preference ?? snapshot?.preference;
  const changed =
    !!snapshot && !!draft && !equal(draft.preference, snapshot.preference);
  const stale = changed && draft?.revision !== snapshot?.revision;
  const disabled =
    busy ||
    !!error ||
    !snapshot ||
    !!snapshot.readOnlyReason ||
    !["running", "stopped"].includes(snapshot.runtimeState);
  const selectProfile = (profile: ResourceProfile) => {
    if (!snapshot) return;
    setDraft({
      preference: { profile, overrides: {} },
      revision: changed ? draft!.revision : snapshot.revision
    });
  };
  const changeValue = (key: keyof ResourceValues, value: number) => {
    if (!snapshot || !preference) return;
    const overrides = { ...preference.overrides };
    if (
      value ===
      resourceProfileValues(preference.profile, snapshot.cpuCount)[key]
    )
      delete overrides[key];
    else overrides[key] = value;
    setDraft({
      preference: { ...preference, overrides },
      revision: changed ? draft!.revision : snapshot.revision
    });
  };
  const values =
    snapshot && preference
      ? {
          ...resourceProfileValues(preference.profile, snapshot.cpuCount),
          ...preference.overrides
        }
      : null;
  if (snapshot && values)
    for (const { key } of fields)
      if (snapshot.managed[key]) values[key] = snapshot.effective[key];
  const message =
    error ??
    (operation && ["failed", "interrupted"].includes(operation.state)
      ? operation.message
      : null);
  return (
    <>
      <div className="performance-scroll">
        <PageHeading page="performance" onBack={onBack} />
        {!available ? (
          <p role="status">
            Performance settings are unavailable in this window.
          </p>
        ) : !snapshot && !error ? (
          <p role="status">Loading performance settings…</p>
        ) : null}
        {snapshot && preference && values && (
          <>
            {snapshot.readOnlyReason && (
              <p className="performance-notice" role="status">
                {snapshot.readOnlyReason}
              </p>
            )}
            <div className="performance-section-label">
              <h3>Resource profile</h3>
              <span>
                {snapshot.profileManaged
                  ? "Managed by the environment"
                  : `${snapshot.cpuCount} logical CPUs`}
              </span>
            </div>
            <div
              className="performance-profiles"
              role="group"
              aria-label="Resource profile"
            >
              {profiles.map(({ id, label, description, icon: Icon }) => (
                <Card
                  key={id}
                  className="performance-profile"
                  data-selected={preference.profile === id}
                >
                  <Button
                    variant="ghost"
                    className="performance-profile-button"
                    aria-pressed={preference.profile === id}
                    disabled={disabled || snapshot.profileManaged}
                    onClick={() => selectProfile(id)}
                  >
                    <span className="performance-profile-icon">
                      <Icon />
                      {preference.profile === id && <Check />}
                    </span>
                    <span className="performance-profile-title">
                      {label}
                      {id === "balanced" && (
                        <Badge variant="outline">Default</Badge>
                      )}
                    </span>
                    <span className="performance-profile-description">
                      {description}
                    </span>
                    <span className="performance-profile-detail">
                      {
                        resourceProfileValues(id, snapshot.cpuCount)
                          .embeddingThreads
                      }{" "}
                      CPU threads
                    </span>
                  </Button>
                </Card>
              ))}
            </div>
            <div className="performance-section-label performance-values-heading">
              <h3>{changed ? "After applying" : "Effective settings"}</h3>
            </div>
            <Card className="performance-values">
              {fields.map(({ key, label }) => (
                <div className="performance-value" key={key}>
                  <span>{label}</span>
                  <div>
                    <strong>
                      {snapshot.managed[key]?.includes("external")
                        ? "Managed externally"
                        : valueLabel(key, values[key])}
                    </strong>
                    {(snapshot.managed[key] ||
                      preference.overrides[key] !== undefined) && (
                      <small>{snapshot.managed[key] ?? "Custom value"}</small>
                    )}
                    {snapshot.invalid?.[key] && (
                      <small role="alert">{snapshot.invalid[key]}</small>
                    )}
                  </div>
                </div>
              ))}
            </Card>
            <Card className="performance-individual">
              <Collapsible.Root>
                <Collapsible.Trigger
                  render={<Button variant="ghost" />}
                  className="performance-disclosure"
                >
                  <SlidersHorizontal />
                  Individual settings
                  <ChevronDown />
                </Collapsible.Trigger>
                <Collapsible.Panel className="performance-individual-body">
                  <Separator />
                  {fields.map(({ key, label, description }) => {
                    const value = values[key];
                    const locked =
                      disabled ||
                      !!snapshot.managed[key] ||
                      (key === "embeddingThreads" && snapshot.cpuCount === 1);
                    return (
                      <div className="performance-slider-row" key={key}>
                        <div>
                          <strong>{label}</strong>
                          <p>{description}</p>
                        </div>
                        <div className="performance-slider-control">
                          <Slider
                            label={label}
                            valueText={valueLabel(key, value)}
                            disabled={locked}
                            min={
                              key === "backgroundNice"
                                ? 0
                                : key === "transcriptPollMs"
                                  ? Math.min(1, value / 1000)
                                  : 1
                            }
                            max={
                              key === "backgroundNice"
                                ? 19
                                : key === "embeddingThreads"
                                  ? Math.max(2, snapshot.cpuCount, value)
                                  : 60
                            }
                            step={
                              key === "transcriptPollMs" && value % 1000 !== 0
                                ? 0.001
                                : 1
                            }
                            value={
                              key === "backgroundNice"
                                ? 19 - value
                                : key === "transcriptPollMs"
                                  ? value / 1000
                                  : value
                            }
                            onValueChange={(next) =>
                              changeValue(
                                key,
                                key === "backgroundNice"
                                  ? 19 - next
                                  : key === "transcriptPollMs"
                                    ? Math.round(next * 1000)
                                    : next
                              )
                            }
                          />
                          <div className="performance-slider-keys">
                            <span
                              className={
                                key === "backgroundNice" &&
                                priorityLabel(value) === "Lowest"
                                  ? "selected"
                                  : undefined
                              }
                            >
                              {key === "backgroundNice"
                                ? "Lowest"
                                : key === "embeddingThreads"
                                  ? "1"
                                  : `${Math.min(1000, value) / 1000} s`}
                            </span>
                            <span
                              className={
                                key !== "backgroundNice" ||
                                priorityLabel(value) === "Reduced"
                                  ? "selected"
                                  : undefined
                              }
                            >
                              {key === "backgroundNice"
                                ? "Reduced"
                                : valueLabel(key, value)}
                            </span>
                            <span
                              className={
                                key === "backgroundNice" &&
                                priorityLabel(value) === "Normal"
                                  ? "selected"
                                  : undefined
                              }
                            >
                              {key === "backgroundNice"
                                ? "Normal"
                                : key === "embeddingThreads"
                                  ? snapshot.cpuCount
                                  : "60 s"}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </Collapsible.Panel>
              </Collapsible.Root>
            </Card>
            {stale && (
              <p role="alert">
                Settings changed since you started editing. Discard your draft
                to load the latest values.
              </p>
            )}
          </>
        )}
        {message && (
          <p role={error || operation?.state === "failed" ? "alert" : "status"}>
            {message}
          </p>
        )}
        {error && (
          <Button variant="outline" size="sm" onClick={() => void inspect()}>
            Retry
          </Button>
        )}
      </div>
      <footer className="performance-footer">
        <div role="status">
          <RotateCcw size={14} />
          <span>
            {operation?.state === "complete"
              ? operation.message
              : busy
                ? (operation?.message ?? "Checking settings…")
                : snapshot?.runtimeState === "stopped"
                  ? "Preferences apply when local services start."
                  : "Changes apply after restarting local services."}
          </span>
        </div>
        <div className="performance-footer-buttons">
          {changed && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                void inspect();
              }}
            >
              Discard
            </Button>
          )}
          <Button
            size="sm"
            disabled={disabled || !changed || stale}
            onClick={() => {
              if (draft)
                void apply({
                  ...draft.preference,
                  expectedRevision: draft.revision
                });
            }}
          >
            {busy
              ? "Applying…"
              : snapshot?.runtimeState === "stopped"
                ? "Save preference"
                : "Apply & restart"}
          </Button>
        </div>
      </footer>
    </>
  );
}
