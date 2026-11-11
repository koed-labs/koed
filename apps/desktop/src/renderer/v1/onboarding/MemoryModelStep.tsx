import { useEffect, useRef, type RefObject } from "react";
import { AppWindow, Brain, Cpu } from "lucide-react";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from "@koed-labs/ui";
import { useMemoryModel } from "../use-memory-model.js";
import { Arrow } from "./ClientSetup.js";
import type { ClientId } from "./model.js";
import "./memory-model-step.css";

const icons = { "AI Client": AppWindow, Model: Cpu, Reasoning: Brain };
export function MemoryModelStep({
  portalContainer,
  connected,
  onBack,
  onContinue
}: {
  portalContainer: RefObject<HTMLElement | null>;
  connected: readonly ClientId[];
  onBack: () => void;
  onContinue: () => void;
}) {
  const api = window.koedDesktop?.localAiClients;
  const picker = useMemoryModel(api, connected);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const empty = !picker.hasClients && !picker.refreshing && !picker.loadError;
  const setupUnavailable = !api?.setMemoryModel;
  return (
    <div className="lp-client-panel">
      <h1 ref={heading} tabIndex={-1}>
        Choose a Memory Model.
      </h1>
      <p className="lp-client-intro">
        {empty && !setupUnavailable
          ? "Your connected AI Clients have no model available for memory tasks."
          : "Choose the model Koed uses for Memory Answers, summaries, session titles, and Curated Memory reviews."}
      </p>
      {picker.hasClients && !setupUnavailable ? (
        <div className="lp-client-list">
          {picker.fields.map((field) => {
            const Icon = icons[field.label];
            return (
              <div
                key={field.label}
                className="lp-client-card lp-memory-field"
                data-disabled={!field.options.length || undefined}
              >
                <Icon className="lp-memory-icon" aria-hidden="true" />
                <span className="lp-memory-label">{field.label}</span>
                <Select
                  items={field.options}
                  value={field.value}
                  disabled={picker.saving || !field.options.length}
                  onValueChange={(value) => {
                    if (value !== null) field.onChange(value);
                  }}
                >
                  <SelectTrigger
                    aria-label={field.label}
                    className="lp-memory-select"
                  >
                    <SelectValue placeholder={field.placeholder} />
                  </SelectTrigger>
                  <SelectPopup
                    portalContainer={portalContainer}
                    align="end"
                    sideOffset={5}
                    alignItemWithTrigger={false}
                    popupClassName="lp-memory-menu"
                  >
                    {field.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="lp-memory-empty">
          <div className="lp-client-card is-locked" role="status">
            <div className="lp-client-card-top">
              <Cpu className="lp-memory-icon" aria-hidden="true" />
              <div className="lp-client-name">
                <strong>
                  {setupUnavailable
                    ? "Memory Model setup is unavailable"
                    : picker.refreshing
                      ? "Loading AI Clients…"
                      : picker.loadError
                        ? "Could not load AI Clients"
                        : "No models available"}
                </strong>
                {setupUnavailable ? (
                  <small>You can set this up later in Settings.</small>
                ) : (
                  empty && (
                    <small>
                      Connect another AI Client, or choose a model later in
                      Settings.
                    </small>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {picker.error && (
        <p className="lp-error" role="alert">
          {picker.error}
        </p>
      )}
      <div className="lp-client-actions">
        <button
          type="button"
          className="lp-text-button"
          disabled={picker.saving}
          onClick={onBack}
        >
          Back to AI Clients
        </button>
        {setupUnavailable || empty ? (
          <button
            type="button"
            className="lp-primary-button"
            onClick={onContinue}
          >
            Set up later <Arrow />
          </button>
        ) : picker.loadError && !picker.hasClients ? (
          <button
            type="button"
            className="lp-primary-button"
            onClick={picker.retry}
          >
            Try again
          </button>
        ) : (
          <button
            type="button"
            className="lp-primary-button"
            disabled={!picker.canSave}
            onClick={() => {
              void picker.save().then((saved) => {
                if (saved) onContinue();
              });
            }}
          >
            {picker.saving ? "Saving…" : "Save and continue"} <Arrow />
          </button>
        )}
      </div>
    </div>
  );
}
