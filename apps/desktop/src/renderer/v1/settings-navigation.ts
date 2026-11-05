import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { V1SettingsTab } from "./settings.js";

export type V1SettingsPage = "privacy" | "cli" | "health" | "embedding";
export const settingsPageParent = (page: V1SettingsPage): V1SettingsTab =>
  page === "privacy" || page === "cli" ? "general" : "services";

const currentSettingsTab = (tab: V1SettingsTab | "agent"): V1SettingsTab =>
  tab === "agent" ? "general" : tab;

// History belongs to this settings instance; unrelated application entries are preserved.
export function useSettingsNavigation(
  initialTab: V1SettingsTab | "agent",
  initialPage?: V1SettingsPage
) {
  const owner = useId();
  const [tab, updateTab] = useState(
    initialPage
      ? settingsPageParent(initialPage)
      : currentSettingsTab(initialTab)
  );
  const [page, updatePage] = useState<V1SettingsPage | null>(
    initialPage ?? null
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const origin = useRef<{ page: V1SettingsPage | null; scroll: number }>({
    page: null,
    scroll: 0
  });
  const historyBase = useRef(history.state);
  const current = useRef({ tab, page });
  current.current = { tab, page };
  useEffect(() => {
    const restore = () => {
      const entry = history.state?.koedSettings;
      if (entry?.owner === owner) {
        updateTab(currentSettingsTab(entry.tab));
        updatePage(entry.tab === "agent" ? null : entry.page);
      } else {
        updatePage(null);
        updateTab(current.current.tab);
      }
    };
    addEventListener("popstate", restore);
    return () => {
      removeEventListener("popstate", restore);
      if (history.state?.koedSettings?.owner === owner)
        history.replaceState(historyBase.current, "");
    };
  }, [owner]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = page ? 0 : origin.current.scroll;
    const target = page
      ? body.querySelector<HTMLButtonElement>(".v1-settings-back")
      : body.querySelector<HTMLButtonElement>(
          `[data-settings-page="${origin.current.page}"]`
        );
    target?.focus({ preventScroll: true });
  }, [page, tab]);
  const openPage = (next: V1SettingsPage) => {
    origin.current = { page: next, scroll: bodyRef.current?.scrollTop ?? 0 };
    history.pushState(
      {
        ...history.state,
        koedSettings: { owner, tab: settingsPageParent(next), page: next }
      },
      ""
    );
    updateTab(settingsPageParent(next));
    updatePage(next);
  };
  const back = () => {
    if (history.state?.koedSettings?.owner === owner) history.back();
    else updatePage(null);
  };
  const setTab = (next: V1SettingsTab) => {
    if (history.state?.koedSettings?.owner === owner)
      history.replaceState(historyBase.current, "");
    origin.current = { page: null, scroll: 0 };
    updatePage(null);
    updateTab(next);
  };
  return { tab, page, bodyRef, openPage, back, setTab };
}
