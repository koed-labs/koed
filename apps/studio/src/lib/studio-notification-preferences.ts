export type NotificationSource = "home" | "team_overview";

export type NotificationAuthority = {
  source: NotificationSource;
  accountScope: string;
  backendId: string | null;
};

const prefix = "koed.studio.notifications.v1";
export const notificationPreferenceChangedEvent =
  "koed-studio-notification-preference-changed";

export const notificationPreferenceKey = (
  authority: NotificationAuthority
): string =>
  `${prefix}:${authority.source}:${encodeURIComponent(authority.accountScope)}:${encodeURIComponent(authority.backendId ?? "local")}`;

export const getBrowserNotificationPreference = (
  authority: NotificationAuthority
): boolean => {
  try {
    return (
      window.localStorage.getItem(notificationPreferenceKey(authority)) !==
      "disabled"
    );
  } catch {
    return false;
  }
};

export const setBrowserNotificationPreference = (
  authority: NotificationAuthority,
  enabled: boolean
): void => {
  try {
    const key = notificationPreferenceKey(authority);
    window.localStorage.setItem(key, enabled ? "enabled" : "disabled");
    window.dispatchEvent(new Event(notificationPreferenceChangedEvent));
  } catch {
    // A blocked browser storage context remains opted out.
  }
};
