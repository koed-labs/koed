import type {
  CollaborationThread,
  CollaborationSelection,
  CollaborationSnapshot
} from "@koed/shared/collaboration";
import type { MarkdownPlatformAdapters } from "@koed/memory-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";

import {
  CollaborationClientError,
  type CollaborationActionGrantProjection,
  type CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import { createRendererPlatform } from "../services/platform.js";
import { DraftStore } from "../state/drafts.js";
import type { DraftAuthority } from "../state/drafts.js";
import type {
  CollaborationModalState,
  CollaborationSelectionFailure
} from "./CollaborationRoutes.js";

const startupRecoveryDelaysMs = [0, 250, 1_000, 5_000, 15_000] as const;
const emptyActionGrants: readonly CollaborationActionGrantProjection[] = [];

const safeFailure = (cause: unknown, fallback: string): string =>
  cause instanceof CollaborationClientError ? cause.userMessage : fallback;

const authorizedThread = (
  snapshot: CollaborationSnapshot,
  authority: DraftAuthority
): CollaborationThread | null => {
  if (authority.scope === "personal") {
    if (authority.principalId !== snapshot.navigation.personalOwner.id) {
      return null;
    }
    return (
      [
        snapshot.navigation.personal.notesToSelf,
        ...snapshot.navigation.personal.channels
      ].find(({ id }) => id === authority.threadId) ?? null
    );
  }
  if (
    authority.backendId !== snapshot.connection.backendId ||
    authority.principalId !== snapshot.navigation.teamPrincipal?.id
  ) {
    return null;
  }
  const team = snapshot.navigation.teams.find(
    ({ id, lifecycle }) => id === authority.teamId && lifecycle === "active"
  );
  if (!team) return null;
  const directMessage = team.directMessages.find(
    ({ id }) => id === authority.threadId
  );
  if (directMessage) return directMessage;
  const workspace = authority.workspaceId
    ? team.workspaces.find(
        ({ id, lifecycle }) =>
          id === authority.workspaceId && lifecycle === "active"
      )
    : null;
  const channel =
    workspace?.channels.find(({ id }) => id === authority.threadId) ?? null;
  if (channel) return channel;
  if (
    snapshot.view.kind === "shared_session" &&
    snapshot.view.companion.thread.id === authority.threadId &&
    snapshot.view.companion.thread.teamId === authority.teamId &&
    snapshot.view.companion.thread.workspaceId === authority.workspaceId
  ) {
    return snapshot.view.companion.thread;
  }
  return null;
};

export type CollaborationController = {
  actionGrants: readonly CollaborationActionGrantProjection[];
  announcement: string;
  choose: (selection: CollaborationSelection) => void;
  clearAnnouncement: (expected?: string) => void;
  drafts: DraftStore;
  error: string | null;
  liveAnnouncement: { id: string; text: string } | null;
  loadState: "loading" | "ready" | "failed";
  markdownAdapters: MarkdownPlatformAdapters;
  modal: CollaborationModalState | null;
  retry: () => void;
  selectionFailure: CollaborationSelectionFailure | null;
  selectionLoading: boolean;
  setModal: (modal: CollaborationModalState | null) => void;
  snapshot: CollaborationSnapshot | null;
};

export const useCollaborationController = (
  client: CollaborationRendererClient,
  localServiceReady: boolean
): CollaborationController => {
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(
    client.current()
  );
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">(
    client.current() ? "ready" : "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [failureRevision, setFailureRevision] = useState(0);
  const [selectionFailure, setSelectionFailure] =
    useState<CollaborationSelectionFailure | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const selectionRun = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const clearAnnouncement = useCallback((expected?: string) => {
    setAnnouncement((current) =>
      expected === undefined || current === expected ? "" : current
    );
  }, []);
  const [liveAnnouncement, setLiveAnnouncement] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [modal, setModal] = useState<CollaborationModalState | null>(null);
  const [drafts] = useState(() => new DraftStore());
  const recoveryAttempt = useRef(0);
  const recoveryRun = useRef(0);
  const recoveryActive = useRef(false);
  const serviceReadyRef = useRef(localServiceReady);
  serviceReadyRef.current = localServiceReady;
  const subscribeActionGrants = useCallback(
    (notify: () => void) =>
      client.subscribeActionGrants?.(notify) ?? (() => undefined),
    [client]
  );
  const currentActionGrants = useCallback(
    () => client.currentActionGrants?.() ?? emptyActionGrants,
    [client]
  );
  const actionGrants = useSyncExternalStore(
    subscribeActionGrants,
    currentActionGrants,
    currentActionGrants
  );

  const markdownAdapters = useMemo<MarkdownPlatformAdapters>(() => {
    const platform = createRendererPlatform();
    return {
      openExternal: platform.openExternal,
      writeClipboard: platform.copyText
    };
  }, []);

  const load = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    try {
      const next = await client.load();
      setSnapshot(next);
      setLoadState("ready");
      setRetryable(false);
      recoveryAttempt.current = 0;
      return true;
    } catch (cause) {
      const canRetry =
        cause instanceof CollaborationClientError && cause.retryable;
      setError(safeFailure(cause, "Collaboration could not be loaded."));
      setRetryable(canRetry);
      setLoadState("failed");
      setFailureRevision((current) => current + 1);
      return false;
    }
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe((next, update) => {
      setSnapshot(next);
      setLoadState("ready");
      setError(null);
      if (update.kind === "connection" || "announcement" in update) {
        setAnnouncement(update.announcement ?? "");
      }
      if (
        next.connection.state === "live" &&
        (update.kind === "command" || update.kind === "realtime")
      ) {
        setAnnouncement("");
      }
      if (update.kind === "realtime" && update.announcement) {
        setLiveAnnouncement({
          id: update.announcementId ?? update.announcement,
          text: update.announcement
        });
      } else if (update.kind === "connection" || update.kind === "purge") {
        setLiveAnnouncement(null);
      }
    });
    if (!client.current()) void load();
    return unsubscribe;
  }, [client, load]);

  useEffect(() => {
    if (!snapshot) return;
    drafts.reconcileAuthorized((authority) => {
      const thread = authorizedThread(snapshot, authority);
      return Boolean(thread && thread.lifecycle === "active" && thread.canPost);
    });
  }, [drafts, snapshot]);

  useEffect(() => {
    if (
      !localServiceReady ||
      loadState !== "failed" ||
      !retryable ||
      recoveryActive.current ||
      recoveryAttempt.current >= startupRecoveryDelaysMs.length
    ) {
      return;
    }
    const run = ++recoveryRun.current;
    recoveryActive.current = true;
    void (async () => {
      while (
        run === recoveryRun.current &&
        serviceReadyRef.current &&
        recoveryAttempt.current < startupRecoveryDelaysMs.length
      ) {
        const delay =
          startupRecoveryDelaysMs[recoveryAttempt.current] ??
          startupRecoveryDelaysMs.at(-1)!;
        recoveryAttempt.current += 1;
        if (delay) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (
          run !== recoveryRun.current ||
          !serviceReadyRef.current ||
          (await load())
        ) {
          return;
        }
      }
    })().finally(() => {
      if (run === recoveryRun.current) recoveryActive.current = false;
    });
  }, [failureRevision, load, loadState, localServiceReady, retryable]);

  useEffect(
    () => () => {
      recoveryRun.current += 1;
      recoveryActive.current = false;
    },
    []
  );

  const retry = useCallback(() => {
    recoveryRun.current += 1;
    recoveryActive.current = false;
    recoveryAttempt.current = 0;
    void load();
  }, [load]);

  const choose = useCallback(
    (selection: CollaborationSelection) => {
      const run = ++selectionRun.current;
      setSelectionFailure(null);
      setSelectionLoading(true);
      void client
        .select(selection)
        .catch((cause) => {
          if (run !== selectionRun.current) return;
          setSelectionFailure({
            message: safeFailure(cause, "Selection is unavailable."),
            retryable:
              cause instanceof CollaborationClientError && cause.retryable,
            selection
          });
        })
        .finally(() => {
          if (run === selectionRun.current) setSelectionLoading(false);
        });
    },
    [client]
  );

  return {
    actionGrants,
    announcement,
    choose,
    clearAnnouncement,
    drafts,
    error,
    liveAnnouncement,
    loadState,
    markdownAdapters,
    modal,
    retry,
    selectionFailure,
    selectionLoading,
    setModal,
    snapshot
  };
};
