import {
  classifyHomeNotification,
  homeAccessSchema,
  homeSnapshotSchema,
  homeSourceSchema,
  isTeamMessageNotificationCandidate,
  teamOverviewSnapshotSchema,
  type StudioNotificationIntent
} from "@koed/shared";
import type { StudioNotificationNavigation } from "@koed/shared/studio-notifications";
import type { StudioLocalAccess } from "./studio-window.js";
import type { ResolvedStudioNotification } from "./studio-notifications.js";

export interface StudioNotificationMessageAuthority {
  principalId: string;
  isDirectMessage: boolean;
  message: {
    id: string;
    scope: "personal" | "team";
    teamId: string | null;
    senderKind: "user";
    senderId: string;
    mentionUserIds: string[];
  } | null;
}

export interface StudioNotificationAuthorityOptions {
  getAccess: () => Promise<StudioLocalAccess>;
  loadTeamMessage: (input: {
    teamId: string;
    threadId: string;
    rootMessageId: string | null;
    messageId: string;
  }) => Promise<StudioNotificationMessageAuthority>;
  fetchImpl?: typeof fetch;
}

const scopeIdentity = (
  accountScope: string,
  backendId: string | null
): string => `${accountScope}\0${backendId ?? ""}`;

export const createStudioNotificationAuthority = (
  options: StudioNotificationAuthorityOptions
) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readJson = async (path: string): Promise<unknown> => {
    const access = await options.getAccess();
    const origin = new URL(access.apiOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    )
      throw new Error("Notification authority endpoint is invalid.");
    const response = await fetchImpl(new URL(path, origin), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${access.apiToken}` },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error("Notification authority is unavailable.");
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024)
      throw new Error("Notification authority response is too large.");
    return JSON.parse(text) as unknown;
  };
  const findHomeItem = async (
    intent: StudioNotificationIntent
  ): Promise<{
    accountScope: string;
    item: ReturnType<typeof homeSnapshotSchema.parse>["needsYou"][number];
  } | null> => {
    const sources = homeSourceSchema.options;
    for (const source of sources) {
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
        const query = new URLSearchParams({ source, limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const snapshot = homeSnapshotSchema.parse(
          await readJson(`/v1/home?${query.toString()}`)
        );
        if (snapshot.accountScope !== intent.accountScope) return null;
        const item = snapshot.needsYou.find(
          (candidate) =>
            candidate.sourceEventId === intent.sourceEventId &&
            candidate.sourceRevision === intent.sourceRevision
        );
        if (item) return { accountScope: snapshot.accountScope, item };
        cursor =
          snapshot.coverage.find((entry) => entry.source === source)
            ?.nextCursor ?? null;
        if (!cursor) break;
      }
    }
    return null;
  };
  const findTeamItem = async (
    intent: StudioNotificationIntent
  ): Promise<{
    snapshot: ReturnType<typeof teamOverviewSnapshotSchema.parse>;
    item: ReturnType<
      typeof teamOverviewSnapshotSchema.parse
    >["attention"][number];
  } | null> => {
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const snapshot = teamOverviewSnapshotSchema.parse(
        await readJson(`/v1/collaboration/teams/overview?${query.toString()}`)
      );
      if (
        snapshot.access.accountScope !== intent.accountScope ||
        snapshot.access.backendId !== intent.backendId
      )
        return null;
      const item = [...snapshot.attention, ...snapshot.catchUp].find(
        (candidate) =>
          candidate.sourceEventId === intent.sourceEventId &&
          candidate.sourceRevision === intent.sourceRevision
      );
      if (item) return { snapshot, item };
      cursor = snapshot.nextCursor;
      if (!cursor) break;
    }
    return null;
  };
  const preferenceScopes = async (): Promise<string[]> => {
    const scopes = new Set<string>();
    const [home, team] = await Promise.allSettled([
      readJson("/v1/home/access"),
      readJson("/v1/collaboration/teams/overview?limit=1")
    ]);
    if (home.status === "fulfilled") {
      const parsed = homeAccessSchema.safeParse(home.value);
      if (parsed.success)
        scopes.add(
          `home\0${scopeIdentity(parsed.data.accountScope, parsed.data.backendId)}`
        );
    }
    if (team.status === "fulfilled") {
      const parsed = teamOverviewSnapshotSchema.safeParse(team.value);
      if (parsed.success)
        scopes.add(
          `team_overview\0${scopeIdentity(parsed.data.access.accountScope, parsed.data.access.backendId)}`
        );
    }
    return [...scopes];
  };
  const resolve = async (
    intent: StudioNotificationIntent
  ): Promise<ResolvedStudioNotification | null> => {
    if (intent.source === "home") {
      const access = homeAccessSchema.parse(await readJson("/v1/home/access"));
      if (
        access.accountScope !== intent.accountScope ||
        access.backendId !== intent.backendId
      )
        return null;
      const found = await findHomeItem(intent);
      if (!found) return null;
      const classification = classifyHomeNotification(found.item);
      if (!classification) return null;
      const destination = found.item.destination;
      if (destination.kind !== "execution") return null;
      return {
        preferenceScope: scopeIdentity(access.accountScope, access.backendId),
        classification,
        destination: { kind: "execution", executionId: destination.executionId }
      };
    }
    if (!intent.messageId) return null;
    const found = await findTeamItem(intent);
    if (!found) return null;
    const { snapshot, item } = found;
    if (!isTeamMessageNotificationCandidate(item)) return null;
    if (item.destination.kind !== "thread") return null;
    const verifiedMessage = await options.loadTeamMessage({
      teamId: item.teamId,
      threadId: item.destination.threadId,
      rootMessageId: item.destination.rootMessageId,
      messageId: intent.messageId
    });
    // The broker message read is a separate authority request from Team
    // overview. Fence account/team/source state again after it completes.
    const current = await findTeamItem(intent);
    if (
      !current ||
      current.item.teamId !== item.teamId ||
      !isTeamMessageNotificationCandidate(current.item)
    )
      return null;
    const message = verifiedMessage.message;
    if (
      !message ||
      message.id !== intent.messageId ||
      message.scope !== "team" ||
      message.teamId !== item.teamId ||
      message.senderKind !== "user" ||
      message.senderId === verifiedMessage.principalId
    )
      return null;
    const classification = message.mentionUserIds.includes(
      verifiedMessage.principalId
    )
      ? "mention"
      : verifiedMessage.isDirectMessage
        ? "direct_message"
        : null;
    if (!classification) return null;
    const destination: StudioNotificationNavigation = {
      kind: "team_thread",
      teamId: item.teamId,
      threadId: item.destination.threadId,
      rootMessageId: item.destination.rootMessageId,
      messageId: intent.messageId
    };
    return {
      preferenceScope: scopeIdentity(
        snapshot.access.accountScope,
        snapshot.access.backendId
      ),
      classification,
      destination
    };
  };
  return { preferenceScopes, resolve };
};
