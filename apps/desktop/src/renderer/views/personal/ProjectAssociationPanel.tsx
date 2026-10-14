import { useState } from "react";
import type { RendererPlatform } from "../../services/platform.js";
import type {
  ProjectSelectionCommand,
  ProjectSelectionCommandResult
} from "@koed/shared/project-selection";

export function ProjectAssociationPanel({
  localProjectId,
  onAssociation,
  onChanged
}: {
  localProjectId: string;
  onAssociation: RendererPlatform["projectAssociation"];
  onChanged?: () => Promise<void>;
}) {
  const [result, setResult] = useState<ProjectSelectionCommandResult | null>(
    null
  );
  const [remote, setRemote] = useState("");
  const [offer, setOffer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inspect = async () => {
    const next = await onAssociation({ operation: "inspect", localProjectId });
    setResult(next);
    setRemote((current) =>
      next.remotes.some((entry) => entry.name === current)
        ? current
        : (next.remotes[0]?.name ?? "")
    );
    return next;
  };
  const run = async (input: ProjectSelectionCommand) => {
    setBusy(true);
    setError("");
    try {
      const next = await onAssociation(input);
      setResult(next);
      setRemote((value) =>
        next.remotes.some((entry) => entry.name === value)
          ? value
          : (next.defaultRemote ?? next.remotes[0]?.name ?? "")
      );
      if (input.operation !== "inspect") await onChanged?.();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Project association is unavailable"
      );
      // Refresh for review, never automatically resubmit a stale resolution.
      await inspect().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const accepted = result?.accepted;
  const current = result?.associations.find(
    (entry) =>
      entry.associationId === accepted?.associationId &&
      entry.selectionId === accepted?.selectionId
  );
  const headRevisions =
    current?.state.revisions.filter((revision) =>
      current.state.heads.includes(revision.revisionId)
    ) ?? [];
  const marker = {
    localProjectId,
    expectedCheckoutId: result?.checkoutId ?? ""
  };
  const set = (remoteName: string | null) => {
    if (accepted && current)
      void run({
        operation: "set",
        ...marker,
        ...accepted,
        reviewedHeads: current.state.heads,
        remoteName
      });
  };
  const label = (fingerprint: string) =>
    result?.remotes.find((entry) => entry.fingerprint === fingerprint)
      ?.display ?? fingerprint;
  return (
    <details
      className="personal-project-association"
      onToggle={(event) => {
        if (event.currentTarget.open && !result && !busy)
          void run({ operation: "inspect", localProjectId });
      }}
    >
      <summary>Shared Project selection</summary>
      <p>
        Associated checkouts share anchor choices. Local explicit choices take
        precedence. Existing session assignments stay as recorded.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run({ operation: "inspect", localProjectId })}
      >
        Refresh shared selections
      </button>
      {result && !result.groupId ? (
        <p>Pair Personal devices before sharing a Project selection.</p>
      ) : null}
      {result?.groupId ? (
        <>
          <label>
            Shared anchor remote{" "}
            <select
              aria-label="Shared anchor remote"
              value={remote}
              disabled={busy}
              onChange={(event) => setRemote(event.target.value)}
            >
              {!result.remotes.length ? (
                <option value="">No portable remote</option>
              ) : null}
              {result.remotes.map((entry, index) => (
                <option key={`${entry.name}-${index}`} value={entry.name}>
                  {entry.name} · {entry.display ?? entry.fingerprint}
                </option>
              ))}
            </select>
          </label>
          {!accepted ? (
            <>
              <button
                type="button"
                disabled={busy || !remote}
                onClick={() =>
                  void run({
                    operation: "create",
                    ...marker,
                    remoteName: remote
                  })
                }
              >
                Create shared Project association
              </button>
              <label>
                Available association{" "}
                <select
                  aria-label="Available Project association"
                  value={offer}
                  disabled={busy}
                  onChange={(event) => setOffer(event.target.value)}
                >
                  <option value="">Choose an association</option>
                  {result.associations.map((entry) => (
                    <option
                      key={entry.associationId}
                      value={entry.associationId}
                    >
                      {entry.state.anchorFingerprint
                        ? label(entry.state.anchorFingerprint)
                        : entry.state.state}{" "}
                      · {entry.associationId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !offer}
                onClick={() => {
                  const offered = result.associations.find(
                    (entry) => entry.associationId === offer
                  );
                  if (offered)
                    void run({
                      operation: "accept",
                      ...marker,
                      groupId: result.groupId!,
                      associationId: offered.associationId,
                      selectionId: offered.selectionId
                    });
                }}
              >
                Accept association for this checkout
              </button>
            </>
          ) : (
            <>
              <p>
                Association {accepted.associationId.slice(0, 8)} ·{" "}
                {current?.state.state ?? "Unavailable"}
              </p>
              {current?.state.state === "conflict" ? (
                <p role="status">
                  Concurrent changes need a choice. Review every current
                  revision below before resolving.
                </p>
              ) : null}
              {current?.state.state === "incomplete" ? (
                <p role="status">
                  Waiting for shared selection history. This checkout remains
                  unresolved unless a local explicit choice takes precedence.
                </p>
              ) : null}
              <ul aria-label="Current shared selection revisions">
                {headRevisions.map((revision) => (
                  <li key={revision.revisionId}>
                    {revision.operation.kind === "delete"
                      ? "Remove shared selection"
                      : label(revision.operation.anchorFingerprint)}{" "}
                    ·{" "}
                    {result.deviceLabels[revision.authorDeviceId] ??
                      `Device ${revision.authorDeviceId.slice(0, 8)}`}{" "}
                    · Revision {revision.revisionId.slice(0, 8)}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={
                  busy ||
                  !remote ||
                  !current ||
                  current.state.state === "incomplete"
                }
                onClick={() => set(remote)}
              >
                {current?.state.state === "conflict"
                  ? "Resolve with chosen anchor"
                  : current?.state.state === "deleted"
                    ? "Re-create shared selection"
                    : "Update shared selection"}
              </button>
              <button
                type="button"
                disabled={
                  busy || !current || current.state.state === "incomplete"
                }
                onClick={() => set(null)}
              >
                {current?.state.state === "conflict"
                  ? "Resolve by removing shared selection"
                  : "Delete shared selection"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run({ operation: "forget", ...marker })}
              >
                Forget association on this checkout
              </button>
              <p>
                Shared deletion resumes normal detection on associated
                checkouts. Forgetting affects only this checkout.
              </p>
            </>
          )}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
