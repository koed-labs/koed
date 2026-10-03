"use client";

import { useCallback, useEffect, useState } from "react";
import { HomeFeedClient } from "@/lib/home-feed-client";
import { TeamOverviewClient } from "@/lib/team-overview-client";
import {
  getBrowserNotificationPreference,
  notificationPreferenceChangedEvent,
  setBrowserNotificationPreference,
  type NotificationAuthority
} from "@/lib/studio-notification-preferences";

export function StudioNotificationSettings() {
  const [desktop, setDesktop] = useState(false);
  const [authorities, setAuthorities] = useState<NotificationAuthority[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bridge = window.koedDesktop?.notifications;
      setDesktop(Boolean(bridge));
      if (bridge) {
        setAuthorities([]);
        setEnabled((await bridge.getPreference()).enabled);
        return;
      }
      const home = new HomeFeedClient("hosted");
      const teams = new TeamOverviewClient("hosted");
      const [homeResult, teamResult] = await Promise.allSettled([
        home.getAccess(),
        teams.getOverview({ limit: 1 })
      ]);
      const scopes: NotificationAuthority[] = [];
      if (homeResult.status === "fulfilled") {
        scopes.push({
          source: "home",
          accountScope: homeResult.value.accountScope,
          backendId: homeResult.value.backendId
        });
      }
      if (teamResult.status === "fulfilled") {
        scopes.push({
          source: "team_overview",
          accountScope: teamResult.value.access.accountScope,
          backendId: teamResult.value.access.backendId
        });
      }
      if (!scopes.length)
        throw new Error("Sign in to manage notification preferences.");
      setAuthorities(scopes);
      setEnabled(scopes.some(getBrowserNotificationPreference));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Notification settings are unavailable."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => void refresh(), 0);
    return () => globalThis.clearTimeout(timer);
  }, [refresh]);

  const setPreference = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (desktop) {
        const result =
          await window.koedDesktop?.notifications?.setEnabled(next);
        if (!result || result.enabled !== next)
          throw new Error("Notification preference could not be saved.");
        window.dispatchEvent(new Event(notificationPreferenceChangedEvent));
      } else {
        if (!authorities.length)
          throw new Error("Verified account access is unavailable.");
        for (const authority of authorities)
          setBrowserNotificationPreference(authority, next);
      }
      setEnabled(next);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Notification preference could not be saved."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="mt-8 border-b border-border pb-8"
      aria-labelledby="notifications-heading"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="notifications-heading"
          className="text-sm font-medium text-foreground-secondary"
        >
          Notifications
        </h2>
        <p className="text-xs text-subtle">
          Saved on this {desktop ? "computer" : "browser"}.
        </p>
      </div>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
        Get alerts for Agent input or approval, failed Agent Jobs, direct
        messages, and explicit mentions. Alerts show the event and sender only.
      </p>
      <label className="mt-4 flex min-h-14 items-center justify-between gap-4 rounded-lg border border-border bg-surface/40 px-4 py-3">
        <span>
          <span className="block text-sm font-medium">
            {desktop
              ? "Enable system notifications"
              : "Enable in-app notifications"}
          </span>
          <span className="mt-1 block text-xs text-subtle">
            {desktop
              ? "Allow macOS alerts while Studio is in the background. Foreground in-app alerts remain available while Studio is open."
              : "Allow foreground in-app alerts in this browser while Studio is open."}
          </span>
        </span>
        <input
          aria-label={
            desktop
              ? "Enable system notifications"
              : "Enable in-app notifications"
          }
          type="checkbox"
          checked={enabled}
          disabled={loading || saving || (!desktop && authorities.length === 0)}
          onChange={(event) => void setPreference(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-accent"
        />
      </label>
      {loading ? (
        <p className="mt-2 text-xs text-muted">Checking notification access…</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
