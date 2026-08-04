import type {
  CollaborationActionGrantProjection,
  CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import { Button } from "@koed/ui";
import { AlertTriangle, Check, Clock, LoaderCircle, X } from "lucide-react";

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

export function ActionGrantStatus({
  actionGrants,
  client
}: {
  actionGrants: readonly CollaborationActionGrantProjection[];
  client: CollaborationRendererClient;
}) {
  const visible = actionGrants.slice(-3).reverse();
  if (!visible.length) return null;
  return (
    <section aria-label="Approval activity" className="desktop-action-grants">
      {visible.map((grant) => (
        <article data-state={grant.state} key={grant.id}>
          <span className="desktop-action-grant-icon">
            {grant.state === "completed" ? (
              <Check aria-hidden="true" />
            ) : grant.state === "awaiting_approval" ||
              grant.state === "awaiting_review" ? (
              <Clock aria-hidden="true" />
            ) : grant.state === "approved" || grant.state === "executing" ? (
              <LoaderCircle aria-hidden="true" />
            ) : grant.state === "canceled" ? (
              <X aria-hidden="true" />
            ) : (
              <AlertTriangle aria-hidden="true" />
            )}
          </span>
          <span>
            <strong>{grant.operation}</strong>
            <small>{stateCopy[grant.state]}</small>
          </span>
          {(grant.state === "awaiting_approval" ||
            grant.state === "awaiting_review") &&
          client.cancelActionGrant ? (
            <Button
              onClick={() => void client.cancelActionGrant?.(grant.id)}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
          ) : null}
        </article>
      ))}
    </section>
  );
}
