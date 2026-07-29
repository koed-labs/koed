import {
  CheckIcon,
  ClockIcon,
  LogInIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, cn, Input } from "@koed/ui";
import {
  apiBaseUrl,
  decideHighRiskBrowserActivation,
  loadBrowserAuthProviders,
  loadHighRiskBrowserActivation,
  loginWithLocalSession
} from "./api";
import type { BrowserAuthProvider } from "./api";
import koedMarkUrl from "./assets/koed-mark.svg";
import type {
  HighRiskBrowserActivation,
  HighRiskBrowserActivationState
} from "./types";

type ApprovalPageState =
  | "loading"
  | HighRiskBrowserActivationState
  | "unauthenticated"
  | "unknown"
  | "error";

const actionCopy: Record<
  string,
  { title: string; description: string; button: string }
> = {
  "team.create": {
    title: "Create a Team",
    description: "Create a new Team with its default Workspace and channel.",
    button: "Create Team"
  },
  "team.invite.accept": {
    title: "Join a Team",
    description: "Accept this invitation and add your account to the Team.",
    button: "Join Team"
  },
  "team.member.role_update": {
    title: "Change a Team role",
    description: "Change a Team member's role and administrative authority.",
    button: "Change role"
  },
  "team.member.disable": {
    title: "Disable a Team member",
    description: "Remove a Team member's current access.",
    button: "Disable member"
  },
  "team.leave": {
    title: "Leave this Team",
    description: "Remove your account from this Team.",
    button: "Leave Team"
  },
  "team.invite.create": {
    title: "Create a Team invitation",
    description: "Issue a new invitation for this Team.",
    button: "Create invitation"
  },
  "team.invite.revoke": {
    title: "Revoke a Team invitation",
    description: "Prevent the selected invitation from being used.",
    button: "Revoke invitation"
  },
  "team.entitlement.update": {
    title: "Change Team access",
    description: "Change the Team's entitlement and access state.",
    button: "Change access"
  },
  "team.billing_seats.update": {
    title: "Change Team seat policy",
    description: "Change the Team's billing seat policy.",
    button: "Change seat policy"
  },
  "team.workspace.create": {
    title: "Create a Workspace",
    description: "Create a new Workspace inside this Team.",
    button: "Create Workspace"
  },
  "team.workspace.archive": {
    title: "Archive a Workspace",
    description: "Archive this Workspace and change its normal availability.",
    button: "Archive Workspace"
  },
  "team.workspace.restore": {
    title: "Restore a Workspace",
    description: "Restore this archived Workspace.",
    button: "Restore Workspace"
  },
  "team.workspace.access_update": {
    title: "Change Workspace access",
    description: "Change a Team member's access to this Workspace.",
    button: "Change access"
  },
  "team.retention.delete_request": {
    title: "Request Team deletion",
    description: "Start the governed deletion process for this Team.",
    button: "Request deletion"
  },
  "team.legal_hold.place": {
    title: "Place a legal hold",
    description: "Place selected Team data under legal hold.",
    button: "Place hold"
  },
  "team.legal_hold.release_request": {
    title: "Request legal-hold release",
    description: "Start the governed release process for this legal hold.",
    button: "Request release"
  },
  "team.legal_hold.release_confirm": {
    title: "Release a legal hold",
    description: "Complete the governed release of this legal hold.",
    button: "Release hold"
  },
  "shared_memory.preview": {
    title: "Preview Shared Memory",
    description:
      "Prepare the exact Memory representation for review before sharing.",
    button: "Prepare preview"
  },
  "shared_memory.consent": {
    title: "Approve Memory sharing consent",
    description:
      "Record the selected source and representation boundary for sharing.",
    button: "Approve consent"
  },
  "shared_memory.share": {
    title: "Share Memory with a Workspace",
    description:
      "Grant the selected Workspace access to the approved Memory representation.",
    button: "Share Memory"
  },
  "shared_memory.revoke": {
    title: "Revoke Shared Memory access",
    description: "Remove ordinary Team access granted by this Share Grant.",
    button: "Revoke access"
  },
  "shared_memory.change_representation": {
    title: "Change a Shared Memory representation",
    description:
      "Change the level of Memory detail available to the Workspace.",
    button: "Change representation"
  }
};

const authenticationRequired = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session cookie") ||
    normalized.includes("fresh browser authentication")
  );
};

const formatDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
};

