"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  collaborationMessagePageSchema,
  type CollaborationMessage,
  type CollaborationMessagePage
} from "@koed/shared/collaboration";
import {
  classifyHomeNotification,
  isTeamMessageNotificationCandidate,
  studioNotificationCopy,
  studioNotificationIntentSchema,
  type StudioNotificationClassification,
  type StudioNotificationIntent,
  type StudioNotificationNavigation
} from "@koed/shared/studio-notifications";
import { useToast } from "../../.desktop-ui/index.js";
import { HomeFeedClient } from "@/lib/home-feed-client";
import { TeamOverviewClient } from "@/lib/team-overview-client";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import { HostedTeamCollaborationClient } from "@/lib/hosted-team-collaboration";
import { loadHostedSession } from "@/lib/hosted-session";
import {
  shouldEmitStudioNotification,
  studioNotificationDedupeKey,
  trimStudioNotificationSeen
} from "@/lib/studio-notification-state";
import {
  getBrowserNotificationPreference,
  notificationPreferenceChangedEvent,
  type NotificationAuthority
} from "@/lib/studio-notification-preferences";
import { getStudioNotificationViewedChat } from "@/lib/studio-notification-viewed-chat";

const POLL_MS = 30_000;
const RESEED_GAP_MS = POLL_MS * 2;
const MAX_FEED_PAGES = 2;
const MAX_TEAM_CANDIDATES = 20;
const MAX_MESSAGE_PAGE = 50;
const SEEN_LIMIT = 1_600;

type HomeDestination = { kind: "execution"; executionId: string };
type TeamDestination = {
  kind: "team_thread";
  teamId: string;
  threadId: string;
  rootMessageId: string | null;
  messageId: string;
};
type Route = HomeDestination | TeamDestination;

type Candidate = {
  intent: StudioNotificationIntent;
  classification: StudioNotificationClassification;
  route: Route;
  homeSource?: "managed_runtime_item" | "personal_agent_job";
  occurredAt?: string;
  senderLabel?: string;
};
type TeamPollResult = {
  accountScope: string;
  backendId: string | null;
  candidates: Candidate[];
  generatedAt: string;
  teamIds: string[];
};
type HomePollResult = {
  authority: NotificationAuthority;
  candidates: Candidate[];
  generatedAt: string;
};

const compactLabel = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const safe = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 64);
  return safe || undefined;
};

const isForeground = () =>
  document.visibilityState === "visible" && document.hasFocus();

const sameRoute = (left: Route, right: Route) =>
  left.kind === right.kind &&
  (left.kind === "execution"
    ? right.kind === "execution" && left.executionId === right.executionId
    : right.kind === "team_thread" &&
      left.teamId === right.teamId &&
      left.threadId === right.threadId);

const navigate = (router: ReturnType<typeof useRouter>, value: Route) => {
  if (value.kind === "execution") {
    router.push(`/?chat=1&execution=${encodeURIComponent(value.executionId)}`);
    return;
  }
  const query = new URLSearchParams({
    team: value.teamId,
    thread: value.threadId,
    message: value.messageId
  });
  if (value.rootMessageId) query.set("root", value.rootMessageId);
  router.push(`/collaboration?${query}`);
};

const readHostedMessagePage = async (
  client: HostedTeamCollaborationClient,
  input: {
    teamId: string;
    threadId: string;
    rootMessageId: string | null;
  }
): Promise<{ items: CollaborationMessage[] }> => {
  const page = await client.loadMessages(
    input.teamId,
    input.threadId,
    null,
    MAX_MESSAGE_PAGE,
    input.rootMessageId
  );
  return { items: page.items };
};

