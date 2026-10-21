import { useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";

export type HqVisibility =
  | "personal-private"
  | "unverified"
  | { kind: "private-project"; teamName: string }
  | {
      kind: "shared-summary";
      label: string;
      people: string[];
      destination: string;
    };

type VisibilityReader = Pick<
  CollaborationRendererClient,
  "listOwnedSharedMemoryGrants" | "listOwnedShares" | "subscribe" | "current"
>;

export type HqVisibilityProject = {
  personalProjectId: string;
  teamBackendId: string;
  workspaceProjectId: string;
  teamWorkspaceId: string | null;
  version: number;
};

type ConversationSourceIdentity = {
  sessionId: string | null | undefined;
  logicalMemoryId?: string | null;
};

/** An old route row and a replacing execution must not form a mixed source. */
export function hqVisibilityIdentity(
  routeThread: ConversationSourceIdentity,
  detailThread: ConversationSourceIdentity,
  capturedSessionId: string | null | undefined
): { sessionId: string; logicalMemoryId: string } | null {
  const sessionId = detailThread.sessionId;
  if (
    !sessionId ||
    (routeThread.sessionId && routeThread.sessionId !== sessionId) ||
    (capturedSessionId && capturedSessionId !== sessionId) ||
    (routeThread.logicalMemoryId &&
      detailThread.logicalMemoryId &&
      routeThread.logicalMemoryId !== detailThread.logicalMemoryId)
  )
    return null;
  const logicalMemoryId =
    detailThread.logicalMemoryId ??
    (routeThread.sessionId === sessionId ? routeThread.logicalMemoryId : null);
  return logicalMemoryId ? { sessionId, logicalMemoryId } : null;
}

const matchesConversationSource = (
  source: { kind: string; logicalMemoryId: string; sessionId?: string },
  logicalMemoryId: string,
  sessionId: string,
  localSessionId?: string | null
) =>
  source.logicalMemoryId === logicalMemoryId ||
  source.sessionId === sessionId ||
  localSessionId === sessionId;

/** A complete owner read is required before making a privacy claim. */
export async function readHqConversationVisibility(
  client: VisibilityReader,
  logicalMemoryId: string,
  sessionId: string
): Promise<HqVisibility> {
  try {
    const grants = await client.listOwnedSharedMemoryGrants({
      logicalMemoryId
    });
    if (
      grants.some(
        (grant) =>
          (grant.lifecycle === "active" || grant.lifecycle === "unavailable") &&
          matchesConversationSource(grant.source, logicalMemoryId, sessionId)
      )
    )
      return "unverified";

    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await client.listOwnedShares({
        cursor,
        limit: 100,
        history: false
      });
      if (
        page.shares.some((item) => {
          const source =
            item.kind === "pending"
              ? item.pendingShare.source
              : item.grant.source;
          if (item.kind === "pending" && item.pendingShare.state === "revoked")
            return false;
          // Either source identity matching while the other conflicts is
          // ambiguous. A missing local mapping cannot clear a logical match.
          return matchesConversationSource(
            source,
            logicalMemoryId,
            sessionId,
            item.summary.sourceSessionId
          );
        })
      )
        return "unverified";
      if (!page.nextCursor) return "personal-private";
      if (page.shares.length === 0) return "unverified";
      if (seen.has(page.nextCursor)) return "unverified";
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } catch {
    // Missing Team authority, offline state and interrupted reads cannot prove privacy.
  }
  return "unverified";
}

/** Read the published owner grant and current audience before naming a recipient.
 * An active Project policy or a staged share alone is never a publication. */
export async function readHqPublishedVisibility(
  client: VisibilityReader,
  logicalMemoryId: string,
  sessionId: string,
  project?: HqVisibilityProject | null,
  projectsApi?: Pick<ProjectsDesktopApi, "sharedChatStatus"> | null
): Promise<HqVisibility> {
  try {
    const before = client.current();
    if (!before || before.connection.state !== "live") return "unverified";
    if (project && before.connection.backendId !== project.teamBackendId)
      return "unverified";
    const exact = (source: {
      kind: string;
      logicalMemoryId: string;
      sessionId?: string;
    }) =>
      source.kind === "captured_session" &&
      source.logicalMemoryId === logicalMemoryId &&
      source.sessionId === sessionId;
    const grants = await client.listOwnedSharedMemoryGrants({
      logicalMemoryId
    });
    const matching = grants.filter((grant) =>
      matchesConversationSource(grant.source, logicalMemoryId, sessionId)
    );
    if (
      matching.some(
        (grant) =>
          !exact(grant.source) &&
          (grant.lifecycle === "active" || grant.lifecycle === "unavailable")
      )
    )
      return "unverified";
    let cursor: string | null = null;
    const seen = new Set<string>();
    const shares: Awaited<
      ReturnType<VisibilityReader["listOwnedShares"]>
    >["shares"] = [];
    let complete = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await client.listOwnedShares({
        cursor,
        limit: 100,
        history: false
      });
      shares.push(...page.shares);
      if (!page.nextCursor) {
        complete = true;
        break;
      }
      if (!page.shares.length || seen.has(page.nextCursor)) return "unverified";
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (!complete) return "unverified";
    const sourceShares = shares.filter((item) => {
      const source =
        item.kind === "grant" ? item.grant.source : item.pendingShare.source;
      return matchesConversationSource(
        source,
        logicalMemoryId,
        sessionId,
        item.summary.sourceSessionId
      );
    });
    if (
      sourceShares.some(
        (item) =>
          (item.kind === "pending" && item.pendingShare.state !== "revoked") ||
          (item.kind === "grant" && !exact(item.grant.source))
      )
    )
      return "unverified";
    const published = sourceShares.filter(
      (item) =>
        item.kind === "grant" &&
        item.grant.lifecycle === "active" &&
        matching.some(
          (grant) =>
            grant.id === item.grant.id &&
            grant.lifecycle === "active" &&
            grant.mode === "continuous" &&
            grant.frozenAt === null
        ) &&
        item.grant.mode === "continuous" &&
        item.grant.frozenAt === null &&
        item.summary.workspaceContentAccess === "available" &&
        item.summary.lastReadyRevision !== null &&
        item.grant.activationRepresentation === "lcm_leaves" &&
        item.grant.maximumFidelity === "lcm_leaves" &&
        item.sourceAccess === null
    );
    const anyLive = matching.some(
      (grant) =>
        grant.lifecycle === "active" || grant.lifecycle === "unavailable"
    );
    const projectStatus =
      project && projectsApi?.sharedChatStatus
        ? await projectsApi.sharedChatStatus(
            project.personalProjectId,
            sessionId
          )
        : null;
    const after = client.current();
    if (
      !after ||
      after.snapshotRevision !== before.snapshotRevision ||
      after.connection.backendId !== before.connection.backendId ||
      after.navigation.personalOwner.id !==
        before.navigation.personalOwner.id ||
      after.navigation.teamPrincipal?.id !==
        before.navigation.teamPrincipal?.id ||
      after.connection.state !== "live"
    )
      return "unverified";
    if (published.length === 0) {
      if (
        anyLive ||
        sourceShares.some(
          (item) =>
            item.kind === "grant" && item.grant.lifecycle === "unavailable"
        )
      )
        return "unverified";
      if (projectStatus === "pending" || projectStatus === "shared")
        return "unverified";
      if (projectStatus === "private") {
        const team = after.navigation.teams.find((candidate) =>
          candidate.workspaces.some(
            (workspace) => workspace.id === project?.teamWorkspaceId
          )
        );
        return team
          ? { kind: "private-project", teamName: team.name }
          : "personal-private";
      }
      return "personal-private";
    }
    if (published.length !== 1) return "unverified";
    const item = published[0]!;
    if (item.kind !== "grant") return "unverified";
    const grant = item.grant;
    const team = after.navigation.teams.find(
      (candidate) => candidate.id === grant.teamId
    );
    const workspace = team?.workspaces.find(
      (candidate) => candidate.id === grant.workspaceId
    );
    if (
      !team ||
      !workspace ||
      team.lifecycle !== "active" ||
      workspace.lifecycle !== "active"
    )
      return "unverified";
    const principal = after.navigation.teamPrincipal?.id;
    if (!principal) return "unverified";
    // A complete, current access projection is needed for names. Absent
    // management data cannot be interpreted as a smaller audience.
    const exactAudience = matching.find(
      (candidate) => candidate.id === grant.id
    )?.audience;
    const completeAudience =
      Array.isArray(exactAudience) ||
      (exactAudience === undefined &&
        team.people.every((person) => !!person.management));
    const people = Array.isArray(exactAudience)
      ? exactAudience
          .filter((person) => person.userId !== principal)
          .map((person) => person.displayName)
      : completeAudience
        ? team.people
            .filter(
              (person) =>
                person.id !== principal &&
                person.membershipState === "enabled" &&
                person.management!.workspaceAccess.some(
                  (access) =>
                    access.workspaceId === grant.workspaceId &&
                    access.access !== "disabled"
                )
            )
            .map((person) => person.displayName)
        : [];
    const namedPeople = people.includes("Team member") ? [] : people;
    if (projectStatus === "pending" || projectStatus === "ineligible")
      return "unverified";
    const projectGrant =
      projectStatus === "shared" &&
      project?.teamWorkspaceId === grant.workspaceId;
    const label = projectGrant
      ? `Visible to ${team.name} (summaries)`
      : completeAudience && namedPeople.length > 0
        ? `Visible to ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(namedPeople)} (summaries)`
        : `Summary shared with ${workspace.name}`;
    return {
      kind: "shared-summary",
      label,
      people: namedPeople,
      destination: workspace.name
    };
  } catch {
    return "unverified";
  }
}

export function useHqConversationVisibility({
  client,
  logicalMemoryId,
  sessionId,
  ownerId,
  revision,
  connected,
  project,
  projectsApi
}: {
  client: VisibilityReader | null | undefined;
  logicalMemoryId: string | null | undefined;
  sessionId: string | null | undefined;
  ownerId: string | null | undefined;
  revision: string | null | undefined;
  connected: boolean;
  project?: HqVisibilityProject | null;
  projectsApi?: Pick<ProjectsDesktopApi, "sharedChatStatus"> | null;
}): HqVisibility {
  const [eventRevision, setEventRevision] = useState(0);
  const eventGeneration = useRef(0);
  const key = [
    ownerId,
    logicalMemoryId,
    sessionId,
    revision,
    connected,
    project?.personalProjectId,
    project?.teamBackendId,
    project?.workspaceProjectId,
    project?.teamWorkspaceId,
    project?.version
  ].join("\u0000");
  // A new token is created even when navigation or reconnection returns to an
  // earlier key, or when a share update leaves snapshotRevision unchanged.
  const request = useMemo(
    () => ({ key, client, projectsApi, eventRevision }),
    [key, client, projectsApi, eventRevision]
  );
  const [result, setResult] = useState<{
    request: typeof request;
    value: HqVisibility;
  } | null>(null);
  useEffect(() => {
    if (!client) return;
    return client.subscribe((_snapshot, update) => {
      if (update.kind === "realtime" || update.authoritativeRecovery === true) {
        eventGeneration.current += 1;
        setEventRevision((value) => value + 1);
      }
    });
  }, [client]);
  useEffect(() => {
    if (!client || !logicalMemoryId || !sessionId || !ownerId || !connected)
      return;
    let current = true;
    const readGeneration = eventGeneration.current;
    void (
      (client as Partial<VisibilityReader>).current
        ? readHqPublishedVisibility(
            client,
            logicalMemoryId,
            sessionId,
            project,
            projectsApi
          )
        : readHqConversationVisibility(client, logicalMemoryId, sessionId)
    ).then((value) => {
      if (current && readGeneration === eventGeneration.current)
        setResult({ request, value });
    });
    return () => {
      current = false;
    };
  }, [client, logicalMemoryId, sessionId, ownerId, connected, request]);
  return result?.request === request ? result.value : "unverified";
}
