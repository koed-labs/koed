"use client";

import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSnapshotSchema,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSnapshot,
  type CollaborationSubscription
} from "@koed/shared/collaboration";
import type { SharedMemoryFidelityCeiling, SharedMemoryRepresentation, SharedMemorySourceItem } from "@koed/shared";
import { sharedMemoryRepresentationSchema, sharedMemorySourceItemSchema } from "@koed/shared";

export type StudioTeamDraftAuthority = {
  backendId: string;
  principalUserId: string;
  teamId: string;
  threadId: string;
};

export type StudioTeamDraft = {
  text: string;
  pendingSend: {
    clientMessageId: string;
    body: string;
    createdAt: string;
  } | null;
  receiptAckPending?: {
    clientMessageId: string;
    messageId: string;
  } | null;
  updatedAt?: string;
};

export type HostedStudioNavigation = {
  kind: "hosted_browser";
  principal: { id: string; displayName: string | null };
  teams: Array<{
    team: Record<string, unknown> & { id: string; name: string };
    membership: Record<string, unknown> & { teamId: string; userId: string; status: string; role: string };
    members: Array<Record<string, unknown> & { userId: string; displayName: string | null }>;
    workspaces: Array<{
      teamWorkspace: Record<string, unknown> & { id: string; teamId: string };
      access: Record<string, unknown> & { teamId: string; teamWorkspaceId: string; userId: string; access: string };
      shareGrants: Array<Record<string, unknown> & { id: string; logicalMemoryId: string }>;
    }>;
  }>;
};

export type HostedRetentionSetting = { teamId: string; userId: string; enabled: boolean; version: number };
export type HostedReadyOwnerReplica = {
  remoteReplicaId: string;
  sourceRevision: number;
  source: { kind: "captured_session"; sessionId: string; logicalMemoryId: string };
};
export type HostedOwnedSourcePreview = {
  source: HostedReadyOwnerReplica["source"];
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  mode: "snapshot" | "continuous";
  previewId: string;
  previewHash: string;
  previewRevision: number;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  retentionEnabled: boolean;
  retentionPolicyEnabled: boolean;
  memberRetentionVersion: number;
  binding: {
    sourceRevision: number;
    sourceHash: string;
    fidelityPolicyRevision: number;
    fidelityPolicyHash: string;
    contentPolicyVersion: number;
    contentPolicyHash: string;
    classifierVersion: number;
    classifierHash: string;
  };
  items: SharedMemorySourceItem[];
  sourceContentHash: string;
  sourceRevision: number;
  sourceHash: string;
  createdAt: string;
};
export type HostedOwnedShare = Record<string, unknown> & {
  kind: "grant" | "pending";
  grant?: Record<string, unknown> & {
    id: string;
    logicalMemoryId: string;
    source: HostedReadyOwnerReplica["source"];
    teamId: string;
    teamWorkspaceId: string;
    grantVersion: number;
    retentionEnabled: boolean;
    memberRetentionVersion: number;
  };
  pendingShare?: Record<string, unknown>;
};
export type HostedShareBundleResult = {
  consent: Record<string, unknown>;
  grant: Record<string, unknown>;
  /** Null means consent/grant are durable but privacy processing is still preparing. */
  representation: Record<string, unknown> | null;
};