async function fetchHomeCandidates(
  client: HomeFeedClient,
  authority: NotificationAuthority,
  signal: AbortSignal
): Promise<HomePollResult> {
  const candidates: Candidate[] = [];
  let generatedAt = "";
  for (const source of [
    "managed_runtime_item",
    "personal_agent_job"
  ] as const) {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_FEED_PAGES; pageIndex += 1) {
      const snapshot = await client.get({ source, limit: 100, cursor }, signal);
      if (snapshot.accountScope !== authority.accountScope)
        throw new Error("Home authority changed during polling.");
      generatedAt = snapshot.generatedAt;
      for (const item of snapshot.needsYou) {
        const classification = classifyHomeNotification(item);
        if (!classification || item.destination.kind !== "execution") continue;
        const intent = studioNotificationIntentSchema.parse({
          version: 1,
          source: "home",
          accountScope: authority.accountScope,
          backendId: authority.backendId,
          sourceEventId: item.sourceEventId,
          sourceRevision: item.sourceRevision
        });
        candidates.push({
          intent,
          classification,
          route: item.destination,
          homeSource: source,
          occurredAt: item.updatedAt
          // Feed title and summary may contain private content and are not read.
        });
      }
      cursor =
        snapshot.coverage.find((entry) => entry.source === source)
          ?.nextCursor ?? undefined;
      if (!cursor) break;
    }
  }
  return { authority, candidates, generatedAt };
}

async function fetchTeamCandidates(
  client: TeamOverviewClient,
  collaboration: StudioCollaborationClient,
  hostedCollaboration: HostedTeamCollaborationClient,
  transport: "studio" | "hosted",
  signal: AbortSignal
): Promise<TeamPollResult> {
  const first = await client.getOverview({ limit: 100 }, signal);
  const pages = [first];
  let cursor = first.nextCursor;
  while (cursor && pages.length < MAX_FEED_PAGES) {
    const page = await client.getOverview({ cursor, limit: 100 }, signal);
    pages.push(page);
    cursor = page.nextCursor;
  }
  if (
    pages.some(
      (page) =>
        page.access.accountScope !== first.access.accountScope ||
        page.access.backendId !== first.access.backendId
    )
  )
    throw new Error("Team notification authority changed during pagination.");

  const rawCandidates = pages
    .flatMap((page) => page.attention)
    .filter(isTeamMessageNotificationCandidate)
    .slice(0, MAX_TEAM_CANDIDATES);
  if (rawCandidates.length === 0)
    return {
      accountScope: first.access.accountScope,
      backendId: first.access.backendId,
      candidates: [],
      generatedAt: first.generatedAt,
      teamIds: first.teams.map((team) => team.teamId).sort()
    };

  const session = transport === "hosted" ? await loadHostedSession() : null;
  const principalId =
    transport === "hosted"
      ? session?.status === "authenticated"
        ? session.user.id
        : null
      : ((await collaboration.loadSession()).navigation.teamPrincipal?.id ??
        null);
  if (!principalId)
    return {
      accountScope: first.access.accountScope,
      backendId: first.access.backendId,
      candidates: [],
      generatedAt: first.generatedAt,
      teamIds: first.teams.map((team) => team.teamId).sort()
    };

  const verifiedPages = [await client.getOverview({ limit: 100 }, signal)];
  let verifiedCursor = verifiedPages[0]!.nextCursor;
  while (verifiedCursor && verifiedPages.length < MAX_FEED_PAGES) {
    const verifiedPage = await client.getOverview(
      { cursor: verifiedCursor, limit: 100 },
      signal
    );
    verifiedPages.push(verifiedPage);
    verifiedCursor = verifiedPage.nextCursor;
  }
  if (
    verifiedPages.some(
      (page) =>
        page.access.accountScope !== first.access.accountScope ||
        page.access.backendId !== first.access.backendId ||
        JSON.stringify(page.teams.map((team) => team.teamId).sort()) !==
          JSON.stringify(first.teams.map((team) => team.teamId).sort())
    )
  )
    throw new Error("Team notification authority changed during verification.");
  const verifiedItems = verifiedPages.flatMap((page) => page.attention);

  const candidates: Candidate[] = [];
  for (const item of rawCandidates) {
    if (signal.aborted)
      return {
        accountScope: first.access.accountScope,
        backendId: first.access.backendId,
        candidates: [],
        generatedAt: first.generatedAt,
        teamIds: first.teams.map((team) => team.teamId).sort()
      };
    if (item.destination.kind !== "thread") continue;
    const destination = item.destination;
    const verifiedItem = verifiedItems.find(
      (fresh) =>
        fresh.teamId === item.teamId &&
        fresh.sourceEventId === item.sourceEventId &&
        fresh.sourceRevision === item.sourceRevision &&
        fresh.destination.kind === "thread" &&
        fresh.destination.threadId === destination.threadId &&
        fresh.destination.rootMessageId === destination.rootMessageId
    );
    if (!verifiedItem) continue;
    const page =
      transport === "hosted"
        ? await readHostedMessagePage(hostedCollaboration, {
            teamId: item.teamId,
            threadId: item.destination.threadId,
            rootMessageId: item.destination.rootMessageId
          })
        : await loadStudioMessagePage(
            collaboration,
            item.teamId,
            item.destination.threadId,
            item.destination.rootMessageId
          );
    const isDm = item.sourceEventId.startsWith("dm:");
    for (const message of page.items) {
      if (message.sender.id === principalId) continue;
      const isMention = message.mentionUserIds.includes(principalId);
      if (!isDm && !isMention) continue;
      const intent = studioNotificationIntentSchema.parse({
        version: 1,
        source: "team_overview",
        accountScope: first.access.accountScope,
        backendId: first.access.backendId,
        sourceEventId: item.sourceEventId,
        sourceRevision: item.sourceRevision,
        messageId: message.id
      });
      candidates.push({
        intent,
        classification: isDm ? "direct_message" : "mention",
        route: {
          kind: "team_thread",
          teamId: item.teamId,
          threadId: item.destination.threadId,
          rootMessageId: item.destination.rootMessageId,
          messageId: message.id
        },
        senderLabel: compactLabel(message.sender.displayName),
        occurredAt: message.createdAt
      });
    }
  }
  return {
    accountScope: first.access.accountScope,
    backendId: first.access.backendId,
    candidates,
    generatedAt: first.generatedAt,
    teamIds: first.teams.map((team) => team.teamId).sort()
  };
}

