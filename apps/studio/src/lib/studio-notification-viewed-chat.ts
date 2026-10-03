export type StudioNotificationViewedChat =
  | { kind: "agent"; executionId: string }
  | { kind: "team"; teamId: string; threadId: string };

const registrations = new Map<symbol, StudioNotificationViewedChat>();
const listeners = new Set<() => void>();

const publish = () => {
  for (const listener of listeners) listener();
};

export const registerStudioNotificationViewedChat = (
  value: StudioNotificationViewedChat
): (() => void) => {
  const key = Symbol("studio-notification-view");
  registrations.set(key, value);
  publish();
  return () => {
    if (registrations.delete(key)) publish();
  };
};

export const getStudioNotificationViewedChat =
  (): StudioNotificationViewedChat | null =>
    [...registrations.values()].at(-1) ?? null;

export const subscribeStudioNotificationViewedChat = (
  listener: () => void
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
