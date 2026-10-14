import { useState } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { RendererPlatform } from "../../services/platform.js";

export function RepositoryAnchorPanel({
  project,
  onSetAnchor
}: {
  project: DesktopProject;
  onSetAnchor?: RendererPlatform["setRepositoryAnchor"];
}) {
  const [remote, setRemote] = useState(
    project.repository?.selectedRemote ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const repository = project.repository;
  if (!repository) return null;
  const save = async (remoteName: string | null) => {
    if (!onSetAnchor || !project.localProjectId || !repository.checkoutId)
      return;
    setBusy(true);
    setError("");
    try {
      await onSetAnchor({
        localProjectId: project.localProjectId,
        expectedCheckoutId: repository.checkoutId,
        remoteName
      });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Repository anchor could not be saved."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="personal-repository-anchor">
      <summary>
        Repository anchor ·{" "}
        {repository.anchorDisplay ?? repository.kind.replaceAll("_", " ")}
      </summary>
      <dl>
        <dt>Resolution</dt>
        <dd>{repository.reason.replaceAll("_", " ")}</dd>
        <dt>Identity</dt>
        <dd>{repository.key ?? "Unresolved"}</dd>
        <dt>Checkout</dt>
        <dd>{repository.root}</dd>
        <dt>Branch</dt>
        <dd>{repository.branch ?? "No branch observation"}</dd>
        <dt>Originating device</dt>
        <dd>{repository.originatingDeviceId}</dd>
      </dl>
      {onSetAnchor && repository.checkoutId && project.localProjectId ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(remote);
          }}
        >
          <label>
            Selected remote{" "}
            <input
              aria-label="Selected repository remote"
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              list={`repository-remotes-${project.localProjectId}`}
              disabled={busy}
            />
          </label>
          <datalist id={`repository-remotes-${project.localProjectId}`}>
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
          <button type="submit" disabled={busy || !remote.trim()}>
            Save anchor
          </button>
          <button type="button" disabled={busy} onClick={() => void save(null)}>
            Use automatic selection
          </button>
          <p>
            The selected anchor identifies this checkout. Recorded session
            assignments stay as recorded.
          </p>
        </form>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