export class StudioCollaborationRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: string | null = null, retryable = status === 429 || status >= 500) {
    super(message);
    this.name = "StudioCollaborationRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const matchesCapturedSource = (value: unknown, expected: HostedReadyOwnerReplica["source"]): boolean =>
  isRecord(value) && value.kind === "captured_session" &&
  value.sessionId === expected.sessionId && value.logicalMemoryId === expected.logicalMemoryId;

const validateHostedShareBundle = (
  value: unknown,
  expected: {
    source: HostedReadyOwnerReplica["source"];
    sourceCapabilities: string[];
    activationRepresentation: string;
    consentId: string;
    logicalMemoryId: string;
    teamId: string;
    teamWorkspaceId: string;
    previewId: string;
    previewHash: string;
    previewRevision: number;
    mode: "snapshot" | "continuous";
    maximumFidelity: string;
    includeCuratedMemory: boolean;
    retentionEnabled: boolean;
    retentionPolicyEnabled: boolean;
    memberRetentionVersion: number;
    logicalGrantId?: string;
    shareGrantId?: string;
  }
): HostedShareBundleResult => {
  if (!isRecord(value) || !isRecord(value.consent) || !isRecord(value.grant) ||
    (value.representation !== null && !isRecord(value.representation))) {
    throw new StudioCollaborationRequestError("Koed returned an invalid share result.", 502);
  }
  const consent = value.consent;
  const grant = value.grant;
  const commonMatches = (record: Record<string, unknown>) =>
    matchesCapturedSource(record.source, expected.source) &&
    Array.isArray(record.sourceCapabilities) && JSON.stringify(record.sourceCapabilities) === JSON.stringify(expected.sourceCapabilities) &&
    record.activationRepresentation === expected.activationRepresentation &&
    record.logicalMemoryId === expected.logicalMemoryId && record.teamId === expected.teamId &&
    record.teamWorkspaceId === expected.teamWorkspaceId && record.mode === expected.mode &&
    record.maximumFidelity === expected.maximumFidelity && record.includeCuratedMemory === expected.includeCuratedMemory &&
    record.retentionEnabled === expected.retentionEnabled &&
    record.memberRetentionVersion === expected.memberRetentionVersion;
  if (consent.id !== expected.consentId || !commonMatches(consent) ||
    consent.previewId !== expected.previewId || consent.previewHash !== expected.previewHash ||
    consent.previewRevision !== expected.previewRevision || consent.retentionPolicyEnabled !== expected.retentionPolicyEnabled ||
    !Number.isSafeInteger(consent.version) || (consent.version as number) < 1 ||
    typeof grant.id !== "string" || !commonMatches(grant) || grant.consentId !== expected.consentId ||
    !Number.isSafeInteger(grant.grantVersion) || (grant.grantVersion as number) < 1 ||
    (expected.logicalGrantId !== undefined && grant.logicalGrantId !== expected.logicalGrantId) ||
    (expected.shareGrantId !== undefined && grant.id !== expected.shareGrantId)) {
    throw new StudioCollaborationRequestError("Koed returned a share result for a different consent or Team scope.", 502);
  }
  if (value.representation !== null) {
    const representation = value.representation;
    if (!isRecord(representation) || representation.shareGrantId !== grant.id || representation.consentId !== expected.consentId ||
      representation.teamId !== expected.teamId || representation.teamWorkspaceId !== expected.teamWorkspaceId ||
      representation.representation !== expected.activationRepresentation ||
      !["available", "pending", "stale", "invalidated", "purge_pending", "purged"].includes(String(representation.state))) {
      throw new StudioCollaborationRequestError("Koed returned a representation for a different share result.", 502);
    }
  }
  return value as HostedShareBundleResult;
};

const wait = (signal: AbortSignal, duration = 1_000) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, duration);
    signal.addEventListener("abort", finish, { once: true });
  });

const MAX_EVENT_FRAME_BYTES = 2 * 1024 * 1024;

export const canApplySubscriptionSnapshot = (input: {
  currentVersion: number | null;
  snapshotVersion: number;
  alreadyAcknowledged: boolean;
}): boolean => !input.alreadyAcknowledged &&
  (input.currentVersion === null || input.snapshotVersion >= input.currentVersion);

