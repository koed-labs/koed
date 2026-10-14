import { RepositoryReviewPanel } from "./RepositoryReviewPanel.js";
import { ProjectAssociationPanel } from "./ProjectAssociationPanel.js";
import { useEffect, useState } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { RendererPlatform } from "../../services/platform.js";

export function RepositoryAnchorPanel({
  project,
  onSetAnchor,
  onReview,
  onAssociation,
  onChanged
}: {
  project: DesktopProject;
  onSetAnchor?: RendererPlatform["setRepositoryAnchor"];
  onReview?: RendererPlatform["reviewRepository"];
  onAssociation?: RendererPlatform["projectAssociation"];
  onChanged?: () => Promise<void>;
}) {
  const [selectedCheckoutId, setSelectedCheckoutId] = useState(
    project.localProjectId
  );
  const selectedCheckout =
    project.checkouts?.find(
      (checkout) => checkout.localProjectId === selectedCheckoutId
    ) ?? project.checkouts?.[0];
  const localProjectId =
    selectedCheckout?.localProjectId ?? project.localProjectId;
  const [remote, setRemote] = useState(
    project.repository?.selectedRemote ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const repository = selectedCheckout?.repository ?? project.repository;
  useEffect(() => {
    setRemote(repository?.selectedRemote ?? "");
  }, [repository?.checkoutId, repository?.selectedRemote]);
  if (!repository) return null;
  const save = async (remoteName: string | null) => {
    if (!onSetAnchor || !localProjectId || !repository.checkoutId) return;
    setBusy(true);
    setError("");
    try {
      await onSetAnchor({
        localProjectId,
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
      {(project.checkouts?.length ?? 0) > 1 ? (
        <label>
          Checkout{" "}
          <select
            aria-label="Repository checkout"
            value={localProjectId ?? ""}
            onChange={(event) => {
              setSelectedCheckoutId(event.target.value);
              setRemote(
                project.checkouts?.find(
                  (checkout) => checkout.localProjectId === event.target.value
                )?.repository?.selectedRemote ?? ""
              );
            }}
          >
            {project.checkouts!.map((checkout) => (
              <option
                key={checkout.localProjectId}
                value={checkout.localProjectId}
              >
                {checkout.path}
              </option>
            ))}
          </select>
        </label>
      ) : null}
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
      {onSetAnchor && repository.checkoutId && localProjectId ? (
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
      {onReview && localProjectId ? (
        <RepositoryReviewPanel
          key={localProjectId}
          localProjectId={localProjectId}
          onReview={onReview}
          onChanged={onChanged}
        />
      ) : null}
      {onAssociation && localProjectId ? (
        <ProjectAssociationPanel
          key={localProjectId}
          localProjectId={localProjectId}
          onAssociation={onAssociation}
          onChanged={onChanged}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
