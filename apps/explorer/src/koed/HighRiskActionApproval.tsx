import {
  CheckIcon,
  ClockIcon,
  LogInIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  | "unreconciled"
  | "invalid"
  | "unknown"
  | "error";

const terminalStates = new Set<ApprovalPageState>([
  "approved",
  "consumed",
  "denied",
  "revoked",
  "canceled",
  "expired",
  "unreconciled",
  "invalid",
  "unknown",
  "error"
]);

const autoCloseStates = new Set<ApprovalPageState>([
  "approved",
  "consumed",
  "denied",
  "revoked",
  "canceled",
  "expired",
  "invalid",
  "unknown"
]);

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
  const terminalResultRef = useRef<HTMLDivElement>(null);

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
      if (
        loaded.status.approvalTier !== "step_up" ||
        loaded.status.review === null
      ) {
        setActivation(null);
        setState("invalid");
        setError(
          "This confirmation is missing authoritative approval details. No decision was submitted."
        );
        return;
      }
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

  useEffect(() => {
    if (!terminalStates.has(state) && state !== "unreconciled") return;
    terminalResultRef.current?.focus();
    if (!autoCloseStates.has(state)) return;
    if (window.opener === null || window.closed) return;
    const closeFrame = window.requestAnimationFrame(() => window.close());
    return () => window.cancelAnimationFrame(closeFrame);
  }, [state]);

  const copy = useMemo(() => {
    if (activation?.status.review) {
      return {
        title: activation.status.review.title,
        description: activation.status.review.description,
        consequence: activation.status.review.consequence,
        button: activation.status.review.confirmLabel,
        details: activation.status.review.details
      };
    }
    return {
      title: "Sensitive Team action unavailable",
      description:
        "Koed could not load authoritative review details for this confirmation.",
      button: "Unavailable",
      consequence: null,
      details: []
    };
  }, [activation]);
  const canAct =
    state === "pending" &&
    activation?.status.approvalTier === "step_up" &&
    activation.status.review !== null &&
    busy === null;

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
        try {
          const authoritative = await loadHighRiskBrowserActivation(selector);
          if (
            authoritative.status.approvalTier !== "step_up" ||
            authoritative.status.review === null
          ) {
            setActivation(null);
            setState("error");
            setError(
              "The decision outcome was checked, but authoritative approval details are no longer available."
            );
          } else {
            setActivation(authoritative);
            setState(authoritative.status.state);
            setError(
              authoritative.status.state === "pending"
                ? "The decision was not recorded. Review the action and submit your choice again."
                : null
            );
          }
        } catch {
          setState("unreconciled");
          setError(
            `Koed could not confirm whether the decision was recorded (${message}). Keep this window open and retry the status check before taking any further action.`
          );
        }
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
            {copy.consequence ? (
              <p className="mt-2 font-medium text-sm">{copy.consequence}</p>
            ) : null}
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
            {copy.details.map((entry) => (
              <Detail
                className="sm:col-span-2"
                key={`${entry.label}:${entry.value}`}
                label={entry.label}
                value={entry.value}
              />
            ))}
          </dl>
        ) : null}

        <div
          aria-live="polite"
          className="mt-5 border border-border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          ref={terminalResultRef}
          role="status"
          tabIndex={terminalStates.has(state) ? -1 : undefined}
        >
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
          ) : state === "pending" ? (
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
            </div>
          ) : state === "unreconciled" || state === "error" ? (
            <div className="flex justify-end">
              <Button
                onClick={() => void loadActivation()}
                size="lg"
                variant="outline"
              >
                <RefreshCwIcon className="size-4" />
                {state === "unreconciled"
                  ? "Check decision status"
                  : "Retry action lookup"}
              </Button>
            </div>
          ) : null}
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
    "unreconciled",
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
      return "Approved — Koed Desktop is retrieving the result. You can safely close this window and return to Koed.";
    case "consumed":
      return "Completed — this one-use approval was consumed and cannot be replayed. You can safely close this window and return to Koed.";
    case "denied":
      return "Denied — no change was authorized. You can safely close this window and return to Koed.";
    case "revoked":
      return "Canceled — authority for this request was revoked. You can safely close this window and return to Koed.";
    case "canceled":
      return "Canceled — no change was authorized. You can safely close this window and return to Koed.";
    case "expired":
      return "Expired — no change was authorized. Close this window, return to Koed, and start the action again.";
    case "unauthenticated":
      return "Sign in again to confirm this sensitive action.";
    case "unreconciled":
      return "Outcome unknown — Koed has not confirmed whether your decision was recorded. This window will remain open.";
    case "unknown":
      return "Unavailable — this confirmation is unknown or no longer available. You can safely close this window and return to Koed.";
    case "invalid":
      return "Unavailable — this confirmation is incomplete and no decision can be submitted from this page. You can safely close this window and return to Koed.";
    case "error":
      return "Action lookup failed — no decision was submitted. Retry the lookup before closing this window.";
    case "loading":
      return "Loading confirmation.";
    case "pending":
    default:
      return "Approve only if you initiated this action from your enrolled Koed device.";
  }
}
