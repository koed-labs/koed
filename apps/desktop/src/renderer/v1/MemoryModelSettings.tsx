import { useState } from "react";
import { Button, Card } from "@koed-labs/ui";
import { ProjectChoice } from "./project-management/controls.js";
import type { useMemoryModel } from "./use-memory-model.js";
import { clients, type ClientId } from "./onboarding/model.js";
import type { savedMemoryModelProblems } from "./client-health.js";
import "./memory-model-settings.css";

export function MemoryModelSettings({
  picker,
  writable,
  problems,
  onCheck,
  busy
}: {
  picker: ReturnType<typeof useMemoryModel>;
  writable: boolean;
  problems: ReturnType<typeof savedMemoryModelProblems>;
  onCheck: (id: ClientId) => void;
  busy: boolean;
}) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
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
      {picker.savedSelections.length > 0 && (
        <p>
          Saved:{" "}
          {Array.from(
            new Set(
              picker.savedSelections.map(
                (setting) =>
                  `${clients.find(({ id }) => id === setting.provider)?.label} · ${setting.model} · ${setting.reasoningEffort}`
              )
            )
          ).join("; ")}
        </p>
      )}
      {picker.hasClients ? (
        <Card>
          {picker.fields.map((field) => (
            <div key={field.label} className="memory-model-row">
              <span>{field.label}</span>
              <ProjectChoice
                {...field}
                portalContainer={portal}
                disabled={picker.saving || !writable || !field.options.length}
              />
            </div>
          ))}
          <div className="memory-model-footer">
            <Button
              size="sm"
              disabled={!picker.canSave || picker.unchanged}
              onClick={() => void picker.save()}
            >
              {picker.saving ? "Saving…" : "Save Memory Model"}
            </Button>
          </div>
        </Card>
      ) : (
        <p role="status">
          {picker.refreshing
            ? "Loading AI Clients…"
            : "Connect an authenticated AI Client that supports local synthesis to choose a Memory Model."}
        </p>
      )}
      {picker.mixed && (
        <p role="status">
          The memory tasks have different assignments. Choose a model to apply
          it to all four.
        </p>
      )}
      {problems.length > 0 && (
        <div>
          <p role="alert">
            {Array.from(
              new Set(
                problems.map(({ model, reason }) => `${model}: ${reason}`)
              )
            ).join(" ")}
          </p>
          {Array.from(new Set(problems.map(({ provider }) => provider))).map(
            (id) => (
              <Button
                key={id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onCheck(id)}
              >
                Check {clients.find((client) => client.id === id)?.label} again
              </Button>
            )
          )}
        </div>
      )}
      {picker.saved && (
        <p role="status">Memory Model saved for all four tasks.</p>
      )}
      {picker.loadError && (
        <p role="status">
          Couldn’t check model availability.{" "}
          <Button size="sm" variant="outline" onClick={() => picker.retry()}>
            Check models again
          </Button>
        </p>
      )}
      {picker.settingsError && <p role="alert">{picker.settingsError}</p>}
    </section>
  );
}
