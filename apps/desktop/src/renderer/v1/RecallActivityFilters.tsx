import { useState, type FormEvent } from "react";
import {
  Button,
  Input,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from "@koed/ui";
import {
  recallActivityListInputSchema,
  type RecallActivityListInput,
  type RecallActivityQuestion
} from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import {
  localRecallDate,
  recallCallerPresentation,
  recallDateRange
} from "./recall-activity-model.js";
import { recallProjectLabel } from "./recall-project-label.js";
import "./project-management/project-management.css";

export function RecallSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(value) => value !== null && onChange(value)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup
        popupClassName="v1-app v1-project-ui recall-select-popup"
        alignItemWithTrigger={false}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function RecallCallerSelect({
  value,
  names,
  onChange
}: {
  value: string | undefined;
  names: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <RecallSelect
      label="Calling AI Client"
      value={
        value === undefined ? "all" : value === "" ? "unknown" : `name:${value}`
      }
      options={[
        { value: "all", label: "All AI Clients" },
        ...names.map((name) => ({
          value: `name:${name}`,
          label: recallCallerPresentation(name).label
        })),
        { value: "unknown", label: "Unknown AI Client" }
      ]}
      onChange={(next) =>
        onChange(
          next === "all" ? undefined : next === "unknown" ? "" : next.slice(5)
        )
      }
    />
  );
}

export function RecallActivityFilters({
  input,
  rows,
  projects,
  callerNames,
  onApply,
  onReset
}: {
  input: RecallActivityListInput;
  rows: RecallActivityQuestion[];
  projects: readonly DesktopProject[];
  callerNames: string[];
  onApply: (input: RecallActivityListInput) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    from: localRecallDate(new Date(input.from)),
    to: localRecallDate(new Date(Date.parse(input.to) - 1)),
    projectId: input.projectId ?? "",
    searchDomain: input.searchDomain ?? "",
    outcome:
      input.status === "error"
        ? "error"
        : (input.memoryStatus ?? input.status ?? "all"),
    callerName: input.callerName,
    minDuration:
      input.minDurationMs === undefined
        ? ""
        : String(input.minDurationMs / 1000),
    maxDuration:
      input.maxDurationMs === undefined
        ? ""
        : String(input.maxDurationMs / 1000)
  }));
  const projectChoices = new Map(
    rows.flatMap((row) =>
      row.projectId
        ? [
            [
              row.projectId,
              recallProjectLabel(row, projects) ?? "Project unavailable"
            ] as const
          ]
        : []
    )
  );
  if (draft.projectId && !projectChoices.has(draft.projectId))
    projectChoices.set(
      draft.projectId,
      recallProjectLabel(
        { projectId: draft.projectId, projectName: null },
        projects
      ) ?? "Project unavailable"
    );
  const [error, setError] = useState<string | null>(null);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = recallActivityListInputSchema.parse({
        ...input,
        ...recallDateRange(draft.from, draft.to),
        projectId: draft.projectId.trim() || undefined,
        sessionId: undefined,
        searchDomain: draft.searchDomain || undefined,
        status:
          draft.outcome === "all"
            ? undefined
            : draft.outcome === "error"
              ? "error"
              : "answered",
        memoryStatus: ["all", "answered", "error"].includes(draft.outcome)
          ? undefined
          : draft.outcome,
        callerName: draft.callerName,
        minDurationMs: draft.minDuration
          ? Number(draft.minDuration) * 1000
          : undefined,
        maxDurationMs: draft.maxDuration
          ? Number(draft.maxDuration) * 1000
          : undefined
      });
      if (Date.parse(next.to) - Date.parse(next.from) > 3660 * 86_400_000)
        throw new Error("Range too long");
      onApply(next);
    } catch {
      setError(
        "Choose a valid date range of up to ten years and a valid duration range."
      );
    }
  };
  return (
    <form
      id="recall-advanced-filters"
      className="recall-advanced"
      onSubmit={apply}
    >
      <div className="recall-filter-fields">
        <label>
          From
          <Input
            type="date"
            required
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
          />
        </label>
        <label>
          Through
          <Input
            type="date"
            required
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <label>
          Search Domain
          <RecallSelect
            label="Search Domain"
            value={draft.searchDomain}
            onChange={(searchDomain) => setDraft({ ...draft, searchDomain })}
            options={[
              { value: "", label: "All domains" },
              { value: "global", label: "All Memory" },
              { value: "project", label: "Project" },
              { value: "session", label: "Conversation" }
            ]}
          />
        </label>
        <label>
          Memory outcome
          <RecallSelect
            label="Memory outcome"
            value={draft.outcome}
            onChange={(outcome) => setDraft({ ...draft, outcome })}
            options={[
              { value: "all", label: "All outcomes" },
              { value: "answered", label: "Answered" },
              { value: "found", label: "Memory found" },
              { value: "not_found", label: "No matching Memory" },
              { value: "insufficient", label: "Partial evidence" },
              { value: "pending_summary", label: "Summaries pending" },
              { value: "unknown", label: "Unknown" },
              { value: "error", label: "Recorded error" }
            ]}
          />
        </label>
        <label>
          Recorded Project
          <RecallSelect
            label="Recorded Project"
            value={draft.projectId}
            onChange={(projectId) => setDraft({ ...draft, projectId })}
            options={[
              { value: "", label: "All Projects" },
              ...[...projectChoices].map(([value, label]) => ({ value, label }))
            ]}
          />
        </label>
        <label>
          Calling AI Client
          <RecallCallerSelect
            value={draft.callerName}
            names={callerNames}
            onChange={(callerName) => setDraft({ ...draft, callerName })}
          />
        </label>
        <label>
          Minimum duration (s)
          <Input
            type="number"
            min="0"
            step="0.001"
            value={draft.minDuration}
            onChange={(event) =>
              setDraft({ ...draft, minDuration: event.target.value })
            }
          />
        </label>
        <label>
          Maximum duration (s)
          <Input
            type="number"
            min="0"
            step="0.001"
            value={draft.maxDuration}
            onChange={(event) =>
              setDraft({ ...draft, maxDuration: event.target.value })
            }
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="recall-filter-actions">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          Reset filters
        </Button>
      </div>
    </form>
  );
}
