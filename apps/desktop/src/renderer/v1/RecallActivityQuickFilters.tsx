import type {
  RecallActivityListInput,
  RecallActivityQuestion
} from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import { RecallSelect } from "./RecallActivityFilters.js";
import { recallProjectLabel } from "./recall-project-label.js";
import { recallOutcomeOptions } from "./recall-activity-model.js";

export function RecallActivityQuickFilters({
  input,
  choices,
  projects,
  onChange
}: {
  input: RecallActivityListInput;
  choices: Pick<RecallActivityQuestion, "projectId" | "projectName">[];
  projects: readonly DesktopProject[];
  onChange: (input: RecallActivityListInput) => void;
}) {
  const options = new Map(
    choices.flatMap((project) =>
      project.projectId
        ? [
            [
              project.projectId,
              recallProjectLabel(project, projects) ?? "Project unavailable"
            ] as const
          ]
        : []
    )
  );
  if (input.projectId && !options.has(input.projectId))
    options.set(
      input.projectId,
      recallProjectLabel({ projectId: input.projectId }, projects) ??
        "Project unavailable"
    );
  return (
    <div className="recall-quick-filters">
      <RecallSelect
        label="Project filter"
        value={input.projectId ?? ""}
        options={[
          { value: "", label: "All Projects" },
          ...[...options].map(([value, label]) => ({ value, label }))
        ]}
        onChange={(projectId) =>
          onChange({ ...input, projectId: projectId || undefined })
        }
      />
      <RecallSelect
        label="Outcome filter"
        value={
          input.status === "error"
            ? "error"
            : (input.memoryStatus ?? input.status ?? "all")
        }
        options={[
          { value: "all", label: "All outcomes" },
          { value: "answered", label: "Answered" },
          ...recallOutcomeOptions
        ]}
        onChange={(outcome) =>
          onChange({
            ...input,
            status:
              outcome === "all"
                ? undefined
                : outcome === "error"
                  ? "error"
                  : "answered",
            memoryStatus: ["all", "answered", "error"].includes(outcome)
              ? undefined
              : (outcome as RecallActivityListInput["memoryStatus"])
          })
        }
      />
    </div>
  );
}
