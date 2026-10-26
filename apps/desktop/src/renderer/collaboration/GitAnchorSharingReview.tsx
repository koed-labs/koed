import { useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalJsonDigest as crossIdentitySyncDigest,
  sharingSelectionDescriptor
} from "@koed/shared/collaboration";
import type {
  CollaborationSnapshot,
  GitAnchorSharingReviewInput,
  GitAnchorSharingReviewPage
} from "@koed/shared/collaboration";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import type { SharingRuleDelivery } from "@koed/shared";
import {
  SharingDetailChoices,
  SharingRow,
  sharingDetailTitle
} from "./SharingControls.js";
import { RepositorySharingRules } from "./RepositorySharingRules.js";
import {
  Modal,
  ModalHeader,
  failureMessage
} from "./collaboration-primitives.js";

type Source = GitAnchorSharingReviewPage["entries"][number] & {
  reasons: GitAnchorSharingReviewPage["entries"][number]["reason"][];
};

export function GitAnchorSharingReview({
  client,
  target,
  selectionTitle,
  availableTeams,
  onClose
}: {
  client: Pick<
    CollaborationRendererClient,
    | "reviewGitAnchorSharing"
    | "reviewRepositoryRuleCreation"
    | "createRepositoryRule"
    | "listRepositoryRules"
    | "controlRepositoryRule"
    | "listSharingRuleDeliveries"
    | "reviewRuleDetail"
    | "amendRuleDetail"
    | "reviewRuleContentPolicy"
    | "amendRuleContentPolicy"
    | "reviewPublisherTakeover"
    | "takeOverPublisher"
  >;
  target: GitAnchorSharingReviewInput["target"];
  selectionTitle?: string;
  availableTeams: CollaborationSnapshot["navigation"]["teams"];
  onClose: () => void;
}) {
  const [teamId, setTeamId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [representation, setRepresentation] =
    useState<GitAnchorSharingReviewInput["representation"]>("lcm_rollups");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle"
  );
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [completedReview, setCompletedReview] = useState<
    | Parameters<CollaborationRendererClient["reviewRepositoryRuleCreation"]>[0]
    | null
  >(null);
  const [creating, setCreating] = useState(false),
    [creation, setCreation] = useState<SharingRuleDelivery | null>(null);
  const targetKey = JSON.stringify(target);
  const selector = useMemo(() => sharingSelectionDescriptor(target), [target]);
  const selectionLabel =
    target.kind === "folder"
      ? "Folder"
      : target.kind === "project"
        ? "Project"
        : "Git Anchor";
  const epoch = useRef(0);
  const teams = availableTeams.filter((team) => team.lifecycle === "active");
  const team = teams.find((entry) => entry.id === teamId);
  const workspaces =
    team?.workspaces.filter(
      (workspace) =>
        workspace.lifecycle === "active" && workspace.access === "write"
    ) ?? [];
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  useEffect(() => {
    setCreation(null);
  }, [targetKey]);
  useEffect(() => {
    epoch.current++;
    setState("idle");
    setSources([]);
    setError("");
    setExpiresAt(null);
    setCompletedReview(null);
    setCreating(false);
    return () => {
      epoch.current++;
    };
  }, [targetKey, teamId, workspaceId, representation]);

  const review = async () => {
    if (!team || !workspace) return;
    const attempt = ++epoch.current;
    setState("loading");
    setSources([]);
    setError("");
    setExpiresAt(null);
    setCompletedReview(null);
    const merged = new Map<string, Source>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let snapshotVersion: string | null = null;
    try {
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const page = await client.reviewGitAnchorSharing({
          target,
          teamId,
          workspaceId,
          representation,
          cursor
        });
        if (attempt !== epoch.current) return;
        if (
          page.destination.teamId !== teamId ||
          page.destination.workspaceId !== workspaceId ||
          page.destination.representation !== representation ||
          crossIdentitySyncDigest(page.target) !==
            crossIdentitySyncDigest(target) ||
          (snapshotVersion !== null && page.snapshotVersion !== snapshotVersion)
        )
          throw new Error(
            "The reviewed selection changed. Refresh the review."
          );
        snapshotVersion = page.snapshotVersion;
        for (const entry of page.entries) {
          const previous = merged.get(entry.source.localSessionId);
          const reasons = previous?.reasons ?? [];
          if (
            !reasons.some(
              (reason) =>
                JSON.stringify(reason) === JSON.stringify(entry.reason)
            )
          )
            reasons.push(entry.reason);
          merged.set(entry.source.localSessionId, { ...entry, reasons });
        }
        if (merged.size > 5000)
          throw new Error("This selection is too large for a complete review.");
        setSources([...merged.values()]);
        if (
          page.complete &&
          page.nextCursor === null &&
          page.completionToken !== null
        ) {
          setExpiresAt(page.expiresAt);
          setCompletedReview({
            target,
            teamId,
            workspaceId,
            representation,
            completionToken: page.completionToken
          });
          setState("ready");
          return;
        }
        if (!page.nextCursor || cursors.has(page.nextCursor))
          throw new Error(
            "The review could not finish all pages. Refresh the review."
          );
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Error(
        "The review could not finish all pages. Refresh the review."
      );
    } catch (cause) {
      if (attempt !== epoch.current) return;
      setSources([]);
      setState("failed");
      setError(
        failureMessage(
          cause,
          "The review is unavailable. Refresh the same selection and destination."
        )
      );
    }
  };
  const share = async () => {
    if (!completedReview || !expiresAt || Date.parse(expiresAt) <= Date.now()) {
      setError("The review expired. Refresh it before sharing.");
      setCompletedReview(null);
      return;
    }
    const attempt = ++epoch.current;
    setCreating(true);
    setError("");
    try {
      const review = await client.reviewRepositoryRuleCreation(completedReview);
      const { teamWorkspaceId, ...scope } = review.scope;
      const delivery = await client.createRepositoryRule({
        ...scope,
        workspaceId: teamWorkspaceId,
        mutationId: crypto.randomUUID(),
        ruleId: crypto.randomUUID(),
        review: completedReview
      });
      if (attempt !== epoch.current) return;
      setCreation(delivery);
      setCompletedReview(null);
      if (delivery.state === "needs_review")
        setError(
          "Team acceptance could not be confirmed. Refresh sharing and review this rule again."
        );
    } catch (cause) {
      if (attempt === epoch.current) {
        setError(
          failureMessage(
            cause,
            "Sharing was not confirmed. Refresh the review and try again."
          )
        );
        setCompletedReview(null);
      }
    } finally {
      if (attempt === epoch.current) setCreating(false);
    }
  };
  return (
    <Modal
      className="collab-sharing-modal"
      label={`Review ${selectionLabel} sharing`}
      onClose={onClose}
    >
      <ModalHeader
        title={state === "ready" ? "Review sharing" : "Share memory"}
        onClose={onClose}
      />
      <div className="collab-form collab-sharing-form collab-git-sharing-review">
        <p className="collab-form-context">
          {selectionLabel} ·{" "}
          {target.kind === "repository"
            ? (target.repository.anchorDisplay ?? target.repository.key)
            : (selectionTitle ??
              (target.kind === "folder" ? "Exact Folder" : "Personal Project"))}
        </p>
        {state === "ready" ? (
          <>
            <div>
              <SharingRow
                label="Share with"
                value={`${team?.name} / ${workspace?.name}`}
              />
              <SharingRow
                label="Who can recall"
                value="Members with Workspace Access"
              />
              <SharingRow
                label="Shared detail"
                value={sharingDetailTitle(representation)}
              />
              <SharingRow
                label="Updates"
                value="Existing & future Conversations"
              />
              <SharingRow label="Source access" value="Not allowed" />
            </div>
            <div className="collab-sharing-readiness" role="status">
              <strong>
                {sources.length}{" "}
                {sources.length === 1 ? "Conversation" : "Conversations"}
              </strong>
              <span className="collab-sharing-state active">
                {
                  sources.filter((entry) => entry.readiness === "eligible")
                    .length
                }{" "}
                ready
              </span>
              {sources.some((entry) => entry.readiness === "unresolved") ? (
                <span className="collab-sharing-state pending">
                  {
                    sources.filter((entry) => entry.readiness === "unresolved")
                      .length
                  }{" "}
                  waiting
                </span>
              ) : null}
            </div>
            <p className="collab-sharing-notice">
              Available after Privacy processing.
            </p>
            <details className="collab-sharing-disclosure">
              <summary>Privacy & technical details</summary>
              <SharingRow label="Privacy" value="Required categories hidden" />
              {expiresAt ? (
                <SharingRow
                  label="Review expires"
                  value={new Date(expiresAt).toLocaleString()}
                />
              ) : null}
              {target.kind === "project" ? (
                <p>The Project name and membership stay in Personal Memory.</p>
              ) : null}
              <p>No consent or Share Grant exists until sharing is approved.</p>
            </details>
          </>
        ) : (
          <>
            <div className="collab-sharing-destination">
              <label>
                Team
                <select
                  value={teamId}
                  disabled={state === "loading" || creating}
                  onChange={(event) => {
                    setTeamId(event.target.value);
                    setWorkspaceId("");
                  }}
                >
                  <option value="">Choose a Team</option>
                  {teams.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workspace
                <select
                  value={workspaceId}
                  disabled={!team || state === "loading" || creating}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  <option value="">Choose a Workspace</option>
                  {workspaces.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <SharingDetailChoices
              value={representation}
              onChange={setRepresentation}
              disabled={state === "loading" || creating}
            />
            <div className="collab-sharing-updates-summary">
              <SharingRow
                label="Updates"
                value="Existing & future Conversations"
              />
            </div>
          </>
        )}
        {creation?.state === "acknowledged" ? (
          <p role="status">Team accepted the sharing rule.</p>
        ) : null}
        {error ? (
          <p role="alert" className="collab-form-error">
            {error}
          </p>
        ) : null}
        {state === "loading" ? (
          <p role="status">
            Reviewing Conversations… {sources.length} inspected. The selection
            is not complete yet.
          </p>
        ) : null}
        <footer className="collab-modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={creating}
            onClick={
              state === "ready" && !creation
                ? () => {
                    setState("idle");
                    setCompletedReview(null);
                  }
                : onClose
            }
          >
            {state === "ready" && !creation
              ? "Back"
              : creation || creating
                ? "Close"
                : "Cancel"}
          </button>
          {state === "ready" ? (
            <button
              type="button"
              disabled={!completedReview || creating}
              onClick={() => void share()}
            >
              {creating
                ? "Waiting for sharing approval…"
                : "Continue to approval"}
            </button>
          ) : (
            <button
              type="button"
              disabled={!workspace || state === "loading" || creating}
              onClick={() => void review()}
            >
              {state === "idle" ? "Review" : "Refresh review"}
            </button>
          )}
        </footer>
        <details className="collab-sharing-disclosure">
          <summary>Existing sharing rules</summary>
          <RepositorySharingRules
            embedded
            client={client}
            selector={selector}
            target={target}
            creation={creation}
          />
        </details>
      </div>
    </Modal>
  );
}
