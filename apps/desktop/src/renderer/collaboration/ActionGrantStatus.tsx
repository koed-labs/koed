import type {
  CollaborationActionGrantProjection,
  CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import { useToast, type ToastTone } from "@koed/ui";
import { AlertTriangle, Check, Clock, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

const stateCopy: Record<CollaborationActionGrantProjection["state"], string> = {
  awaiting_approval: "Waiting for browser approval",
  awaiting_review: "Waiting for your review",
  approved: "Approved",
  executing: "Applying approved change",
  completed: "Complete",
  denied: "Denied",
  expired: "Approval expired",
  canceled: "Canceled",
  failed: "Could not complete"
};

const stateTone: Record<
  CollaborationActionGrantProjection["state"],
  ToastTone
> = {
  awaiting_approval: "warning",
  awaiting_review: "warning",
  approved: "neutral",
  executing: "neutral",
  completed: "success",
  denied: "destructive",
  expired: "warning",
  canceled: "neutral",
  failed: "destructive"
};

const stateIcon = (
  state: CollaborationActionGrantProjection["state"]
): ReactNode => {
  if (state === "completed") return <Check />;
  if (state === "awaiting_approval" || state === "awaiting_review") {
    return <Clock />;
  }
  if (state === "approved" || state === "executing") {
    return <LoaderCircle className="animate-spin" />;
  }
  if (state === "canceled") return <X />;
  return <AlertTriangle />;
};

export function CollaborationAnnouncementToast({
  announcement,
  clearAnnouncement
}: {
  announcement: string;
  clearAnnouncement: (expected?: string) => void;
}) {
  const { dismiss, toast } = useToast();
  const activeToastId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (activeToastId.current !== undefined) {
      dismiss(activeToastId.current, false);
      activeToastId.current = undefined;
    }
    if (!announcement) return;
    activeToastId.current = toast({
      icon: <AlertTriangle />,
      onDismiss: () => clearAnnouncement(announcement),
      title: announcement,
      tone: "warning"
    });
  }, [announcement, clearAnnouncement, dismiss, toast]);

  return null;
}

export function ActionGrantStatus({
  actionGrants,
  client
}: {
  actionGrants: readonly CollaborationActionGrantProjection[];
  client: CollaborationRendererClient;
}) {
  const { dismiss, toast } = useToast();
  const displayedStates = useRef(
    new Map<string, CollaborationActionGrantProjection["state"]>()
  );
  const toastIds = useRef(new Map<string, number>());

  useEffect(() => {
    for (const grant of actionGrants) {
      if (grant.operation === "Preview Shared Memory") {
        const previousToastId = toastIds.current.get(grant.id);
        if (previousToastId !== undefined) dismiss(previousToastId, false);
        displayedStates.current.set(grant.id, grant.state);
        toastIds.current.delete(grant.id);
        continue;
      }
      if (displayedStates.current.get(grant.id) === grant.state) continue;

      const previousToastId = toastIds.current.get(grant.id);
      if (previousToastId !== undefined) dismiss(previousToastId);

      const canCancel =
        (grant.state === "awaiting_approval" ||
          grant.state === "awaiting_review") &&
        client.cancelActionGrant;
      const toastId = toast({
        action: canCancel
          ? {
              label: "Cancel",
              onClick: () => void client.cancelActionGrant?.(grant.id)
            }
          : undefined,
        description: stateCopy[grant.state],
        icon: stateIcon(grant.state),
        title: grant.operation,
        tone: stateTone[grant.state]
      });
      displayedStates.current.set(grant.id, grant.state);
      toastIds.current.set(grant.id, toastId);
    }
  }, [actionGrants, client, dismiss, toast]);

  return null;
}
