import type { StatusCardAction, StatusComponentKey } from "./status-model.js";
import type { ComponentState } from "./types.js";

export interface SettingsOutcomeRow {
  id: string;
  title: string;
  description: string;
  state: ComponentState;
  stateLabel: string;
  summary: string;
  recovery?: {
    action: StatusCardAction;
    componentKey: StatusComponentKey;
    componentLabel: string;
  };
}

export const renderSettingsOutcomeRows = (
  rows: readonly SettingsOutcomeRow[],
  escapeText: (value: string) => string
): string =>
  rows
    .map((row) => {
      const recovery = row.recovery
        ? `<button type="button" class="secondary settings-recovery" data-startup-action="${escapeText(row.recovery.action.command)}" data-status-component="${escapeText(row.recovery.componentKey)}" aria-label="${escapeText(`${row.recovery.action.label} for ${row.title}: ${row.recovery.componentLabel}`)}">${escapeText(row.recovery.action.label)}</button>`
        : "";
      return `<article class="settings-row ${row.state}" data-settings-outcome="${escapeText(row.id)}"><span class="settings-state-dot" aria-hidden="true"></span><span><strong>${escapeText(row.title)}</strong><small>${escapeText(row.description)}</small></span><span class="settings-result"><strong>${escapeText(row.stateLabel)}</strong><small>${escapeText(row.summary)}</small></span>${recovery}</article>`;
    })
    .join("");
