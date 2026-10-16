import { Button } from "@koed/ui";
import { useEffect, useId, useState } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { RendererPlatform } from "../../services/platform.js";

export type ProjectRepositoryActions = {
  onSetAnchor?: RendererPlatform["setRepositoryAnchor"];
  onReview?: RendererPlatform["reviewRepository"];
  onAssociation?: RendererPlatform["projectAssociation"];
  onChanged?: () => Promise<void>;
};

export function RepositoryAnchorPanel({
  project,
  onSetAnchor,
  onChanged
}: { project: DesktopProject } & Pick<
  ProjectRepositoryActions,
  "onSetAnchor" | "onChanged"
>) {
  const repository = project.repository;
  const [remote, setRemote] = useState(repository?.selectedRemote ?? "");
  const [mode, setMode] = useState<"auto" | "local">(
    repository?.reason === "local_selection" ||
      repository?.reason === "selection_missing" ||
      repository?.reason === "selection_not_portable"
      ? "local"
      : "auto"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const remoteListId = useId();
  useEffect(() => {
    setRemote(repository?.selectedRemote ?? "");
  }, [repository?.checkoutId, repository?.selectedRemote]);
  if (!repository) return null;
  const save = async () => {
    if (!onSetAnchor || !project.localProjectId || !repository.checkoutId)
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await onSetAnchor({
        localProjectId: project.localProjectId,
        expectedCheckoutId: repository.checkoutId,
        remoteName: mode === "local" ? remote.trim() : null
      });
      setMessage("Repository choice saved. Older Conversations did not move.");
      try {
        await onChanged?.();
      } catch {
        setError("The choice was saved. Refresh Projects to see it.");
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Repository anchor could not be saved."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="personal-repository-anchor">
      <p className="personal-project-details-description">
        An anchor is the repository that identifies this folder. Koed uses this
        choice for new Conversations.
      </p>
      {onSetAnchor && repository.checkoutId && project.localProjectId ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="personal-project-choice">
            <input
              type="radio"
              name={remoteListId}
              checked={mode === "auto"}
              disabled={busy}
              onChange={() => setMode("auto")}
            />
            <span>
              Automatic
              <small>
                If this folder is linked, follow its shared choice. Otherwise,
                use Git detection.
              </small>
            </span>
          </label>
          <label className="personal-project-choice">
            <input
              type="radio"
              name={remoteListId}
              checked={mode === "local"}
              disabled={busy}
              onChange={() => setMode("local")}
            />
            <span>
              Choose for this folder only
              <small>Use this choice even when a shared choice exists.</small>
            </span>
          </label>
          {mode === "local" ? (
            <label className="personal-project-field">
              Git remote
              <input
                aria-label="Selected repository remote"
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
                list={remoteListId}
                disabled={busy}
              />
              <datalist id={remoteListId}>
                {[
                  ...new Set(
                    project.repositoryRemotes
                      ?.map((entry) => entry.name)
                      .filter(Boolean)
                  )
                ].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <small>A remote is a named Git repository address.</small>
            </label>
          ) : (
            <p className="personal-project-details-description">
              {repository.anchorDisplay ?? "Unresolved"}
            </p>
          )}
          <p className="personal-project-details-description">
            This does not move older Conversations. Use Review previous
            assignments to move them.
          </p>
          <div className="personal-project-card-actions">
            <Button
              type="submit"
              disabled={busy || (mode === "local" && !remote.trim())}
            >
              Save anchor
            </Button>
          </div>
        </form>
      ) : null}
      <details className="personal-project-technical">
        <summary>Technical details</summary>
        <dl>
          <dt>Resolution</dt>
          <dd>{repository.reason.replaceAll("_", " ")}</dd>
          <dt>Identity</dt>
          <dd>{repository.key ?? "Unresolved"}</dd>
          <dt>Folder</dt>
          <dd>{repository.root}</dd>
          <dt>Branch</dt>
          <dd>{repository.branch ?? "No branch observation"}</dd>
          <dt>Originating device</dt>
          <dd>{repository.originatingDeviceId}</dd>
        </dl>
      </details>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
