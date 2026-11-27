import { useEffect, useEffectEvent, type ReactNode } from "react";
import { Button } from "@koed-labs/ui";
import { Check, X } from "lucide-react";

export type DesktopNotice = { message: string; error?: string };

export function DesktopNotification({
  notice,
  onDismiss,
  paused = false,
  children
}: {
  notice: DesktopNotice;
  onDismiss: () => void;
  paused?: boolean;
  children?: ReactNode;
}) {
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (paused || notice.error) return;
    const timer = window.setTimeout(() => dismiss(), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice, paused]);
  return (
    <div
      className="v1-project-ui v1-pm-toast"
      role={notice.error ? "alert" : "status"}
    >
      <Check />
      <span>
        {notice.message}
        {notice.error && <small>{notice.error}</small>}
      </span>
      {children}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}
