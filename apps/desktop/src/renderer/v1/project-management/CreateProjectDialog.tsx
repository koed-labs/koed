import { useRef, useState } from "react";
import { Button, DialogFooter, Input } from "@koed/ui";
import { ProjectError, ProjectPopup } from "./controls.js";
import { projectErrorMessage } from "./use-organization-review.js";

export function CreateProjectDialog({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (name: string, requestId: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ name: string; id: string } | undefined>(undefined);
  const create = async () => {
    if (!name.trim() || busy) return;
    if (request.current?.name !== name.trim())
      request.current = { name: name.trim(), id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await onCreate(request.current.name, request.current.id);
    } catch (cause) {
      setError(projectErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ProjectPopup title="Create Project" busy={busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="v1-pm-field">
          <label htmlFor="v1-pm-create-name">Project name</label>
          <Input
            id="v1-pm-create-name"
            autoFocus
            value={name}
            maxLength={160}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <ProjectError error={error} />
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create Project"}
          </Button>
        </DialogFooter>
      </form>
    </ProjectPopup>
  );
}