async function loadStudioMessagePage(
  client: StudioCollaborationClient,
  teamId: string,
  threadId: string,
  rootMessageId: string | null
): Promise<CollaborationMessagePage> {
  const result = await client.run("collaboration.load_message_page", {
    thread: { scope: "team", teamId, threadId },
    rootMessageId,
    direction: "newer",
    cursor: null,
    limit: MAX_MESSAGE_PAGE
  });
  if (!result.ok || !("page" in result.data))
    throw new Error("Team message access is unavailable.");
  const parsed = collaborationMessagePageSchema.safeParse(result.data.page);
  if (!parsed.success || parsed.data.threadId !== threadId)
    throw new Error("Team message page is invalid.");
  return parsed.data;
}

export function StudioNotificationCoordinator() {
  const router = useRouter();
  const { dismiss, toast } = useToast();
  const seen = useRef(new Set<string>());
  const toastIds = useRef(new Map<string, number>());
  const scopeKeys = useRef<Record<"home" | "team_overview", string | null>>({
    home: null,
    team_overview: null
  });
  const snapshotTimes = useRef<Record<"home" | "team_overview", string | null>>(
    {
      home: null,
      team_overview: null
    }
  );
  const successTimes = useRef<Record<"home" | "team_overview", number>>({
    home: 0,
    team_overview: 0
  });
  const reseedSources = useRef(
    new Set<"home" | "team_overview">(["home", "team_overview"])
  );
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let running: AbortController | null = null;
    const desktop = window.koedDesktop;
    const transport = desktop ? "studio" : "hosted";
    const homeClient = new HomeFeedClient(transport);
    const teamClient = new TeamOverviewClient(transport);
    const collaboration = new StudioCollaborationClient();
    const hostedCollaboration = new HostedTeamCollaborationClient();

    const removeToast = (key: string) => toastIds.current.delete(key);
    const resetSource = (source: "home" | "team_overview") => {
      for (const key of [...seen.current]) {
        if (key.startsWith(`${source}\u0000`)) seen.current.delete(key);
      }
      for (const [key, id] of [...toastIds.current]) {
        if (key.startsWith(`${source}\u0000`)) {
          dismiss(id, false);
          toastIds.current.delete(key);
        }
      }
      scopeKeys.current[source] = null;
      snapshotTimes.current[source] = null;
      successTimes.current[source] = 0;
      reseedSources.current.add(source);
      // Main clears pending OS notices and re-resolves source authorities.
      void desktop?.notifications?.reset(source).catch(() => undefined);
    };

    const clear = () => {
      generation.current += 1;
      seen.current.clear();
      reseedSources.current.add("home");
      reseedSources.current.add("team_overview");
      scopeKeys.current.home = null;
      scopeKeys.current.team_overview = null;
      snapshotTimes.current.home = null;
      snapshotTimes.current.team_overview = null;
      successTimes.current.home = 0;
      successTimes.current.team_overview = 0;
      for (const id of toastIds.current.values()) dismiss(id, false);
      toastIds.current.clear();
      void desktop?.notifications?.reset().catch(() => undefined);
    };

    const processCandidates = async (
      source: "home" | "team_overview",
      authority: NotificationAuthority,
      candidates: Candidate[],
      generatedAt: string,
      scope: string,
      nativeEnabled: boolean,
      foreground: boolean
    ) => {
      const previousScope = scopeKeys.current[source];
      if (previousScope !== null && previousScope !== scope)
        resetSource(source);
      if (
        successTimes.current[source] &&
        Date.now() - successTimes.current[source] > RESEED_GAP_MS
      )
        resetSource(source);
      const reseed = reseedSources.current.has(source);
      const after = snapshotTimes.current[source];
      scopeKeys.current[source] = scope;
      snapshotTimes.current[source] = generatedAt;
      successTimes.current[source] = Date.now();
      reseedSources.current.delete(source);

      for (const candidate of candidates) {
        if (candidate.intent.source !== source) continue;
        const key = studioNotificationDedupeKey(
          candidate.intent,
          candidate.classification
        );
        const shouldEmit = shouldEmitStudioNotification(
          seen.current,
          candidate.intent,
          candidate.classification,
          {
            reseed,
            occurredAt: candidate.occurredAt,
            after
          }
        );
        if (!shouldEmit) continue;
        const browserEnabled = desktop
          ? true
          : getBrowserNotificationPreference(authority);
        if (!browserEnabled && !nativeEnabled) continue;
        const viewed = getStudioNotificationViewedChat();
        const viewedRoute: Route | null =
          viewed?.kind === "agent"
            ? { kind: "execution", executionId: viewed.executionId }
            : viewed
              ? {
                  kind: "team_thread",
                  teamId: viewed.teamId,
                  threadId: viewed.threadId,
                  rootMessageId: null,
                  messageId: ""
                }
              : null;
        const suppressInApp = Boolean(
          foreground && viewedRoute && sameRoute(candidate.route, viewedRoute)
        );
        if (desktop?.notifications && nativeEnabled)
          void desktop.notifications
            .notify(candidate.intent)
            .catch(() => undefined);
        if (!foreground || suppressInApp) continue;
        const copy = studioNotificationCopy(candidate.classification);
        let id = 0;
        id = toast({
          title: candidate.senderLabel ?? copy.title,
          description: copy.body,
          duration: 7000,
          action: {
            label: "Open",
            onClick: () => {
              void revalidateAndNavigate(
                candidate,
                transport,
                homeClient,
                teamClient,
                collaboration,
                hostedCollaboration,
                router
              );
            }
          },
          onDismiss: () => removeToast(key)
        });
        toastIds.current.set(key, id);
      }
      trimStudioNotificationSeen(seen.current, SEEN_LIMIT);
    };

    const run = async () => {
      if (!active) return;
      if (!navigator.onLine) {
        clear();
        return;
      }
      running?.abort();
      const controller = new AbortController();
      running = controller;
      const runGeneration = generation.current;
      const nativeEnabled =
        (await desktop?.notifications
          ?.getPreference()
          .then((preference) => preference.enabled)
          .catch(() => false)) ?? false;
      const foreground = isForeground();
      const runHome = async () => {
        try {
          const access = await homeClient.getAccess(controller.signal);
          const authority: NotificationAuthority = {
            source: "home",
            accountScope: access.accountScope,
            backendId: access.backendId
          };
          const feed = await fetchHomeCandidates(
            homeClient,
            authority,
            controller.signal
          );
          if (
            !active ||
            controller.signal.aborted ||
            runGeneration !== generation.current
          )
            return;
          await processCandidates(
            "home",
            authority,
            feed.candidates,
            feed.generatedAt,
            JSON.stringify([authority.accountScope, authority.backendId]),
            nativeEnabled,
            foreground
          );
        } catch {
          if (active && !controller.signal.aborted) resetSource("home");
        }
      };
      const runTeam = async () => {
        try {
          const feed = await fetchTeamCandidates(
            teamClient,
            collaboration,
            hostedCollaboration,
            transport,
            controller.signal
          );
          if (
            !active ||
            controller.signal.aborted ||
            runGeneration !== generation.current
          )
            return;
          const authority: NotificationAuthority = {
            source: "team_overview",
            accountScope: feed.accountScope,
            backendId: feed.backendId
          };
          const scope = JSON.stringify([
            feed.accountScope,
            feed.backendId,
            feed.teamIds
          ]);
          await processCandidates(
            "team_overview",
            authority,
            feed.candidates,
            feed.generatedAt,
            scope,
            nativeEnabled,
            foreground
          );
        } catch {
          if (active && !controller.signal.aborted)
            resetSource("team_overview");
        }
      };
      await Promise.all([runHome(), runTeam()]);
    };

    const onNavigate = (navigation: StudioNotificationNavigation) => {
      if (navigation.kind === "execution") navigate(router, navigation);
      else navigate(router, navigation);
    };
    const unsubscribeNavigate = desktop?.notifications?.onNavigate(onNavigate);
    const onPreferenceChanged = () => {
      clear();
      void run();
    };
    const onFocus = () => void run();
    const onOnline = () => {
      clear();
      void run();
    };
    const onOffline = () => {
      clear();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener(
      notificationPreferenceChangedEvent,
      onPreferenceChanged
    );
    void run();
    timer = setInterval(() => void run(), POLL_MS);
    return () => {
      active = false;
      running?.abort();
      if (timer) clearInterval(timer);
      unsubscribeNavigate?.();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener(
        notificationPreferenceChangedEvent,
        onPreferenceChanged
      );
      clear();
    };
  }, [dismiss, router, toast]);

  return null;
}

