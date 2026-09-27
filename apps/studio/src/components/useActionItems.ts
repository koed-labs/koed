"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  allTeamActionItems,
  badgeCount,
  isVisible,
  personalActionItems,
  sortItems,
  type ActionItem,
} from "@/lib/attention";
import { useWorkspace } from "./WorkspaceProvider";

const STORAGE_KEY = "koed.studio.collaboration-preview.cleared-actions.v1";
const EMPTY: Record<string, number> = {};
let cachedClearedActions: Record<string, number> | undefined;
const listeners = new Set<() => void>();

type Split = { visible: ActionItem[]; cleared: ActionItem[] };

function split(items: ActionItem[], cleared: Record<string, number>): Split {
  const sorted = sortItems(items);
  return {
    visible: sorted.filter((item) => isVisible(item, cleared)),
    cleared: sorted.filter((item) => !isVisible(item, cleared)),
  };
}

function readClearedActions() {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([id, at]) => id.length < 400 && typeof at === "number" && Number.isFinite(at),
      ),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

function getClearedActions() {
  if (typeof window === "undefined") return EMPTY;
  cachedClearedActions ??= readClearedActions();
  return cachedClearedActions;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cachedClearedActions = readClearedActions();
    listeners.forEach((notify) => notify());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function saveClearedActions(next: Record<string, number>) {
  cachedClearedActions = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Clearing is a convenience in this preview, not a required write.
  }
  listeners.forEach((listener) => listener());
}

// Studio's collaboration preview stores dismissals in this browser only.
// It deliberately does not pretend that the connected Koed workspace has
// recorded or synchronized them.
export function useActionItems() {
  const { workspace } = useWorkspace();
  const clearedActions = useSyncExternalStore(subscribe, getClearedActions, () => EMPTY);

  const items = useMemo(() => {
    const personal = split(personalActionItems(workspace), clearedActions);
    const team = split(allTeamActionItems(workspace), clearedActions);
    return {
      personal,
      team,
      personalBadge: badgeCount(personal.visible),
      teamsBadge: badgeCount(team.visible),
    };
  }, [clearedActions, workspace]);

  const clearAction = useCallback(
    (itemId: string) => {
      const item = allTeamActionItems(workspace).find((entry) => entry.id === itemId);
      if (!item) return;
      saveClearedActions({ ...getClearedActions(), [item.id]: item.at });
    },
    [workspace],
  );

  const restoreAction = useCallback((itemId: string) => {
    const next = { ...getClearedActions() };
    delete next[itemId];
    saveClearedActions(next);
  }, []);

  const teamBadge = useCallback(
    (teamId: string) =>
      badgeCount(
        items.team.visible.filter(
          (item) => item.source.side === "team" && item.source.teamId === teamId,
        ),
      ),
    [items.team.visible],
  );

  return { ...items, clearAction, restoreAction, teamBadge };
}
