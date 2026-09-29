"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  CollaborationCommandResult,
  SharedMemoryCandidatePreview,
  SharedMemoryPreview,
  SharedMemoryFidelityCeiling,
  OwnedShareItem
} from "@koed/shared/collaboration";
import type { HostedOwnedPreviewItem, HostedOwnedSourcePreview, HostedReadyOwnerReplica, StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import type { ShareablePersonalConversation } from "./LocalConversationBrowser.match";
import { findPendingOwnedShare } from "@/app/settings/team-memory-settings.guards";

type TeamOption = { id: string; name: string };
type Mode = "snapshot" | "continuous";
type ShareSource = Pick<ShareablePersonalConversation, "id" | "logicalMemoryId" | "title">;
type ShareTargetGrant = { id: string; grantVersion: number; retentionEnabled: boolean };
type SharePreview = SharedMemoryPreview | HostedOwnedSourcePreview;

function isHostedPreview(preview: SharePreview): preview is HostedOwnedSourcePreview {
  return "teamWorkspaceId" in preview;
}

function previewWorkspaceId(preview: SharePreview): string {
  return isHostedPreview(preview) ? preview.teamWorkspaceId : preview.workspaceId;
}

function previewItemCount(preview: SharePreview): number {
  return isHostedPreview(preview) ? preview.items.length : preview.itemCount;
}

function resultData<T>(
  result: CollaborationCommandResult,
  command: string
): T {
  if (!result.ok || result.command !== command) {
    throw new Error("Koed returned an unexpected collaboration result.");
  }
  return result.data as T;
}

function previewText(item: SharedMemoryPreview["items"][number] | HostedOwnedPreviewItem): string {
  if ("content" in item) {
    const content = item.content;
    if ((item.itemType === "user_message" || item.itemType === "assistant_message" || item.itemType === "thought") && typeof content.text === "string") return content.text;
    return JSON.stringify(content, null, 2);
  }
  if (item.representation === "memory_events") return item.sourceItems.map((source) => source.body).join("\n\n");
  if (item.representation === "curated_assertions") return item.assertionText;
  return item.summaryText;
}

export function OwnedConversationShareDialog({
  client,
  source,
  teams,
  hostedBrowser = false,
  initialTeamId,
  initialTargetGrant = null,
  onComplete,
  onClose
}: {
  client: StudioCollaborationClient;
  source: ShareSource;
  teams: TeamOption[];
  hostedBrowser?: boolean;
  initialTeamId?: string;
  initialTargetGrant?: ShareTargetGrant | null;
  onComplete?: () => void;
  onClose: () => void;
}) {
  const [teamId, setTeamId] = useState(initialTeamId ?? teams[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("snapshot");
  const [maximumFidelity, setMaximumFidelity] = useState<SharedMemoryFidelityCeiling>("memory_events");
  const [retentionSetting, setRetentionSetting] = useState<{
    teamId: string;
    enabled: boolean;
    version: number;
  } | null>(null);
  const [retentionAcknowledged, setRetentionAcknowledged] = useState(false);
  const [targetGrant, setTargetGrant] = useState<ShareTargetGrant | null>(initialTargetGrant);
  const [candidate, setCandidate] = useState<SharedMemoryCandidatePreview | null>(null);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completeMessage, setCompleteMessage] = useState<string | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => () => { requestSequence.current += 1; }, []);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let active = true;
    if (!teamId) return () => { active = false; };
    const loadSetting = hostedBrowser
      ? client.getTeamMemoryRetention(teamId).then((setting) => ({ enabled: setting.enabled, version: setting.version }))
      : client.run("collaboration.get_team_memory_retention", { teamId }).then((result) => resultData<{ setting: { enabled: boolean; version: number } }>(result, "collaboration.get_team_memory_retention").setting);
    void loadSetting
      .then((setting) => {
        if (!active || sequence !== requestSequence.current) return;
        setRetentionSetting({ teamId, enabled: setting.enabled, version: setting.version });
      })
      .catch((reason: unknown) => {
        if (!active || sequence !== requestSequence.current) return;
        setError(reason instanceof Error ? reason.message : "Team retention settings are unavailable.");
      });
    return () => { active = false; };
  }, [client, hostedBrowser, teamId]);

  const preparePreview = async () => {
    const sequence = ++requestSequence.current;
    const isCurrent = () => sequence === requestSequence.current;
    setBusy(true);
    setError(null);
    setCandidate(null);
    setPreview(null);
    setRetentionAcknowledged(false);
    setCompleteMessage(null);
    try {
      const currentRetentionSetting = retentionSetting?.teamId === teamId ? retentionSetting : null;
      if (!source.logicalMemoryId || !teamId || !currentRetentionSetting) {
        throw new Error("The selected Personal Memory source or Team settings are not ready.");
      }
      const sourceRef = {
        kind: "captured_session" as const,
        sessionId: source.id,
        logicalMemoryId: source.logicalMemoryId
      };
      if (hostedBrowser) {
        const destination = await client.ensureTeamMemoryDestination(teamId);
        if (!isCurrent()) return;
        const replica = await client.getReadyOwnerMemoryReplica({
          logicalMemoryId: source.logicalMemoryId,
          teamId,
          teamWorkspaceId: destination.teamWorkspaceId
        });
        if (!isCurrent()) return;
        if (!replica) throw new Error("This processed memory is not available from an authorized ready Team replica in the browser yet. Open Studio on the source device to prepare it.");
        if (
          replica.source.kind !== "captured_session" ||
          replica.source.sessionId !== source.id ||
          replica.source.logicalMemoryId !== source.logicalMemoryId
        ) throw new Error("The ready Team replica does not match this exact Conversation. Refresh My shares and try again.");
        const previewRetentionEnabled = targetGrant?.retentionEnabled === true || currentRetentionSetting.enabled;
        const prepared = await client.previewOwnedSource({
          source: replica.source,
          logicalMemoryId: source.logicalMemoryId,
          remoteReplicaId: replica.remoteReplicaId,
          teamId,
          teamWorkspaceId: destination.teamWorkspaceId,
          activationRepresentation: maximumFidelity,
          maximumFidelity,
          includeCuratedMemory: false,
          mode,
          retentionEnabled: previewRetentionEnabled,
          memberRetentionVersion: currentRetentionSetting.version
        });
        if (!isCurrent()) return;
        if (
          prepared.source.kind !== "captured_session" ||
          prepared.source.sessionId !== source.id ||
          prepared.source.logicalMemoryId !== source.logicalMemoryId ||
          prepared.logicalMemoryId !== source.logicalMemoryId ||
          prepared.teamId !== teamId ||
          prepared.teamWorkspaceId !== destination.teamWorkspaceId ||
          prepared.sourceRevision !== replica.sourceRevision ||
          prepared.items.length === 0 ||
          prepared.retentionEnabled !== previewRetentionEnabled ||
          prepared.retentionPolicyEnabled !== currentRetentionSetting.enabled ||
          prepared.memberRetentionVersion !== currentRetentionSetting.version
        ) throw new Error("The ready source or retention policy changed during preview. Prepare a fresh preview.");
        setCandidate(null);
        setPreview(prepared);
        return;
      }
      const destinationResult = await client.run("collaboration.ensure_team_memory_destination", { teamId });
      if (!isCurrent()) return;
      const destination = resultData<{ teamId: string; workspaceId: string }>(
        destinationResult,
        "collaboration.ensure_team_memory_destination"
      );
      if (destination.teamId !== teamId) throw new Error("The Team destination changed. Reload and try again.");
      const grantsResult = await client.run("collaboration.list_owned_shared_memory_grants", { logicalMemoryId: source.logicalMemoryId });
      if (!isCurrent()) return;
      const grants = resultData<{ grants: Array<{ id: string; teamId: string; workspaceId: string; lifecycle: string; grantVersion: number; retentionEnabled: boolean }> }>(
        grantsResult,
        "collaboration.list_owned_shared_memory_grants"
      ).grants;
      const currentTargetGrant = grants.find((grant) => grant.teamId === teamId && grant.workspaceId === destination.workspaceId && grant.lifecycle === "active") ?? null;
      const pendingScan = await findPendingOwnedShare({
        loadPage: async (cursor) => {
          const sharesResult = await client.run("collaboration.list_owned_shares", { cursor, limit: 100, history: false });
          const ownerShares = resultData<{ shares: OwnedShareItem[]; nextCursor: string | null }>(sharesResult, "collaboration.list_owned_shares");
          return ownerShares;
        },
        isCurrent,
        logicalMemoryId: source.logicalMemoryId,
        teamId,
        workspaceId: destination.workspaceId,
        pageLimit: 10
      });
      if (!isCurrent()) return;
      if (pendingScan.found) {
        throw new Error("A share for this Team is already preparing or needs attention. Check Settings → Teams → Memory → My shares before trying again.");
      }
      if (!pendingScan.complete) {
        throw new Error("Could not verify all existing shares for this Team. Review My shares before retrying.");
      }
      if (!isCurrent()) return;
      setTargetGrant(currentTargetGrant ? {
        id: currentTargetGrant.id,
        grantVersion: currentTargetGrant.grantVersion,
        retentionEnabled: currentTargetGrant.retentionEnabled
      } : null);
      const previewRetentionEnabled = currentTargetGrant?.retentionEnabled === true || currentRetentionSetting.enabled;
      const candidateResult = await client.run("collaboration.preview_shared_memory_candidate", {
          source: sourceRef,
          activationRepresentation: maximumFidelity,
          mode
        });
      if (!isCurrent()) return;
      const prepared = resultData<{ candidate: SharedMemoryCandidatePreview }>(
        candidateResult,
        "collaboration.preview_shared_memory_candidate"
      ).candidate;
      if (
        prepared.source.kind !== "captured_session" ||
        prepared.source.sessionId !== source.id ||
        prepared.source.logicalMemoryId !== source.logicalMemoryId ||
        prepared.logicalMemoryId !== source.logicalMemoryId ||
        prepared.items.length === 0 ||
        prepared.itemCount === 0
      ) {
        throw new Error("No privacy-processed memory is available for this Conversation yet.");
      }
      if (!isCurrent()) return;
      setCandidate(prepared);
      const candidateBinding = {
        source: prepared.source,
        sourceCapabilities: prepared.sourceCapabilities,
        activationRepresentation: prepared.activationRepresentation,
        candidateHash: prepared.candidateHash,
        sourceRevision: prepared.sourceRevision,
        itemCount: prepared.itemCount,
        excludedItemCount: prepared.excludedItemCount,
        manifest: prepared.manifest,
        byteCount: prepared.byteCount,
        mode,
        expiresAt: prepared.expiresAt
      };
      const previewResult = await client.run("collaboration.preview_shared_memory", {
          source: prepared.source,
          logicalMemoryId: prepared.logicalMemoryId,
          teamId,
          workspaceId: destination.workspaceId,
          sourceCapabilities: prepared.sourceCapabilities,
          activationRepresentation: maximumFidelity,
          maximumFidelity,
          includeCuratedMemory: false,
          retentionEnabled: previewRetentionEnabled,
          memberRetentionVersion: currentRetentionSetting.version,
          mode,
          candidate: candidateBinding
        });
      if (!isCurrent()) return;
      const nextPreview = resultData<{ preview: SharedMemoryPreview }>(
        previewResult,
        "collaboration.preview_shared_memory"
      ).preview;
      if (!isCurrent()) return;
      if (
        nextPreview.sourceRevision !== prepared.sourceRevision ||
        nextPreview.teamId !== teamId ||
        nextPreview.workspaceId !== destination.workspaceId ||
        nextPreview.retentionEnabled !== previewRetentionEnabled ||
        nextPreview.retentionPolicyEnabled !== currentRetentionSetting.enabled ||
        nextPreview.memberRetentionVersion !== currentRetentionSetting.version
      ) {
        throw new Error("The source or retention policy changed during preview. Prepare a fresh preview.");
      }
      let completePreview = nextPreview;
      let cursor = nextPreview.nextCursor;
      while (cursor) {
        const pageResult = await client.run("collaboration.load_shared_memory_preview_page", {
            previewHash: nextPreview.previewHash,
            cursor,
            limit: 50
          });
        if (!isCurrent()) return;
        const page = resultData<{ preview: SharedMemoryPreview }>(
          pageResult,
          "collaboration.load_shared_memory_preview_page"
        ).preview;
        if (!isCurrent()) return;
        if (page.previewHash !== nextPreview.previewHash || page.sourceRevision !== nextPreview.sourceRevision) {
          throw new Error("The preview changed while loading. Prepare a fresh preview.");
        }
        completePreview = {
          ...completePreview,
          items: [...completePreview.items, ...page.items],
          nextCursor: page.nextCursor
        };
        cursor = page.nextCursor;
      }
      setPreview(completePreview);
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : "The privacy-processed preview is unavailable.");
      }
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  };

  const confirmShare = async () => {
    if (!preview || (!hostedBrowser && !candidate) || !retentionSetting) return;
    if (!source.logicalMemoryId) return;
    const sequence = ++requestSequence.current;
    const isCurrent = () => sequence === requestSequence.current;
    setBusy(true);
    setError(null);
    try {
      if (hostedBrowser) {
        if (!isHostedPreview(preview)) throw new Error("Prepare a fresh browser preview before confirming.");
        const destination = await client.ensureTeamMemoryDestination(teamId);
        if (!isCurrent()) return;
        if (destination.teamId !== teamId || destination.teamWorkspaceId !== preview.teamWorkspaceId) {
          throw new Error("The Team destination changed after preview. Prepare a fresh preview.");
        }
        const currentRetention = await client.getTeamMemoryRetention(teamId);
        if (!isCurrent()) return;
        if (
          currentRetention.version !== preview.memberRetentionVersion ||
          (preview.retentionEnabled && !currentRetention.enabled && !targetGrant?.retentionEnabled) ||
          currentRetention.enabled !== preview.retentionPolicyEnabled
        ) {
          setPreview(null);
          setRetentionSetting({ teamId, enabled: currentRetention.enabled, version: currentRetention.version });
          throw new Error("The Team retention setting changed after preview. Review a fresh preview before sharing.");
        }
        const readyReplica: HostedReadyOwnerReplica | null = await client.getReadyOwnerMemoryReplica({
          logicalMemoryId: source.logicalMemoryId,
          teamId,
          teamWorkspaceId: destination.teamWorkspaceId
        });
        if (!isCurrent()) return;
        if (
          !readyReplica ||
          readyReplica.source.sessionId !== source.id ||
          readyReplica.source.logicalMemoryId !== source.logicalMemoryId ||
          readyReplica.sourceRevision !== preview.sourceRevision
        ) {
          setPreview(null);
          throw new Error("The ready source changed after preview. Prepare a fresh preview.");
        }
        const mutationId = crypto.randomUUID();
        const consentId = crypto.randomUUID();
        const common = {
          source: preview.source,
          sourceCapabilities: preview.sourceCapabilities,
          activationRepresentation: preview.activationRepresentation,
          mutationId,
          consentId,
          logicalMemoryId: preview.logicalMemoryId,
          teamId: preview.teamId,
          teamWorkspaceId: preview.teamWorkspaceId,
          previewId: preview.previewId,
          previewHash: preview.previewHash,
          previewRevision: preview.previewRevision,
          mode: preview.mode,
          maximumFidelity: preview.maximumFidelity,
          includeCuratedMemory: preview.includeCuratedMemory,
          retentionEnabled: preview.retentionEnabled,
          retentionPolicyEnabled: preview.retentionPolicyEnabled,
          memberRetentionVersion: preview.memberRetentionVersion
        };
        const result = targetGrant
          ? await client.changeOwnedSourceFidelity(targetGrant.id, {
              ...common,
              expectedGrantVersion: targetGrant.grantVersion
            })
          : await client.shareOwnedSource({
              ...common,
              logicalGrantId: crypto.randomUUID()
            });
        if (!isCurrent()) return;
        const resultData = result as { grant?: unknown; representation?: { state?: unknown } | null };
        if (!resultData.grant) throw new Error("Koed returned no active Team share.");
        const ready = resultData.representation?.state === "available";
        setCompleteMessage(targetGrant
          ? ready
            ? "The privacy-processed copy was refreshed for this Team."
            : "The update is preparing. The current Team copy stays available until the new representation is ready."
          : ready
            ? "The privacy-processed snapshot is shared with this Team."
            : "The share is preparing. It will appear when privacy filtering and activation finish.");
        setPreview(null);
        setCandidate(null);
        onComplete?.();
        return;
      }
      if (!candidate) throw new Error("Prepare a fresh privacy preview before confirming.");
      const destinationResult = await client.run("collaboration.ensure_team_memory_destination", { teamId });
      if (!isCurrent()) return;
      const destination = resultData<{ teamId: string; workspaceId: string }>(
        destinationResult,
        "collaboration.ensure_team_memory_destination"
      );
      if (destination.teamId !== teamId || destination.workspaceId !== previewWorkspaceId(preview)) {
        throw new Error("The Team destination changed after preview. Prepare a fresh preview.");
      }
      const retentionResult = await client.run("collaboration.get_team_memory_retention", { teamId });
      if (!isCurrent()) return;
      const currentRetention = resultData<{ setting: { enabled: boolean; version: number } }>(
        retentionResult,
        "collaboration.get_team_memory_retention"
      ).setting;
      if (
        currentRetention.version !== preview.memberRetentionVersion ||
        (preview.retentionEnabled && !currentRetention.enabled && !targetGrant?.retentionEnabled)
      ) {
        if (isCurrent()) {
          setPreview(null);
          setCandidate(null);
          setRetentionSetting({ teamId, enabled: currentRetention.enabled, version: currentRetention.version });
        }
        throw new Error("The Team retention setting changed after preview. Review a fresh preview before sharing.");
      }
      const grantsResult = await client.run("collaboration.list_owned_shared_memory_grants", {
          logicalMemoryId: source.logicalMemoryId
        });
      if (!isCurrent()) return;
      const grants = resultData<{ grants: Array<{ id: string; teamId: string; workspaceId: string; lifecycle: string; grantVersion: number }> }>(
        grantsResult,
        "collaboration.list_owned_shared_memory_grants"
      ).grants;
      if (!isCurrent()) return;
      const target = grants.find((grant) => grant.teamId === teamId && grant.workspaceId === destination.workspaceId && grant.lifecycle === "active");
      if (
        (targetGrant === null && target !== undefined) ||
        (targetGrant !== null && (!target || target.id !== targetGrant.id || target.grantVersion !== targetGrant.grantVersion))
      ) {
        setPreview(null);
        setCandidate(null);
        throw new Error("This Team share changed after preview. Prepare a fresh preview.");
      }
      const common = {
        source: candidate.source,
        sourceCapabilities: candidate.sourceCapabilities,
        activationRepresentation: candidate.activationRepresentation,
        logicalMemoryId: candidate.logicalMemoryId,
        teamId,
        workspaceId: destination.workspaceId,
        mode,
        retentionEnabled: preview.retentionEnabled,
        memberRetentionVersion: preview.memberRetentionVersion,
        maximumFidelity,
        includeCuratedMemory: preview.includeCuratedMemory,
        previewRevision: preview.previewRevision,
        previewHash: preview.previewHash,
        expiresAt: null,
        consentId: crypto.randomUUID()
      };
      const result = target
        ? await client.run("collaboration.change_shared_memory_fidelity", {
            ...common,
            mutationId: crypto.randomUUID(),
            shareGrantId: target.id,
            expectedGrantVersion: target.grantVersion
          })
        : await client.run("collaboration.share_memory", {
            ...common,
            mutationId: crypto.randomUUID(),
          logicalGrantId: crypto.randomUUID()
          });
      if (!isCurrent()) return;
      if (result.command === "collaboration.change_shared_memory_fidelity") {
        resultData<{ pendingShare: unknown }>(result, "collaboration.change_shared_memory_fidelity");
        setCompleteMessage("The updated share is preparing. The current Team copy stays available until the update is ready.");
      } else if (result.command === "collaboration.share_memory") {
        const data = resultData<{ grant?: unknown; pendingShare?: unknown }>(result, "collaboration.share_memory");
        setCompleteMessage("grant" in data ? "The privacy-processed snapshot is shared with this Team." : "The share is preparing. It will appear when privacy filtering and activation finish.");
      }
      setPreview(null);
      setCandidate(null);
      onComplete?.();
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : "The share could not be confirmed.");
      }
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  };

  const selectedTeam = teams.find((team) => team.id === teamId);
  const currentRetentionSetting = retentionSetting?.teamId === teamId ? retentionSetting : null;
  const previewNeedsRetentionConsent = preview?.retentionEnabled === true;
  const previewItems = preview?.items ?? [];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="share-memory-title" className="flex max-h-[min(90vh,760px)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border bg-background/50 px-5 py-4">
          <div className="min-w-0">
            <h2 id="share-memory-title" className="text-sm font-semibold text-foreground">Share processed memory</h2>
            <p className="mt-1 truncate text-xs text-muted">{source.title}</p>
          </div>
            <button type="button" aria-label="Close sharing dialog" disabled={busy} onClick={onClose} className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!completeMessage ? <>
            <p className="text-xs leading-5 text-muted">Only privacy-processed memory appears in the preview. Sharing does not grant access to the transcript or source files.</p>
            <label className="block space-y-1.5 text-xs font-medium text-foreground-secondary">Team
              <select value={teamId} disabled={busy || teams.length === 0 || Boolean(preview)} onChange={(event) => { setTeamId(event.target.value); setRetentionAcknowledged(false); setTargetGrant(null); setPreview(null); setCandidate(null); setError(null); }} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </label>
            <fieldset disabled={busy || Boolean(preview)} className="space-y-2">
              <legend className="mb-2 text-xs font-medium text-foreground-secondary">Sharing mode</legend>
              <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs"><input type="radio" name="shared-memory-mode" checked={mode === "snapshot"} onChange={() => setMode("snapshot")} /><span><strong className="text-foreground">Snapshot</strong><span className="mt-0.5 block text-muted">Share this reviewed version. It will not update automatically.</span></span></label>
              <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs"><input type="radio" name="shared-memory-mode" checked={mode === "continuous"} onChange={() => setMode("continuous")} /><span><strong className="text-foreground">Ongoing updates</strong><span className="mt-0.5 block text-muted">Allow this Team’s copy to receive future privacy-processed updates.</span></span></label>
            </fieldset>
            <label className="block space-y-1.5 text-xs font-medium text-foreground-secondary">Representation ceiling
              <select value={maximumFidelity} disabled={busy || Boolean(preview)} onChange={(event) => { setMaximumFidelity(event.target.value as SharedMemoryFidelityCeiling); setCandidate(null); setPreview(null); }} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
                <option value="memory_events">Memory Events</option>
                <option value="lcm_leaves">LCM Leaves</option>
                <option value="lcm_rollups">LCM Rollups</option>
              </select>
            </label>
            {currentRetentionSetting && <p className="text-[11px] text-faint">{targetGrant?.retentionEnabled ? "This share’s retained-copy choice stays enabled." : currentRetentionSetting.enabled ? "This Team enables retention for your future shares." : "This Team has disabled retention for new shares."} Retention policy version {currentRetentionSetting.version}.</p>}
            {!preview ? <button type="button" disabled={busy || !teamId || !currentRetentionSetting} onClick={() => void preparePreview()} className="rounded-md bg-chip px-3 py-2 text-xs font-medium text-chip-foreground hover:bg-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Preparing privacy preview…" : "Preview memory"}</button> : null}
            {(candidate || hostedBrowser) && preview ? <div className="space-y-3 rounded-md border border-border bg-background/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted"><span>{selectedTeam?.name} · {mode === "snapshot" ? "Snapshot" : "Ongoing updates"}</span><span>Source revision {preview.sourceRevision} · {previewItemCount(preview)} item{previewItemCount(preview) === 1 ? "" : "s"}</span></div>
              <div className="max-h-56 space-y-2 overflow-y-auto">{previewItems.map((item) => <article key={"sourceId" in item ? `${item.itemType}:${item.sourceId}` : `${item.representation}:${item.id}`} className="rounded-md border border-border/70 bg-surface px-3 py-2"><p className="whitespace-pre-wrap text-xs leading-5 text-foreground-secondary">{previewText(item)}</p></article>)}</div>
              <p className="text-[11px] text-muted">This exact preview is bound to revision {preview.sourceRevision} and hash {preview.previewHash.slice(0, 12)}…{preview.retentionEnabled ? " Retention was explicitly included." : " No retained copy was requested."}</p>
              {preview.retentionEnabled ? <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs"><input type="checkbox" checked={retentionAcknowledged} disabled={busy} onChange={(event) => setRetentionAcknowledged(event.target.checked)} /><span><strong className="text-foreground">I consent to a retained Team copy.</strong><span className="mt-0.5 block text-muted">This representation can stay available after you stop sharing, leave the Team, or delete the Personal source. A Team admin can remove it.</span></span></label> : null}
            </div> : null}
            {preview ? <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-5 text-foreground-secondary"><strong className="text-foreground">Confirm sharing with {selectedTeam?.name ?? "this Team"}.</strong><p className="mt-1">All current Team members, including people who join later, may recall this representation. You can stop future updates per Team. {preview.retentionEnabled ? "The retained copy remains until a Team admin removes it." : "Without retention, stopping sharing blocks future recall."}</p></div> : null}
          </> : <p role="status" className="rounded-md border border-success/30 bg-success/5 px-3 py-3 text-sm text-foreground-secondary">{completeMessage}</p>}
          {error ? <p role="alert" className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border bg-background/50 px-5 py-3">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground">{completeMessage ? "Done" : "Cancel"}</button>
          {preview && !completeMessage ? <button type="button" disabled={busy || previewItemCount(preview) === 0 || (previewNeedsRetentionConsent && !retentionAcknowledged)} onClick={() => void confirmShare()} className="rounded-md bg-chip px-3 py-2 text-xs font-medium text-chip-foreground hover:bg-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Confirming…" : "Confirm share"}</button> : null}
        </footer>
      </section>
    </div>
  );
}
