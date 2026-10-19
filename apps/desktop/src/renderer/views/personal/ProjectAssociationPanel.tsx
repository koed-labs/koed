import { Button } from "@koed/ui";
import { Link, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const receive = useCallback((next: ProjectSelectionCommandResult) => {
    setResult(next);
    setRemote((value) =>
      next.remotes.some((entry) => entry.name === value)
        ? value
        : (next.remotes.find((entry) => entry.name === next.defaultRemote)
            ?.name ??
          next.remotes[0]?.name ??
          "")
    );
    setOffer((value) =>
      next.associations.some((entry) => entry.associationId === value)
        ? value
        : ""
    );
  }, []);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void onAssociation({ operation: "inspect", localProjectId })
      .then((next) => {
        if (active) receive(next);
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Shared choices are unavailable."
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [localProjectId, onAssociation, receive]);
  const run = async (input: ProjectSelectionCommand) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      receive(await onAssociation(input));
      if (input.operation !== "inspect") {
        setMessage(
          input.operation === "forget"
            ? "This folder is unlinked. Other folders stay linked."
            : "Shared choice saved. Older Conversations did not move."
        );
        try {
          await onChanged?.();
        } catch {
          setError("The change was saved. Refresh Projects to see it.");
        }
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Shared choices are unavailable."
      );
      setResult(null);
      // Refresh for review. Never resubmit a stale resolution with new heads.
      try {
        receive(await onAssociation({ operation: "inspect", localProjectId }));
      } catch {
        /* Keep actions unavailable until inspection succeeds. */
      }
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
  const state = current?.state.state;
  const conflict = state === "conflict";
  const incomplete = !current || state === "incomplete";
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
  const remoteField = (title: string) => (
    <label className="personal-project-field">
      {title}
      <select
        aria-label={title}
        value={remote}
        disabled={busy}
        onChange={(event) => setRemote(event.target.value)}
      >
        {!result?.remotes.length ? (
          <option value="">No portable remote</option>
        ) : null}
        {result?.remotes.map((entry, index) => (
          <option key={`${entry.name}-${index}`} value={entry.name}>
            {entry.name} · {entry.display ?? entry.fingerprint}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section
      className="personal-project-association"
      aria-label="Share anchor across devices"
      aria-busy={busy}
    >
      <div className="personal-project-sharing-intro">
        <p>Use one repository choice on your Personal devices.</p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh shared choices"
          title="Refresh shared choices"
          disabled={busy}
          onClick={() => void run({ operation: "inspect", localProjectId })}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
      {!result && busy ? <p role="status">Loading shared choices…</p> : null}
      {result && !result.groupId ? (
        <p className="personal-project-notice">
          Pair your Personal devices to share a repository choice.
        </p>
      ) : null}
      {result?.groupId ? (
        <>
          {!accepted ? (
            <>
              <div
                className="personal-project-sharing-modes"
                role="group"
                aria-label="Sharing action"
              >
                <Button
                  variant="outline"
                  aria-pressed={mode === "existing"}
                  disabled={busy}
                  onClick={() => setMode("existing")}
                >
                  Use existing
                </Button>
                <Button
                  variant="outline"
                  aria-pressed={mode === "new"}
                  disabled={busy}
                  onClick={() => setMode("new")}
                >
                  Share new
                </Button>
              </div>
              {mode === "new" ? (
                remoteField("Repository remote")
              ) : (
                <label className="personal-project-field">
                  Shared choice
                  <select
                    aria-label="Available shared choice"
                    value={offer}
                    disabled={busy}
                    onChange={(event) => setOffer(event.target.value)}
                  >
                    <option value="">
                      {result.associations.length
                        ? "Choose a repository…"
                        : "No shared choices yet"}
                    </option>
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
              )}
              <div className="personal-project-card-actions">
                {mode === "new" ? (
                  <Button
                    disabled={busy || !remote}
                    onClick={() =>
                      void run({
                        operation: "create",
                        ...marker,
                        remoteName: remote
                      })
                    }
                  >
                    Share and link
                  </Button>
                ) : (
                  <Button
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
                    Link folder
                  </Button>
                )}
              </div>
              <p className="personal-project-details-description">
                Requires paired Personal devices.
              </p>
            </>
          ) : (
            <>
              {conflict ? (
                <>
                  <p className="personal-project-notice" role="status">
                    Two or more changes conflict. Review every change before you
                    choose.
                  </p>
                  <ul
                    aria-label="Current shared selection revisions"
                    className="personal-project-shared-revisions"
                  >
                    {headRevisions.map((revision) => (
                      <li key={revision.revisionId}>
                        <span>
                          {revision.operation.kind === "delete"
                            ? "Remove shared choice"
                            : label(revision.operation.anchorFingerprint)}
                        </span>
                        <small>
                          {result.deviceLabels[revision.authorDeviceId] ??
                            `Device ${revision.authorDeviceId.slice(0, 8)}`}{" "}
                          · Revision {revision.revisionId.slice(0, 8)}
                        </small>
                      </li>
                    ))}
                  </ul>
                  <p className="personal-project-details-description">
                    Review every change, even when the repositories match.
                  </p>
                </>
              ) : (
                <p className="personal-project-notice" role="status">
                  <Link aria-hidden="true" />{" "}
                  {state === "selected"
                    ? `Linked · ${current?.state.anchorFingerprint ? label(current.state.anchorFingerprint) : "Shared choice"}`
                    : state === "deleted"
                      ? "The shared choice was removed."
                      : "Shared history is unavailable. Refresh to try again."}
                </p>
              )}
              {remoteField(conflict ? "Use remote" : "Shared remote")}
              {state === "selected" ? (
                <p className="personal-project-details-description">
                  Updates apply to all linked folders.
                </p>
              ) : null}
              <div className="personal-project-card-actions">
                <Button
                  disabled={busy || !remote || incomplete}
                  onClick={() => set(remote)}
                >
                  {conflict
                    ? "Resolve"
                    : state === "deleted"
                      ? "Share again"
                      : "Save changes"}
                </Button>
              </div>
              <div className="personal-project-sharing-links">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run({ operation: "forget", ...marker })}
                >
                  Unlink this folder<small>Other folders stay linked.</small>
                </Button>
                {state !== "deleted" ? (
                  <Button
                    variant="ghost"
                    disabled={busy || incomplete}
                    onClick={() => set(null)}
                  >
                    {conflict
                      ? "Resolve by removing shared choice"
                      : "Remove shared choice"}
                    <small>All linked folders return to Git detection.</small>
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </>
      ) : null}
      <details className="personal-project-technical">
        <summary>How sharing works</summary>
        <p>
          Link each folder yourself. Matching repository addresses do not link
          folders.
        </p>
        <p>
          A choice for one folder takes priority over its shared choice.
          Existing Conversations stay in their Projects.
        </p>
        <p>A remote is a named Git repository address.</p>
      </details>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