async function revalidateAndNavigate(
  candidate: Candidate,
  transport: "studio" | "hosted",
  home: HomeFeedClient,
  team: TeamOverviewClient,
  collaboration: StudioCollaborationClient,
  hostedCollaboration: HostedTeamCollaborationClient,
  router: ReturnType<typeof useRouter>
) {
  try {
    if (candidate.intent.source === "home") {
      const access = await home.getAccess();
      if (
        access.accountScope !== candidate.intent.accountScope ||
        access.backendId !== candidate.intent.backendId
      )
        return;
      if (!candidate.homeSource || candidate.route.kind !== "execution") return;
      const route = candidate.route;
      let cursor: string | undefined;
      let matching = false;
      for (
        let pageIndex = 0;
        pageIndex < MAX_FEED_PAGES && !matching;
        pageIndex += 1
      ) {
        const snapshot = await home.get({
          source: candidate.homeSource,
          limit: 100,
          cursor
        });
        if (snapshot.accountScope !== access.accountScope) return;
        matching = snapshot.needsYou.some(
          (item) =>
            item.sourceEventId === candidate.intent.sourceEventId &&
            item.sourceRevision === candidate.intent.sourceRevision &&
            item.destination.kind === "execution" &&
            item.destination.executionId === route.executionId
        );
        cursor =
          snapshot.coverage.find(
            (entry) => entry.source === candidate.homeSource
          )?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      if (matching) navigate(router, route);
      return;
    }
    const snapshot = await team.getOverview({ limit: 100 });
    if (
      snapshot.access.accountScope !== candidate.intent.accountScope ||
      snapshot.access.backendId !== candidate.intent.backendId
    )
      return;
    if (candidate.route.kind !== "team_thread") return;
    const route = candidate.route;
    const matching = snapshot.attention.some(
      (item) =>
        item.sourceEventId === candidate.intent.sourceEventId &&
        item.sourceRevision === candidate.intent.sourceRevision &&
        item.teamId === route.teamId &&
        item.destination.kind === "thread" &&
        item.destination.threadId === route.threadId &&
        item.destination.rootMessageId === route.rootMessageId
    );
    if (!matching) return;
    const hostedSession =
      transport === "hosted" ? await loadHostedSession() : null;
    const principalId =
      transport === "hosted"
        ? hostedSession?.status === "authenticated"
          ? hostedSession.user.id
          : null
        : ((await collaboration.loadSession()).navigation.teamPrincipal?.id ??
          null);
    if (!principalId) return;
    const page =
      transport === "hosted"
        ? await readHostedMessagePage(hostedCollaboration, {
            teamId: route.teamId,
            threadId: route.threadId,
            rootMessageId: route.rootMessageId
          })
        : await loadStudioMessagePage(
            collaboration,
            route.teamId,
            route.threadId,
            route.rootMessageId
          );
    const message = page.items.find((item) => item.id === route.messageId);
    if (!message || message.sender.id === principalId) return;
    const isDm = candidate.intent.sourceEventId.startsWith("dm:");
    if (
      candidate.classification === "direct_message"
        ? !isDm
        : !message.mentionUserIds.includes(principalId)
    )
      return;
    const finalPages = [await team.getOverview({ limit: 100 })];
    let finalCursor = finalPages[0]!.nextCursor;
    while (finalCursor && finalPages.length < MAX_FEED_PAGES) {
      const finalPage = await team.getOverview({
        cursor: finalCursor,
        limit: 100
      });
      finalPages.push(finalPage);
      finalCursor = finalPage.nextCursor;
    }
    const finalSnapshot = finalPages[0]!;
    if (
      finalSnapshot.access.accountScope !== candidate.intent.accountScope ||
      finalSnapshot.access.backendId !== candidate.intent.backendId ||
      finalPages.some(
        (page) =>
          page.access.accountScope !== candidate.intent.accountScope ||
          page.access.backendId !== candidate.intent.backendId
      ) ||
      !finalSnapshot.teams.some((item) => item.teamId === route.teamId)
    )
      return;
    const finalItem = finalPages
      .flatMap((page) => page.attention)
      .find(
        (item) =>
          item.sourceEventId === candidate.intent.sourceEventId &&
          item.sourceRevision === candidate.intent.sourceRevision &&
          item.teamId === route.teamId &&
          item.destination.kind === "thread" &&
          item.destination.threadId === route.threadId &&
          item.destination.rootMessageId === route.rootMessageId
      );
    if (!finalItem) return;
    const finalHostedSession =
      transport === "hosted" ? await loadHostedSession() : null;
    const finalPrincipalId =
      transport === "hosted"
        ? finalHostedSession?.status === "authenticated"
          ? finalHostedSession.user.id
          : null
        : ((await collaboration.loadSession()).navigation.teamPrincipal?.id ??
          null);
    if (finalPrincipalId !== principalId) return;
    navigate(router, route);
  } catch {
    // Access changes fail closed; the toast action simply stops navigating.
  }
}
