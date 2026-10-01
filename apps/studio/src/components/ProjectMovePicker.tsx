type ProjectOption = Readonly<{ id: string; name: string }>;

type ProjectMovePickerProps = {
  projects: readonly ProjectOption[];
  destinationProjectId: string;
  reviewDisabled: boolean;
  onDestinationProjectChange: (projectId: string) => void;
  onReviewMove: () => void;
  onCancel: () => void;
};

export function ProjectMovePicker({
  projects,
  destinationProjectId,
  reviewDisabled,
  onDestinationProjectChange,
  onReviewMove,
  onCancel
}: ProjectMovePickerProps) {
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="text-[10px] text-muted">
        Destination Project
        <select
          value={destinationProjectId}
          onChange={(event) => onDestinationProjectChange(event.target.value)}
          className="mt-1 block min-w-44 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onReviewMove}
        disabled={reviewDisabled}
        className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
      >
        Review Move
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md px-2 py-1.5 text-[11px] text-muted hover:bg-surface-hover"
      >
        Cancel
      </button>
    </div>
  );
}
