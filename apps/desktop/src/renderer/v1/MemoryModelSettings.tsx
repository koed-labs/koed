import { useState } from "react";
import { Button, Card } from "@koed/ui";
import { ProjectChoice } from "./project-management/controls.js";
import { useMemoryModel, type MemoryModelApi } from "./use-memory-model.js";
import "./memory-model-settings.css";

export function MemoryModelSettings({ api }: { api?: MemoryModelApi }) {
  const picker = useMemoryModel(api);
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
      {picker.hasClients ? (
        <Card>
          {picker.fields.map((field) => (
            <div key={field.label} className="memory-model-row">
              <span>{field.label}</span>
              <ProjectChoice
                {...field}
                portalContainer={portal}
                disabled={
                  picker.saving || !api?.setMemoryModel || !field.options.length
                }
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
      {picker.unavailable && (
        <p role="status">
          The configured model or reasoning level is unavailable.
        </p>
      )}
      {picker.saved && (
        <p role="status">Memory Model saved for all four tasks.</p>
      )}
      {picker.error && <p role="alert">{picker.error}</p>}
    </section>
  );
}
