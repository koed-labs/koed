"use client";

import { ToastProvider } from "../../.desktop-ui/index.js";
import { StudioNotificationCoordinator } from "./StudioNotificationCoordinator";

export function StudioNotificationsProvider({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <StudioNotificationCoordinator />
      {children}
    </ToastProvider>
  );
}