export class StudioCollaborationClient {
  private readonly fetcher: typeof fetch;
  private csrfToken: string | null = null;
  private currentSnapshot: CollaborationSnapshot | null = null;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher.bind(globalThis);
  }

  current(): CollaborationSnapshot | null {
    return this.currentSnapshot;
  }

  /** Hosted web navigation is intentionally not coerced into the desktop snapshot. */
  async loadHostedSession(): Promise<HostedStudioNavigation> {
    const body = await this.browserApi("/v1/teams/navigation");
    if (!isRecord(body) || !isRecord(body.principal) || typeof body.principal.id !== "string" || !Array.isArray(body.teams)) {
      throw new StudioCollaborationRequestError("Koed returned invalid Team navigation.", 502);
    }
    const teams = body.teams.map((entry): HostedStudioNavigation["teams"][number] | null => {
      if (!isRecord(entry) || !isRecord(entry.team) || !isRecord(entry.membership) ||
        typeof entry.team.id !== "string" || typeof entry.team.name !== "string" ||
        typeof entry.membership.teamId !== "string" || typeof entry.membership.userId !== "string" ||
        typeof entry.membership.status !== "string" || typeof entry.membership.role !== "string" ||
        !Array.isArray(entry.members) || !Array.isArray(entry.workspaces)) return null;
      const members = entry.members.map((member) => isRecord(member) && typeof member.userId === "string" && (member.displayName === null || typeof member.displayName === "string") ? member as HostedStudioNavigation["teams"][number]["members"][number] : null);
      const workspaces = entry.workspaces.map((workspace) => {
        if (!isRecord(workspace) || !isRecord(workspace.teamWorkspace) || !isRecord(workspace.access) || !Array.isArray(workspace.shareGrants) ||
          typeof workspace.teamWorkspace.id !== "string" || typeof workspace.teamWorkspace.teamId !== "string" ||
          typeof workspace.access.teamId !== "string" || typeof workspace.access.teamWorkspaceId !== "string" ||
          typeof workspace.access.userId !== "string" || typeof workspace.access.access !== "string") return null;
        const shareGrants = workspace.shareGrants.map((grant) => isRecord(grant) && typeof grant.id === "string" && typeof grant.logicalMemoryId === "string" ? grant as HostedStudioNavigation["teams"][number]["workspaces"][number]["shareGrants"][number] : null);
        if (shareGrants.some((grant) => !grant)) return null;
        return { teamWorkspace: workspace.teamWorkspace as HostedStudioNavigation["teams"][number]["workspaces"][number]["teamWorkspace"], access: workspace.access as HostedStudioNavigation["teams"][number]["workspaces"][number]["access"], shareGrants: shareGrants as HostedStudioNavigation["teams"][number]["workspaces"][number]["shareGrants"] };
      });
      if (members.some((member) => !member) || workspaces.some((workspace) => !workspace)) return null;
      return {
        team: entry.team as HostedStudioNavigation["teams"][number]["team"],
        membership: entry.membership as HostedStudioNavigation["teams"][number]["membership"],
        members: members as HostedStudioNavigation["teams"][number]["members"],
        workspaces: workspaces as HostedStudioNavigation["teams"][number]["workspaces"]
      };
    });
    if (teams.some((team) => !team)) throw new StudioCollaborationRequestError("Koed returned invalid Team navigation.", 502);
    return {
      kind: "hosted_browser",
      principal: { id: body.principal.id, displayName: typeof body.principal.displayName === "string" ? body.principal.displayName : null },
      teams: teams as HostedStudioNavigation["teams"]
    };
  }

  async getTeamMemoryRetention(teamId: string): Promise<HostedRetentionSetting> {
    const body = await this.browserApi(`/v1/teams/${encodeURIComponent(teamId)}/memory-retention`);
    if (!isRecord(body) || !isRecord(body.setting) || body.setting.teamId !== teamId || typeof body.setting.userId !== "string" || typeof body.setting.enabled !== "boolean" || !Number.isSafeInteger(body.setting.version)) throw new StudioCollaborationRequestError("Koed returned invalid Team retention settings.", 502);
    return body.setting as HostedRetentionSetting;
  }

  async listTeamMemoryRetentionMembers(teamId: string): Promise<{ teamId: string; members: Array<{ userId: string; displayName: string | null; enabled: boolean; version: number }> }> {
    const body = await this.browserApi(`/v1/teams/${encodeURIComponent(teamId)}/memory-retention/members`);
    if (!isRecord(body) || body.teamId !== teamId || !Array.isArray(body.members)) throw new StudioCollaborationRequestError("Koed returned invalid Team retention members.", 502);
    const members = body.members.map((member) => isRecord(member) && typeof member.userId === "string" && (member.displayName === null || typeof member.displayName === "string") && typeof member.enabled === "boolean" && Number.isSafeInteger(member.version) ? member as { userId: string; displayName: string | null; enabled: boolean; version: number } : null);
    if (members.some((member) => !member)) throw new StudioCollaborationRequestError("Koed returned invalid Team retention members.", 502);
    return { teamId, members: members as NonNullable<(typeof members)[number]>[] };
  }

  async updateTeamMemoryRetention(input: { teamId: string; userId: string; enabled: boolean; expectedVersion: number; mutationId: string }): Promise<{ policy: HostedRetentionSetting }> {
    const body = await this.browserApi(`/v1/teams/${encodeURIComponent(input.teamId)}/members/${encodeURIComponent(input.userId)}/memory-retention`, { method: "PATCH", body: { enabled: input.enabled, expectedVersion: input.expectedVersion, mutationId: input.mutationId } });
    if (!isRecord(body) || !isRecord(body.policy) || body.policy.teamId !== input.teamId || body.policy.userId !== input.userId || body.policy.enabled !== input.enabled || !Number.isSafeInteger(body.policy.version)) throw new StudioCollaborationRequestError("Koed returned invalid Team retention update.", 502);
    return { policy: body.policy as HostedRetentionSetting };
  }

  async ensureTeamMemoryDestination(teamId: string): Promise<{ teamId: string; teamWorkspaceId: string }> {
    const body = await this.browserApi(`/v1/shared-memory/teams/${encodeURIComponent(teamId)}/destination`, { method: "POST", body: {} });
    if (!isRecord(body) || body.teamId !== teamId || typeof body.teamWorkspaceId !== "string") throw new StudioCollaborationRequestError("Team memory destination is unavailable.", 502);
    return { teamId, teamWorkspaceId: body.teamWorkspaceId };
  }

  async getReadyOwnerMemoryReplica(input: { logicalMemoryId: string; teamId: string; teamWorkspaceId: string }): Promise<HostedReadyOwnerReplica | null> {
    const query = new URLSearchParams(input);
    const body = await this.browserApi(`/v1/shared-memory/preview-target?${query}`);
    if (!isRecord(body) || body.ready === false) return null;
    if (!isRecord(body.source) || body.source.kind !== "captured_session" || body.source.logicalMemoryId !== input.logicalMemoryId || typeof body.source.sessionId !== "string" || typeof body.remoteReplicaId !== "string" || !Number.isSafeInteger(body.sourceRevision)) throw new StudioCollaborationRequestError("Koed returned invalid owner source metadata.", 502);
    return { remoteReplicaId: body.remoteReplicaId, sourceRevision: body.sourceRevision as number, source: body.source as HostedReadyOwnerReplica["source"] };
  }

  async previewOwnedSource(input: {
    source: HostedReadyOwnerReplica["source"];
    logicalMemoryId: string;
    remoteReplicaId: string;
    teamId: string;
    teamWorkspaceId: string;
    activationRepresentation: string;
    maximumFidelity: string;
    includeCuratedMemory: boolean;
    mode: "snapshot" | "continuous";
    retentionEnabled: boolean;
    memberRetentionVersion: number;
  }): Promise<HostedOwnedSourcePreview> {
    const body = await this.browserApi("/v1/shared-memory/previews", { method: "POST", body: { ...input, sourceCapabilities: [input.activationRepresentation], authority: { action: "shared_memory.authority", source: "browser_session" } } });
    const preview = isRecord(body) && isRecord(body.preview) ? body.preview : null;
    const validHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
    const validVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
    const binding = preview && isRecord(preview.binding) ? preview.binding : null;
    const source = preview && isRecord(preview.source) ? preview.source : null;
    const items = preview && Array.isArray(preview.items) ? preview.items : null;
    if (!preview || !source || !binding || !items ||
      source.kind !== "captured_session" || source.sessionId !== input.source.sessionId || source.logicalMemoryId !== input.source.logicalMemoryId ||
      !Array.isArray(preview.sourceCapabilities) || !preview.sourceCapabilities.includes(input.activationRepresentation) || preview.sourceCapabilities.some((capability) => !sharedMemoryRepresentationSchema.safeParse(capability).success) ||
      preview.activationRepresentation !== input.activationRepresentation || preview.representation !== input.activationRepresentation ||
      (preview.mode !== "snapshot" && preview.mode !== "continuous") || preview.mode !== input.mode ||
      typeof preview.previewId !== "string" || !validHash(preview.previewHash) || !validVersion(preview.previewRevision) ||
      preview.logicalMemoryId !== input.logicalMemoryId || preview.teamId !== input.teamId || preview.teamWorkspaceId !== input.teamWorkspaceId ||
      preview.maximumFidelity !== input.maximumFidelity || preview.includeCuratedMemory !== input.includeCuratedMemory ||
      preview.retentionEnabled !== input.retentionEnabled || typeof preview.retentionPolicyEnabled !== "boolean" ||
      preview.memberRetentionVersion !== input.memberRetentionVersion || !validVersion(preview.memberRetentionVersion) ||
      !validVersion(binding.sourceRevision) || !validHash(binding.sourceHash) || !validVersion(binding.fidelityPolicyRevision) || !validHash(binding.fidelityPolicyHash) ||
      !validVersion(binding.contentPolicyVersion) || !validHash(binding.contentPolicyHash) || !validVersion(binding.classifierVersion) || !validHash(binding.classifierHash) ||
      !validHash(preview.sourceContentHash) || !Number.isSafeInteger(preview.sourceRevision) || preview.sourceRevision !== binding.sourceRevision ||
      !validHash(preview.sourceHash) || preview.sourceHash !== binding.sourceHash || typeof preview.createdAt !== "string" || Number.isNaN(Date.parse(preview.createdAt)) ||
      items.length === 0 || items.some((item) => !sharedMemorySourceItemSchema.safeParse(item).success || !isRecord(item) || item.representation !== input.activationRepresentation)) {
      throw new StudioCollaborationRequestError("Koed returned an invalid share preview.", 502);
    }
    return preview as unknown as HostedOwnedSourcePreview;
  }

  async listOwnedShares(input: { limit?: number; afterCreatedAt?: string; afterKind?: "grant" | "pending"; afterId?: string; history?: boolean; snapshotAt?: string } = {}): Promise<{ shares: HostedOwnedShare[]; pagination: { limit: number; hasMore: boolean; next: { createdAt: string; recordKind: "grant" | "pending"; id: string } | null; snapshotAt: string } }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    const body = await this.browserApi(`/v1/shared-memory/owned-shares${query.size ? `?${query}` : ""}`);
    if (!isRecord(body) || !Array.isArray(body.shares) || !isRecord(body.pagination) || !Number.isSafeInteger(body.pagination.limit) || typeof body.pagination.hasMore !== "boolean" || (body.pagination.next !== null && (!isRecord(body.pagination.next) || typeof body.pagination.next.createdAt !== "string" || (body.pagination.next.recordKind !== "grant" && body.pagination.next.recordKind !== "pending") || typeof body.pagination.next.id !== "string")) || typeof body.pagination.snapshotAt !== "string") throw new StudioCollaborationRequestError("Koed returned invalid owned shares.", 502);
    const shares = body.shares.map((entry) => isRecord(entry) && (entry.kind === "grant" || entry.kind === "pending") ? entry as HostedOwnedShare : null);
    if (shares.some((entry) => !entry)) throw new StudioCollaborationRequestError("Koed returned invalid owned shares.", 502);
    return { shares: shares as HostedOwnedShare[], pagination: body.pagination as { limit: number; hasMore: boolean; next: { createdAt: string; recordKind: "grant" | "pending"; id: string } | null; snapshotAt: string } };
  }

  async shareOwnedSource(input: {
    source: HostedReadyOwnerReplica["source"];
    sourceCapabilities: string[];
    activationRepresentation: string;
    mutationId: string;
    logicalGrantId: string;
    consentId: string;
    logicalMemoryId: string;
    teamId: string;
    teamWorkspaceId: string;
    previewId: string;
    previewHash: string;
    previewRevision: number;
    mode: "snapshot" | "continuous";
    maximumFidelity: string;
    includeCuratedMemory: boolean;
    retentionEnabled: boolean;
    retentionPolicyEnabled: boolean;
    memberRetentionVersion: number;
  }): Promise<HostedShareBundleResult> {
    const { previewId, previewHash, ...rest } = input;
    const body = await this.browserApi("/v1/shared-memory/share-bundles", { method: "POST", body: { ...rest, preview: { previewId, previewHash }, authority: { action: "shared_memory.authority", source: "browser_session" } } });
    return validateHostedShareBundle(body, { ...input, logicalGrantId: input.logicalGrantId });
  }

  async changeOwnedSourceFidelity(shareGrantId: string, input: {
    source: HostedReadyOwnerReplica["source"];
    sourceCapabilities: string[];
    activationRepresentation: string;
    mutationId: string;
    consentId: string;
    logicalMemoryId: string;
    teamId: string;
    teamWorkspaceId: string;
    previewId: string;
    previewHash: string;
    previewRevision: number;
    mode: "snapshot" | "continuous";
    maximumFidelity: string;
    includeCuratedMemory: boolean;
    retentionEnabled: boolean;
    retentionPolicyEnabled: boolean;
    memberRetentionVersion: number;
    expectedGrantVersion: number;
  }): Promise<HostedShareBundleResult> {
    const { previewId, previewHash, ...rest } = input;
    const body = await this.browserApi(`/v1/shared-memory/share-grants/${encodeURIComponent(shareGrantId)}/fidelity`, { method: "PUT", body: { ...rest, preview: { previewId, previewHash }, authority: { action: "shared_memory.authority", source: "browser_session" } } });
    return validateHostedShareBundle(body, { ...input, shareGrantId });
  }

  async controlOwnedPendingShare(pendingShareId: string, input: { mutationId: string; expectedOperationVersion: number; action: "retry" | "pause" | "resume" | "revoke" }): Promise<Record<string, unknown>> {
    const body = await this.browserApi(`/v1/shared-memory/pending-shares/${encodeURIComponent(pendingShareId)}/control`, { method: "POST", body: input });
    if (!isRecord(body) || !isRecord(body.pendingShare)) throw new StudioCollaborationRequestError("Koed returned an invalid pending-share update.", 502);
    return body.pendingShare;
  }

  async listRetainedTeamMemory(teamId: string, input: { limit?: number; cursor?: string | null } = {}): Promise<{ teamId: string; items: Array<Record<string, unknown>>; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor !== undefined && input.cursor !== null) query.set("cursor", input.cursor);
    const body = await this.browserApi(`/v1/shared-memory/teams/${encodeURIComponent(teamId)}/retained${query.size ? `?${query}` : ""}`);
    if (!isRecord(body) || body.teamId !== teamId || !Array.isArray(body.items) || (body.nextCursor !== null && typeof body.nextCursor !== "string")) throw new StudioCollaborationRequestError("Koed returned invalid retained Team memory.", 502);
    return { teamId, items: body.items.filter(isRecord), nextCursor: body.nextCursor as string | null };
  }

  async removeRetainedTeamMemory(input: { teamId: string; shareGrantId: string; expectedGrantVersion: number; mutationId: string }): Promise<{ shareGrantId: string; grantVersion: number; removed: boolean }> {
    const body = await this.browserApi(`/v1/shared-memory/teams/${encodeURIComponent(input.teamId)}/retained/${encodeURIComponent(input.shareGrantId)}/remove`, { method: "POST", body: { mutationId: input.mutationId, expectedGrantVersion: input.expectedGrantVersion, authority: { action: "shared_memory.authority", source: "browser_session" } } });
    if (!isRecord(body) || body.shareGrantId !== input.shareGrantId || !Number.isSafeInteger(body.grantVersion) || body.removed !== true) throw new StudioCollaborationRequestError("Koed returned an invalid retained-memory removal.", 502);
    return body as { shareGrantId: string; grantVersion: number; removed: boolean };
  }

  async stopOwnedTeamMemoryUpdates(input: { teamId: string; teamWorkspaceId: string; shareGrantId: string; expectedGrantVersion: number; mutationId: string }): Promise<Record<string, unknown>> {
    const body = await this.browserApi(`/v1/shared-memory/share-grants/${encodeURIComponent(input.shareGrantId)}/owner-stop-updates`, { method: "POST", body: { ...input, authority: { action: "shared_memory.authority", source: "browser_session" } } });
    if (!isRecord(body) || !isRecord(body.grant)) throw new StudioCollaborationRequestError("Koed returned an invalid update-stop result.", 502);
    return body.grant;
  }

  async revokeOwnedShare(input: { teamId: string; teamWorkspaceId: string; shareGrantId: string; expectedGrantVersion: number; mutationId: string; reasonCode: string }): Promise<Record<string, unknown>> {
    const body = await this.browserApi(`/v1/shared-memory/share-grants/${encodeURIComponent(input.shareGrantId)}/revoke`, { method: "POST", body: { ...input, authority: { action: "shared_memory.authority", source: "browser_session" } } });
    if (!isRecord(body) || !isRecord(body.grant)) throw new StudioCollaborationRequestError("Koed returned an invalid share revocation.", 502);
    return body.grant;
  }

  private async browserApi(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    if (!path.startsWith("/v1/")) throw new StudioCollaborationRequestError("Hosted Team route is unavailable.", 404);
    const response = await this.fetcher(path, {
      method: init.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new StudioCollaborationRequestError(
        response.status === 401 || response.status === 403
          ? "Team access changed. Refresh to check access."
          : "Team connection is temporarily unavailable.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    return body;
  }

  async loadSession(): Promise<CollaborationSnapshot> {
    const response = await this.fetcher(
      "/studio-api/collaboration/studio-session",
      {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new StudioCollaborationRequestError(
        "Team connection is temporarily unavailable.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    const snapshot = collaborationSnapshotSchema.safeParse(
      isRecord(body) ? body.snapshot : null
    );
    if (
      !snapshot.success ||
      !isRecord(body) ||
      typeof body.csrfToken !== "string"
    ) {
      throw new StudioCollaborationRequestError(
        "Koed returned invalid Team state.",
        502
      );
    }
    this.csrfToken = body.csrfToken;
    this.currentSnapshot = snapshot.data;
    return snapshot.data;
  }

  async command(
    command: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult> {
    const validCommand = collaborationRendererCommandSchema.parse(command);
    const token = this.csrfToken ?? (await this.loadSession(), this.csrfToken);
    if (!token) throw new StudioCollaborationRequestError("Team session expired.", 403);
    const response = await this.fetcher(
      "/studio-api/collaboration/command",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-studio-csrf": token
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(validCommand)
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 403) this.csrfToken = null;
      throw new StudioCollaborationRequestError(
        response.status === 403
          ? "Team access changed. Refresh to check access."
          : "Team connection is temporarily unavailable.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    const result = collaborationCommandResultSchema.safeParse(body);
    if (
      !result.success ||
      result.data.requestId !== validCommand.requestId ||
      result.data.command !== validCommand.command
    ) {
      throw new StudioCollaborationRequestError(
        "Koed returned an invalid Team command result.",
        502
      );
    }
    if (!result.data.ok) {
      const failure = result.data;
      throw new StudioCollaborationRequestError(
        failure.error.userMessage,
        409,
        failure.error.code,
        failure.error.retryable
      );
    }
    if ("snapshot" in result.data.data) {
      this.currentSnapshot = result.data.data.snapshot;
    }
    return result.data;
  }

  async run(
    command: CollaborationRendererCommand["command"],
    input: Record<string, unknown>,
    requestId: string = crypto.randomUUID()
  ): Promise<CollaborationCommandResult> {
    return await this.command({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command,
      input
    } as CollaborationRendererCommand);
  }

  subscribe(
    listener: (event: CollaborationRendererEvent) => void | boolean | Promise<void | boolean>,
    onSnapshot: ((snapshot: CollaborationSnapshot) => void | Promise<void>) | undefined,
    teamId: string
  ): () => void {
    const controller = new AbortController();
    let resolveStreamReady!: (ready: boolean) => void;
    const streamReady = new Promise<boolean>((resolve) => { resolveStreamReady = resolve; });
    let resolveSubscriptionReady!: (subscription: CollaborationSubscription | null) => void;
    let subscriptionReady: Promise<CollaborationSubscription | null>;
    const resetSubscriptionReady = () => {
      subscriptionReady = new Promise<CollaborationSubscription | null>((resolve) => { resolveSubscriptionReady = resolve; });
    };
    resetSubscriptionReady();
    let subscription: CollaborationSubscription | null = null;
    let stopped = false;
    let subscriptionRevoked = false;
    let eventTail: Promise<void> = Promise.resolve();
    const seenDeliveries = new Set<string>();
    const deliveryOrder: string[] = [];
    let streamOpenedBefore = false;
    const releaseSubscription = (id: string) => {
      void this.run("collaboration.unsubscribe", { subscriptionId: id }).catch(() => undefined);
    };
    const acknowledge = async (event: Extract<CollaborationRendererEvent, { type: "snapshot" | "update" }>) => {
      if (!subscription) return;
      const subscriptionId = subscription.id;
      const result = await this.run("collaboration.acknowledge_delivery", {
        subscriptionId,
        deliveryId: event.deliveryId,
        eventId: event.eventId,
        expectedSubscriptionVersion: event.type === "snapshot" ? event.subscription.version : subscription.version
      });
      if (result.ok && result.command === "collaboration.acknowledge_delivery" && result.data.subscriptionId === subscriptionId && subscription?.id === subscriptionId) {
        subscription = { ...subscription, state: "active", version: result.data.subscriptionVersion };
        seenDeliveries.add(event.deliveryId);
        deliveryOrder.push(event.deliveryId);
        while (deliveryOrder.length > 512) seenDeliveries.delete(deliveryOrder.shift()!);
      }
    };
    const deliver = async (event: CollaborationRendererEvent) => {
      if (stopped || controller.signal.aborted) return;
      if (event.type === "connection") {
        await listener(event);
        if (event.connection.state === "access_revoked") {
          subscriptionRevoked = true;
          const current = subscription;
          subscription = null;
          resolveSubscriptionReady(null);
          if (current) releaseSubscription(current.id);
        }
        return;
      }
      if (event.type === "control") {
        const current = subscription;
        if (!current || event.subscriptionId !== current.id) return;
        try { await listener(event); } catch { /* Renewal must proceed even if the UI could not refresh. */ }
        if (event.reason === "access_revoked") {
          subscriptionRevoked = true;
          subscription = null;
          resolveSubscriptionReady(null);
          return;
        }
        if (event.reason === "requires_snapshot" || event.reason === "backpressure") {
          subscription = null;
          releaseSubscription(current.id);
          resetSubscriptionReady();
          void startSubscription();
        }
        return;
      }
      const activeSubscription = await subscriptionReady;
      if (!activeSubscription || stopped || subscriptionRevoked || controller.signal.aborted || subscription?.id !== activeSubscription.id) return;
      if (event.type === "snapshot") {
        if (event.subscription.id !== activeSubscription.id || event.subscription.scope.scope !== "team" || event.subscription.scope.teamId !== teamId) return;
        if (!canApplySubscriptionSnapshot({ currentVersion: subscription?.version ?? null, snapshotVersion: event.subscription.version, alreadyAcknowledged: seenDeliveries.has(event.deliveryId) })) return;
        subscription = event.subscription;
      } else if (event.type === "update") {
        if (event.subscriptionId !== activeSubscription.id || !subscription || subscription.state !== "active") return;
      } else {
        await listener(event);
        return;
      }
      if (seenDeliveries.has(event.deliveryId)) return;
      const applied = await listener(event);
      if (applied === false) return;
      if (stopped || controller.signal.aborted) return;
      await acknowledge(event);
    };
    const dispatch = (event: unknown) => {
      const parsed = collaborationRendererEventSchema.safeParse(event);
      if (!parsed.success) return;
      eventTail = eventTail.then(() => deliver(parsed.data)).catch(() => undefined);
    };
    const startSubscription = async () => {
      const ready = await streamReady;
      if (!ready || stopped || controller.signal.aborted) { resolveSubscriptionReady(null); return; }
      while (!stopped && !subscriptionRevoked && !controller.signal.aborted) {
        try {
          const result = await this.run("collaboration.subscribe", { scope: { scope: "team", teamId } });
          if (stopped || subscriptionRevoked || controller.signal.aborted) {
            if (result.ok && result.command === "collaboration.subscribe") releaseSubscription(result.data.subscription.id);
            resolveSubscriptionReady(null);
            return;
          }
          if (!result.ok) {
            if (result.error.retryable) {
              await wait(controller.signal, result.error.retryAfterMs ?? 1_000);
              continue;
            }
            resolveSubscriptionReady(null);
            return;
          }
          if (result.command !== "collaboration.subscribe" || result.data.subscription.scope.scope !== "team" || result.data.subscription.scope.teamId !== teamId) {
            resolveSubscriptionReady(null);
            return;
          }
          const created = result.data.subscription;
          if (stopped || controller.signal.aborted) {
            releaseSubscription(created.id);
            resolveSubscriptionReady(null);
            return;
          }
          subscription = created;
          resolveSubscriptionReady(created);
          return;
        } catch (failure) {
          const retryable = !(failure instanceof StudioCollaborationRequestError) || failure.retryable;
          if (!retryable) {
            resolveSubscriptionReady(null);
            const snapshot = await this.loadSession().catch(() => null);
            if (snapshot && !stopped) await onSnapshot?.(snapshot);
            return;
          }
          await wait(controller.signal);
        }
      }
      resolveSubscriptionReady(null);
    };
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          if (!this.csrfToken) await this.loadSession();
          const response = await this.fetcher(
            "/studio-api/collaboration/events",
            {
              method: "GET",
              headers: { accept: "text/event-stream", "x-studio-csrf": this.csrfToken ?? "" },
              credentials: "same-origin",
              cache: "no-store",
              signal: controller.signal
            }
          );
          if (!response.ok || !response.body) {
            if (response.status === 403) this.csrfToken = null;
            await wait(controller.signal);
            continue;
          }
          if (streamOpenedBefore && !controller.signal.aborted) {
            const snapshot = await this.loadSession().catch(() => null);
            if (snapshot && !stopped) {
              try { await onSnapshot?.(snapshot); } catch { /* The next reconnect or durable delivery can retry catch-up. */ }
            }
          }
          streamOpenedBefore = true;
          resolveStreamReady(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let data: string[] = [];
          let frameBytes = 0;
          while (!controller.signal.aborted) {
            const part = await reader.read();
            if (part.done) break;
            buffer += decoder.decode(part.value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line === "") {
                if (data.length) {
                  try {
                    dispatch(JSON.parse(data.join("\n")));
                  } catch {
                    // Ignore malformed broker frames and retain the stream.
                  }
                  data = [];
                }
                frameBytes = 0;
              } else if (line.startsWith("data:")) {
                frameBytes += new TextEncoder().encode(line).byteLength;
                if (frameBytes > MAX_EVENT_FRAME_BYTES) {
                  data = [];
                  buffer = "";
                  await reader.cancel().catch(() => undefined);
                  break;
                }
                data.push(line.slice(5).trimStart());
              }
            }
            if (buffer.length > MAX_EVENT_FRAME_BYTES) {
              buffer = "";
              data = [];
              await reader.cancel().catch(() => undefined);
              break;
            }
          }
          await reader.cancel().catch(() => undefined);
        } catch {
          if (!controller.signal.aborted) await wait(controller.signal);
        }
      }
    };
    void connect();
    void startSubscription();
    return () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      resolveStreamReady(false);
      resolveSubscriptionReady(null);
      const active = subscription;
      subscription = null;
      if (active) releaseSubscription(active.id);
    };
  }

  async loadDraft(authority: StudioTeamDraftAuthority): Promise<StudioTeamDraft | null> {
    const body = await this.draftRequest({ action: "load", authority });
    if (body.draft === null) return null;
    if (!isRecord(body.draft) || typeof body.draft.text !== "string") {
      throw new StudioCollaborationRequestError("Stored draft is invalid.", 502);
    }
    return body.draft as StudioTeamDraft;
  }

  async saveDraft(
    authority: StudioTeamDraftAuthority,
    draft: StudioTeamDraft
  ): Promise<void> {
    await this.draftRequest({ action: "save", authority, draft });
  }

  async deleteDraft(authority: StudioTeamDraftAuthority): Promise<void> {
    await this.draftRequest({ action: "delete", authority });
  }

  private async draftRequest(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = this.csrfToken ?? (await this.loadSession(), this.csrfToken);
    if (!token) throw new StudioCollaborationRequestError("Team session expired.", 403);
    const response = await this.fetcher(
      "/studio-api/collaboration/team-draft",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-studio-csrf": token
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(payload)
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body)) {
      if (response.status === 403) this.csrfToken = null;
      throw new StudioCollaborationRequestError(
        "Studio could not access the device draft store.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    return body;
  }
}
