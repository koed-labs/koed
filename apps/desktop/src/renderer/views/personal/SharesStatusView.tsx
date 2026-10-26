import { CircleAlert, LoaderCircle } from "lucide-react";

import "../../../collaboration.css";
import "./personal-memory.css";

function StatusIcon({ loading }: { loading: boolean }) {
  return loading ? (
    <LoaderCircle aria-hidden="true" className="personal-loading-icon" />
  ) : (
    <CircleAlert aria-hidden="true" className="personal-error-icon" />
  );
}

export function SharesStatusView({
  actionLabel,
  message,
  onAction,
  state
}: {
  actionLabel?: string;
  message?: string;
  onAction?: () => void;
  state: "loading" | "unavailable";
}) {
  const loading = state === "loading";
  return (
    <section
      className="collab-route-root collab-shares-workspace collab-shares-overview personal-shares-status"
      data-narrow-view="list"
      data-responsive="master-detail-to-drilldown"
    >
      <aside className="collab-shares-pane" aria-label="Shares">
        <header>
          <h1>Shares</h1>
        </header>
        <label className="collab-share-search">
          <span className="collab-visually-hidden">Search Shares</span>
          <input disabled placeholder="Search Shares" type="search" />
        </label>
        <div className="collab-shares-scroll">
          <div
            aria-label={loading ? "Loading Shares" : undefined}
            className={`personal-projects-narrow-state${loading ? "" : " error"}`}
            role={loading ? "status" : "alert"}
          >
            {loading ? (
              <StatusIcon loading />
            ) : (
              <>
                <StatusIcon loading={false} />
                <strong>Shares unavailable</strong>
                {message ? <p>{message}</p> : null}
                {onAction && actionLabel ? (
                  <button
                    className="personal-retry-button"
                    onClick={onAction}
                    type="button"
                  >
                    {actionLabel}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </aside>
    </section>
  );
}