export function HighRiskActionApproval({
  selector
}: {
  selector: string | null;
}) {
  const [activation, setActivation] =
    useState<HighRiskBrowserActivation | null>(null);
  const [state, setState] = useState<ApprovalPageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [authProviders, setAuthProviders] = useState<BrowserAuthProvider[]>([]);
  const [authProvidersLoading, setAuthProvidersLoading] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const loadActivation = useCallback(async () => {
    if (!selector) {
      setState("unknown");
      setError("Action confirmation is missing.");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const loaded = await loadHighRiskBrowserActivation(selector);
      setActivation(loaded);
      setState(loaded.status.state);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Action lookup failed.";
      setActivation(null);
      if (authenticationRequired(message)) {
        setState("unauthenticated");
        setError(null);
      } else if (message.toLowerCase().includes("not found")) {
        setState("unknown");
        setError(message);
      } else {
        setState("error");
        setError(message);
      }
    }
  }, [selector]);

  useEffect(() => {
    void loadActivation();
  }, [loadActivation]);

  useEffect(() => {
    if (state !== "unauthenticated") return;
    let current = true;
    setAuthProvidersLoading(true);
    void loadBrowserAuthProviders()
      .then((providers) => {
        if (current) setAuthProviders(providers);
      })
      .catch((caught) => {
        if (!current) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Authentication options could not be loaded."
        );
      })
      .finally(() => {
        if (current) setAuthProvidersLoading(false);
      });
    return () => {
      current = false;
    };
  }, [state]);

  const copy = useMemo(() => {
    if (activation) {
      const action = activation.confirmation.action;
      const actionKey = Object.keys(actionCopy).find(
        (candidate) =>
          action === candidate ||
          (candidate.startsWith("shared_memory.") &&
            (action.startsWith(`${candidate}.`) ||
              action.startsWith(`${candidate}:`)))
      );
      return actionKey
        ? actionCopy[actionKey]!
        : {
            title: "Approve a sensitive Team action",
            description:
              "Review this request from your enrolled local Koed device.",
            button: "Approve action"
          };
    }
    return {
      title: "Confirm a sensitive Team action",
      description: "Review the request before allowing it to continue.",
      button: "Approve action"
    };
  }, [activation]);
  const canAct = state === "pending" && busy === null;

  const submitDecision = async (decision: "approve" | "deny") => {
    if (!selector || !canAct) return;
    setBusy(decision);
    setError(null);
    try {
      const updated = await decideHighRiskBrowserActivation(selector, decision);
      setActivation(updated);
      setState(updated.status.state);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Confirmation failed.";
      if (authenticationRequired(message)) {
        setState("unauthenticated");
        setError(null);
      } else {
        setState("error");
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  };

  const submitLocalLogin = async () => {
    if (authBusy || !email.trim() || !password) return;
    setAuthBusy(true);
    setError(null);
    try {
      await loginWithLocalSession(email.trim(), password);
      setPassword("");
      await loadActivation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-xl rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <img alt="" className="mt-0.5 size-8" src={koedMarkUrl} />
          <div className="min-w-0 flex-1">
            <p className="text-muted-foreground text-sm">Koed confirmation</p>
            <h1 className="mt-1 font-semibold text-2xl tracking-normal">
              {copy.title}
            </h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {copy.description}
            </p>
          </div>
          <StatusIcon state={state} />
        </div>

        {activation ? (
          <dl className="mt-5 grid gap-3 border-y border-border py-4 sm:grid-cols-2">
            <Detail label="Requested by" value="Enrolled local Koed device" />
            <Detail
              label="Expires"
              value={formatDate(activation.status.expiresAt)}
            />
            {activation.confirmation.teamId ? (
              <Detail
                className="sm:col-span-2"
                label="Team scope"
                value={activation.confirmation.teamId}
              />
            ) : null}
          </dl>
        ) : null}

        <div className="mt-5 border border-border p-4">
          <p className="font-medium text-sm">{stateMessage(state)}</p>
          {error ? (
            <p className="mt-1 text-destructive-foreground text-sm">{error}</p>
          ) : null}
        </div>

        <div className="mt-5">
          {state === "unauthenticated" ? (
            <div className="ml-auto max-w-sm space-y-3">
              {authProviders.includes("local") ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitLocalLogin();
                  }}
                >
                  <label className="block space-y-1.5" htmlFor="action-email">
                    <span className="font-medium text-sm">Email</span>
                    <Input
                      autoComplete="email"
                      id="action-email"
                      name="email"
                      nativeInput
                      onChange={(event) => setEmail(event.currentTarget.value)}
                      required
                      size="lg"
                      type="email"
                      value={email}
                    />
                  </label>
                  <label
                    className="block space-y-1.5"
                    htmlFor="action-password"
                  >
                    <span className="font-medium text-sm">Password</span>
                    <Input
                      autoComplete="current-password"
                      id="action-password"
                      name="password"
                      nativeInput
                      onChange={(event) =>
                        setPassword(event.currentTarget.value)
                      }
                      required
                      size="lg"
                      type="password"
                      value={password}
                    />
                  </label>
                  <Button
                    className="w-full"
                    disabled={authBusy}
                    size="lg"
                    type="submit"
                  >
                    {authBusy ? (
                      <RefreshCwIcon className="size-4 animate-spin" />
                    ) : (
                      <LogInIcon className="size-4" />
                    )}
                    Sign in
                  </Button>
                </form>
              ) : null}
              {authProviders.includes("workos") ? (
                <Button
                  className="w-full"
                  onClick={() => {
                    window.location.href = `${apiBaseUrl}/auth/workos/login?return_to=${encodeURIComponent(window.location.href)}`;
                  }}
                  size="lg"
                  variant={
                    authProviders.includes("local") ? "outline" : "default"
                  }
                >
                  <LogInIcon className="size-4" />
                  Sign in with WorkOS
                </Button>
              ) : null}
              {authProvidersLoading ? (
                <p className="text-muted-foreground text-sm">
                  Loading sign-in options.
                </p>
              ) : null}
              {!authProvidersLoading && authProviders.length === 0 ? (
                <Button
                  className="w-full"
                  onClick={() => void loadActivation()}
                  size="lg"
                  variant="outline"
                >
                  <RefreshCwIcon className="size-4" />
                  Retry
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                disabled={!canAct}
                onClick={() => void submitDecision("deny")}
                size="lg"
                variant="destructive-outline"
              >
                {busy === "deny" ? (
                  <RefreshCwIcon className="size-4 animate-spin" />
                ) : (
                  <XIcon className="size-4" />
                )}
                Deny
              </Button>
              <Button
                disabled={!canAct}
                onClick={() => void submitDecision("approve")}
                size="lg"
              >
                {busy === "approve" ? (
                  <RefreshCwIcon className="size-4 animate-spin" />
                ) : (
                  <ShieldCheckIcon className="size-4" />
                )}
                {copy.button}
              </Button>
              {state === "error" || state === "unknown" ? (
                <Button
                  onClick={() => void loadActivation()}
                  size="lg"
                  variant="outline"
                >
                  <RefreshCwIcon className="size-4" />
                  Retry
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Detail({
  className,
  label,
  value
}: {
  className?: string;
  label: string;
  value: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 break-words font-medium text-sm">{value}</dd>
    </div>
  );
}

function StatusIcon({ state }: { state: ApprovalPageState }) {
  const terminalError = [
    "denied",
    "revoked",
    "canceled",
    "unknown",
    "error"
  ].includes(state);
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border",
        (state === "approved" || state === "consumed") &&
          "border-success/30 bg-success/10",
        terminalError && "border-destructive/30 bg-destructive/10",
        state === "expired" && "border-warning/30 bg-warning/10",
        ["pending", "loading", "unauthenticated"].includes(state) &&
          "border-info/30 bg-info/10"
      )}
    >
      {state === "approved" || state === "consumed" ? (
        <CheckIcon className="size-4 text-success-foreground" />
      ) : state === "expired" ? (
        <ClockIcon className="size-4 text-warning-foreground" />
      ) : state === "unauthenticated" ? (
        <LogInIcon className="size-4 text-info-foreground" />
      ) : terminalError ? (
        <XIcon className="size-4 text-destructive-foreground" />
      ) : (
        <ShieldCheckIcon className="size-4 text-info-foreground" />
      )}
    </div>
  );
}

function stateMessage(state: ApprovalPageState): string {
  switch (state) {
    case "approved":
      return "Approved. The enrolled device may perform this exact action once.";
    case "consumed":
      return "This approval was used and cannot be replayed.";
    case "denied":
      return "This request was denied and cannot continue.";
    case "revoked":
    case "canceled":
      return "This request was canceled and can no longer be approved.";
    case "expired":
      return "This request expired. Start the action again from Koed.";
    case "unauthenticated":
      return "Sign in again to confirm this sensitive action.";
    case "unknown":
      return "This confirmation was not found or is no longer available.";
    case "error":
      return "This confirmation could not be completed.";
    case "loading":
      return "Loading confirmation.";
    case "pending":
    default:
      return "Approve only if you initiated this action from your enrolled Koed device.";
  }
}
