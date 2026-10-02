"use client";

import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  LoaderCircle,
  GitPullRequest,
  FolderPlus,
  Globe,
  Image,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
  Puzzle,
  Gamepad2,
  BookOpen,
  Users,
  Brain
} from "lucide-react";
import { SiGithub, SiGmail, SiGoogledrive, SiNotion } from "react-icons/si";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createStudioSkillPreview,
  filterStudioSkillCatalog,
  hasStudioSkillName,
  parseStudioSkillPreviews,
  slugifyStudioSkillName,
  STUDIO_SKILL_CATALOG,
  STUDIO_SKILL_PREVIEW_STORAGE_KEY,
  type StudioSkillCatalogEntry,
  type StudioSkillIcon,
  type StudioSkillPreview,
  type StudioSkillScope
} from "@/lib/studio-skills";
import { Tooltip } from "@/components/Tooltip";
import { StudioSidebar } from "./StudioSidebar";
import {
  pullRequestOperationData,
  pullRequestsClient
} from "@/lib/pull-requests-client";
import type { PullRequestRunner } from "@/lib/pull-requests-client";

type PluginsMode = "live" | "demo";
type GitHubState = "disconnected" | "connected" | "error";

type GitHubStatus = {
  state: GitHubState;
  login: string | null;
  accountId?: string | null;
  connectionGeneration?: number;
  message: string | null;
  capabilities: {
    readPullRequests: boolean;
    publishReviews: boolean;
  };
};

type GitHubAccount = { login: string; active: boolean; state?: string };

type CatalogPlugin = {
  title: string;
  description: string;
  icon: React.ReactNode;
  accent?: string;
};

const OTHER_PLUGINS: CatalogPlugin[] = [
  {
    title: "Gmail",
    description: "Email access is not connected in this slice.",
    icon: <SiGmail className="h-5 w-5 text-[#ea4335]" />
  },
  {
    title: "Google Drive",
    description: "Drive access is not connected in this slice.",
    icon: <SiGoogledrive className="h-5 w-5 text-[#4285f4]" />
  },
  {
    title: "Notion",
    description: "Notion access is not connected in this slice.",
    icon: <SiNotion className="h-5 w-5 text-foreground" />
  }
];

const DISCONNECTED_STATUS: GitHubStatus = {
  state: "disconnected",
  login: null,
  message: null,
  capabilities: { readPullRequests: false, publishReviews: false }
};

const DEMO_CONNECTED_STATUS: GitHubStatus = {
  state: "connected",
  login: "demo-operator",
  message: null,
  capabilities: { readPullRequests: true, publishReviews: false }
};

function sanitizeMessage(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .replace(
      /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_\-]+/gi,
      "[credential removed]"
    )
    .replace(/(?:Bearer|token)\s+[^\s]+/gi, "[credential removed]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 280);
}

function statusFromOperation(
  value: Record<string, unknown>
): GitHubStatus | null {
  const account =
    value.account && typeof value.account === "object"
      ? (value.account as Record<string, unknown>)
      : null;
  const connected = value.state === "connected";
  const state: GitHubState = connected
    ? "connected"
    : value.state === "reauthorization_required"
      ? "error"
      : "disconnected";
  if (
    account &&
    (typeof account.id !== "string" || typeof account.login !== "string")
  )
    return null;
  return {
    state,
    login: account && typeof account.login === "string" ? account.login : null,
    accountId: account && typeof account.id === "string" ? account.id : null,
    connectionGeneration: Number.isSafeInteger(value.connectionGeneration)
      ? Number(value.connectionGeneration)
      : undefined,
    message: state === "error" ? "Reconnect GitHub in Plugins." : null,
    capabilities: {
      readPullRequests: connected,
      publishReviews: connected
    }
  };
}

function PluginCard({ plugin }: { plugin: CatalogPlugin }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-transparent p-3 opacity-65">
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          {plugin.icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground-secondary">
            {plugin.title}
          </p>
          <p className="truncate text-xs text-subtle">{plugin.description}</p>
        </div>
      </div>
      <span className="ml-4 shrink-0 text-[11px] text-faint">Unavailable</span>
    </div>
  );
}

function CapabilityRow({
  label,
  enabled
}: {
  label: string;
  enabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-foreground-secondary">
      {enabled ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <X className="h-3.5 w-3.5 text-subtle" />
      )}
      {label}
    </div>
  );
}

export function PluginsView({
  mode,
  onHome,
  onNewChat,
  onPullRequests,
  onUseRealGitHub,
  onPlugins
}: {
  mode: PluginsMode;
  onHome: () => void;
  onNewChat: () => void;
  onPullRequests: () => void;
  onUseRealGitHub?: () => void;
  onPlugins?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"plugins" | "skills">("plugins");
  const [skillsScope, setSkillsScope] = useState<StudioSkillScope>("personal");
  const [activeScope, setActiveScope] = useState<"public" | "personal">(
    "public"
  );
  const [status, setStatus] = useState<GitHubStatus>(
    mode === "demo" ? DISCONNECTED_STATUS : DISCONNECTED_STATUS
  );
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [runners, setRunners] = useState<PullRequestRunner[]>([]);
  const [runnerId, setRunnerId] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);
  const [loading, setLoading] = useState(mode === "live");
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const targetOption = useMemo(() => {
    const target =
      runners.find((runner) => runner.deviceId === runnerId) ?? runners[0];
    return target
      ? { deviceId: target.deviceId, deploymentId: target.deploymentId }
      : undefined;
  }, [runnerId, runners]);

  const refreshAccounts = useCallback(
    async (targetOverride?: { deviceId: string; deploymentId: string }) => {
      if (mode === "demo") return;
      setAccountLoading(true);
      try {
        const operation = await pullRequestsClient.runOperation(
          { kind: "accounts" },
          { target: targetOverride ?? targetOption }
        );
        const data = pullRequestOperationData(operation);
        const values = Array.isArray(data.accounts)
          ? data.accounts
          : Array.isArray(data)
            ? data
            : [];
        setAccounts(
          values.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const account = value as Record<string, unknown>;
            return typeof account.login === "string"
              ? [
                  {
                    login: account.login,
                    active: account.active === true,
                    ...(typeof account.state === "string"
                      ? { state: account.state }
                      : {})
                  }
                ]
              : [];
          })
        );
      } catch {
        setAccounts([]);
      } finally {
        setAccountLoading(false);
      }
    },
    [mode, targetOption]
  );

  const loadStatus = useCallback(
    async (targetOverride?: { deviceId: string; deploymentId: string }) => {
      if (mode === "demo") return;
      const sequence = ++requestSequenceRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const statusOperation = await pullRequestsClient.runOperation(
          { kind: "connection_status" },
          { signal: controller.signal, target: targetOverride ?? targetOption }
        );
        const statusPayload = statusFromOperation(
          pullRequestOperationData(statusOperation)
        );
        if (!statusPayload)
          throw new Error("GitHub connection status is unavailable.");
        if (sequence !== requestSequenceRef.current) return;
        setStatus(statusPayload);
        if (statusPayload.state === "error") {
          setError(
            sanitizeMessage(
              statusPayload.message,
              "GitHub status could not be loaded."
            )
          );
        }
      } catch (reason) {
        if (
          sequence !== requestSequenceRef.current ||
          (reason as { name?: string })?.name === "AbortError"
        )
          return;
        setStatus({
          ...DISCONNECTED_STATUS,
          state: "error",
          message: sanitizeMessage(
            reason instanceof Error ? reason.message : null,
            "GitHub status could not be loaded."
          )
        });
        setError("GitHub status could not be loaded.");
      } finally {
        if (sequence === requestSequenceRef.current) {
          setLoading(false);
          controllerRef.current = null;
        }
      }
    },
    [controllerRef, mode, requestSequenceRef, targetOption]
  );
  const loadStatusRef = useRef(loadStatus);
  const refreshAccountsRef = useRef(refreshAccounts);
  useEffect(() => {
    loadStatusRef.current = loadStatus;
    refreshAccountsRef.current = refreshAccounts;
  }, [loadStatus, refreshAccounts]);

  useEffect(() => {
    // The request synchronizes the page with the local Studio gateway.
    if (mode === "live") {
      void pullRequestsClient
        .listRunners()
        .then((available) => {
          setRunners(available);
          setRunnerId((current) =>
            available.some((runner) => runner.deviceId === current)
              ? current
              : (available[0]?.deviceId ?? "")
          );
          const first = available[0];
          const firstTarget = first
            ? { deviceId: first.deviceId, deploymentId: first.deploymentId }
            : undefined;
          void loadStatusRef.current(firstTarget);
          void refreshAccountsRef.current(firstTarget);
        })
        .finally(() => {
          // Runner lookup failure is surfaced by the following status refresh.
        });
    }
    return () => {
      requestSequenceRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [mode]);

  const connect = useCallback(async () => {
    if (mode === "demo") {
      setStatus(DEMO_CONNECTED_STATUS);
      setError(null);
      return;
    }
    setMutating(true);
    setError(null);
    try {
      await pullRequestsClient.runOperation(
        { kind: "browser_sign_in" },
        { target: targetOption }
      );
      await refreshAccounts();
      await loadStatus();
    } catch (reason) {
      const message = sanitizeMessage(
        reason instanceof Error ? reason.message : null,
        "GitHub could not be connected."
      );
      setStatus({ ...DISCONNECTED_STATUS, state: "error", message });
      setError(message);
    } finally {
      setMutating(false);
    }
  }, [loadStatus, mode, refreshAccounts, targetOption]);

  const disconnect = useCallback(async () => {
    if (mode === "demo") {
      setStatus(DISCONNECTED_STATUS);
      setError(null);
      return;
    }
    if (!status.accountId || !status.login || !status.connectionGeneration) {
      setError(
        "GitHub account status is unavailable. Refresh before disconnecting."
      );
      return;
    }
    setMutating(true);
    setError(null);
    try {
      await pullRequestsClient.runOperation(
        {
          kind: "disconnect",
          account: { id: status.accountId, login: status.login },
          connectionGeneration: status.connectionGeneration
        },
        { target: targetOption }
      );
      await refreshAccounts();
      await loadStatus();
    } catch (reason) {
      const message = sanitizeMessage(
        reason instanceof Error ? reason.message : null,
        "GitHub could not be disconnected."
      );
      setError(message);
    } finally {
      setMutating(false);
    }
  }, [loadStatus, mode, refreshAccounts, status, targetOption]);

  const selectAccount = useCallback(
    async (login: string) => {
      if (!login || mode === "demo") return;
      setMutating(true);
      setError(null);
      try {
        await pullRequestsClient.runOperation(
          { kind: "connect", login },
          { target: targetOption }
        );
        await refreshAccounts();
        await loadStatus();
      } catch (reason) {
        setError(
          sanitizeMessage(
            reason instanceof Error ? reason.message : null,
            "GitHub account could not be selected."
          )
        );
      } finally {
        setMutating(false);
      }
    },
    [loadStatus, mode, refreshAccounts, targetOption]
  );

  const connected = status.state === "connected";
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOtherPlugins = OTHER_PLUGINS.filter(
    (plugin) =>
      !normalizedQuery ||
      plugin.title.toLowerCase().includes(normalizedQuery) ||
      plugin.description.toLowerCase().includes(normalizedQuery)
  );
  const githubMatches =
    !normalizedQuery ||
    "github".includes(normalizedQuery) ||
    "validate your local github identity".includes(normalizedQuery);
  const visibleError =
    error ??
    (status.state === "error"
      ? sanitizeMessage(status.message, "GitHub status could not be loaded.")
      : null);
  const statusLabel = useMemo(() => {
    if (loading) return "Checking connection";
    if (connected)
      return mode === "demo" ? "Simulated connection" : "Connected";
    if (status.state === "error") return "Connection error";
    return "Not connected";
  }, [connected, loading, mode, status.state]);

  return (
    <div className="flex h-full min-h-0 w-full">
      <StudioSidebar
        projects={[]}
        collapsed={collapsed}
        selectedProject={null}
        onProjectSelect={() => {}}
        onToggle={() => setCollapsed((value) => !value)}
        onHome={onHome}
        onNewChat={onNewChat}
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
        activeSection="plugins"
      />
      <main className="min-w-0 flex-1 overflow-y-auto bg-background">
        <div className="mx-auto max-w-4xl px-8 py-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("plugins")}
                aria-pressed={activeTab === "plugins"}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeTab === "plugins" ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface hover:text-foreground-secondary"}`}
              >
                Plugins
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("skills")}
                aria-pressed={activeTab === "skills"}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeTab === "skills" ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface hover:text-foreground-secondary"}`}
              >
                Skills
              </button>
            </div>
            {mode === "demo" && (
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning">
                  Demo data
                </span>
                {onUseRealGitHub && (
                  <button
                    type="button"
                    onClick={onUseRealGitHub}
                    className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                  >
                    Use real GitHub
                  </button>
                )}
              </div>
            )}
          </div>

          <h1 className="text-3xl font-semibold text-foreground">
            {activeTab === "skills" ? "Skills" : "Plugins"}
          </h1>
          <p className="mb-6 mt-2 text-sm text-muted">
            {activeTab === "skills"
              ? "Browse skills from Personal, System, and koed-self-hosted catalogs."
              : "Connect tools that Koed can use for your personal workspace."}
          </p>
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                activeTab === "skills" ? "Search skills" : "Search plugins"
              }
              className="w-full rounded-lg border border-border bg-surface py-2 pl-10 pr-4 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong focus:ring-1 focus:ring-accent"
              aria-label={
                activeTab === "skills" ? "Search skills" : "Search plugins"
              }
            />
          </div>
          {activeTab === "plugins" && (
            <div
              className="mb-8 flex items-center gap-2"
              role="group"
              aria-label="Plugin catalogue scope"
            >
              <button
                type="button"
                onClick={() => setActiveScope("public")}
                aria-pressed={activeScope === "public"}
                className={`rounded-full px-3 py-1 text-xs font-medium ${activeScope === "public" ? "bg-surface-hover text-foreground-secondary" : "text-subtle hover:bg-surface hover:text-foreground-secondary"}`}
              >
                Public
              </button>
              <button
                type="button"
                onClick={() => setActiveScope("personal")}
                aria-pressed={activeScope === "personal"}
                className={`rounded-full px-3 py-1 text-xs font-medium ${activeScope === "personal" ? "bg-surface-hover text-foreground-secondary" : "text-subtle hover:bg-surface hover:text-foreground-secondary"}`}
              >
                Personal
              </button>
            </div>
          )}

          {activeTab === "skills" ? (
            <SkillsView
              mode={mode}
              query={query}
              scope={skillsScope}
              onScopeChange={setSkillsScope}
            />
          ) : activeScope === "personal" ? (
            <p className="py-12 text-center text-sm text-subtle">
              No personal plugins are configured.
            </p>
          ) : (
            <>
              {githubMatches && (
                <section aria-labelledby="github-heading">
                  <div className="mb-3 flex items-center justify-between">
                    <h2
                      id="github-heading"
                      className="text-sm font-semibold text-foreground-secondary"
                    >
                      Popular
                    </h2>
                    {mode === "live" && (
                      <button
                        type="button"
                        onClick={() => void loadStatus()}
                        disabled={loading || mutating}
                        className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                        aria-label="Refresh GitHub status"
                        title="Refresh GitHub status"
                      >
                        <RefreshCw
                          className={
                            loading ? "h-4 w-4 animate-spin" : "h-4 w-4"
                          }
                        />
                      </button>
                    )}
                  </div>

                  <div className="rounded-xl border border-border bg-surface/40 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex min-w-0 items-center gap-4">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
                          <SiGithub className="h-6 w-6 text-foreground" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-medium text-foreground">
                              GitHub
                            </h3>
                            <span className="inline-flex items-center gap-1 text-xs text-muted">
                              {connected ? (
                                <CircleCheck className="h-3.5 w-3.5 text-success" />
                              ) : status.state === "error" ? (
                                <CircleAlert className="h-3.5 w-3.5 text-danger" />
                              ) : (
                                <CircleHelp className="h-3.5 w-3.5 text-subtle" />
                              )}
                              {statusLabel}
                            </span>
                          </div>
                          <p className="mt-1 text-sm text-muted">
                            {connected && mode === "demo"
                              ? "Synthetic account · no GitHub access"
                              : connected && status.login
                                ? `Signed in as @${status.login}`
                                : "Use your local GitHub connection for read-only pull request browsing."}
                          </p>
                        </div>
                      </div>
                      {connected ? (
                        <button
                          type="button"
                          onClick={() => void disconnect()}
                          disabled={mutating}
                          className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                        >
                          {mutating
                            ? "Disconnecting…"
                            : mode === "demo"
                              ? "Disconnect simulation"
                              : "Disconnect"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void connect()}
                          disabled={loading || mutating}
                          className="inline-flex items-center gap-1.5 rounded-md bg-chip px-3 py-1.5 text-sm font-medium text-chip-foreground disabled:opacity-50"
                        >
                          {mutating && (
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          )}
                          {mutating
                            ? "Connecting…"
                            : mode === "demo"
                              ? "Simulate connection"
                              : "Connect GitHub"}
                        </button>
                      )}
                    </div>

                    {mode === "demo" && (
                      <p className="mt-5 border-t border-border pt-4 text-xs text-warning">
                        Demo mode: this connection is simulated and never
                        contacts GitHub.
                      </p>
                    )}
                    {mode === "live" &&
                      !connected &&
                      status.state !== "error" && (
                        <p className="mt-5 border-t border-border pt-4 text-xs text-subtle">
                          GitHub sign-in runs on the selected authorized runner.
                          Choose an existing account or start browser sign-in.
                        </p>
                      )}
                    {visibleError && (
                      <p
                        className="mt-4 flex items-start gap-2 text-xs text-danger"
                        role="alert"
                      >
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {visibleError}
                      </p>
                    )}

                    {mode === "live" && (
                      <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                        <label className="text-xs text-muted">
                          Authorized runner
                          <select
                            value={runnerId}
                            onChange={(event) =>
                              setRunnerId(event.currentTarget.value)
                            }
                            disabled={mutating || runners.length === 0}
                            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
                          >
                            <option value="">Select a runner…</option>
                            {runners.map((runner) => (
                              <option
                                key={runner.deviceId}
                                value={runner.deviceId}
                              >
                                {runner.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-xs text-muted">
                          GitHub account{" "}
                          {accountLoading && (
                            <span className="text-subtle">· loading…</span>
                          )}
                          <select
                            value={status.login ?? ""}
                            onChange={(event) =>
                              void selectAccount(event.currentTarget.value)
                            }
                            disabled={
                              mutating ||
                              accountLoading ||
                              accounts.length === 0
                            }
                            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
                          >
                            <option value="">
                              Select an authorized account…
                            </option>
                            {accounts.map((account) => (
                              <option key={account.login} value={account.login}>
                                {account.login}
                                {account.active ? " · active" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() => void connect()}
                          disabled={mutating || loading}
                          className="rounded-md border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                        >
                          {mutating
                            ? "Opening sign-in…"
                            : "Sign in with GitHub"}
                        </button>
                      </div>
                    )}

                    {connected && (
                      <div className="mt-5 border-t border-border pt-4">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <CapabilityRow
                            label="Read pull requests"
                            enabled={status.capabilities.readPullRequests}
                          />
                          <CapabilityRow
                            label="Publish reviews"
                            enabled={status.capabilities.publishReviews}
                          />
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={onPullRequests}
                            disabled={
                              !status.capabilities.readPullRequests || mutating
                            }
                            className="inline-flex items-center gap-2 rounded-md bg-chip px-3 py-1.5 text-sm text-chip-foreground disabled:opacity-50"
                          >
                            <GitPullRequest className="h-4 w-4" /> Browse pull
                            requests
                          </button>
                          <button
                            type="button"
                            onClick={() => void connect()}
                            disabled={loading || mutating}
                            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted disabled:opacity-50"
                            title="Revalidate the active GitHub CLI account"
                          >
                            <RefreshCw className="h-4 w-4" /> Reconnect
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {filteredOtherPlugins.length > 0 && (
                <section className="mt-8" aria-labelledby="catalogue-heading">
                  <div className="mb-3 flex items-center justify-between">
                    <h2
                      id="catalogue-heading"
                      className="text-sm font-semibold text-foreground-secondary"
                    >
                      Other plugins
                    </h2>
                    <span className="text-xs text-subtle">
                      Unavailable in this slice
                    </span>
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {filteredOtherPlugins.map((plugin) => (
                      <PluginCard key={plugin.title} plugin={plugin} />
                    ))}
                  </div>
                </section>
              )}

              {!githubMatches && filteredOtherPlugins.length === 0 && (
                <p className="py-12 text-center text-sm text-subtle">
                  No plugins match “{query.trim()}”.
                </p>
              )}
            </>
          )}

          {activeTab === "plugins" && (
            <p className="mt-10 flex items-center gap-2 text-xs text-subtle">
              <ShieldCheck className="h-3.5 w-3.5" />
              Pull request browsing is read-only. Automated review runs and
              GitHub publication are unavailable.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

const SKILL_ICONS: Record<StudioSkillIcon, typeof Terminal> = {
  terminal: Terminal,
  browser: Monitor,
  game: Gamepad2,
  web: Globe,
  shield: Shield,
  image: Image,
  docs: BookOpen,
  playwright: Puzzle,
  team: Users,
  memory: Brain
};

function SkillsView({
  mode,
  query,
  scope,
  onScopeChange
}: {
  mode: PluginsMode;
  query: string;
  scope: StudioSkillScope;
  onScopeChange: (scope: StudioSkillScope) => void;
}) {
  const [addedSkills, setAddedSkills] = useState<StudioSkillPreview[]>([]);
  const [hydrated, setHydrated] = useState(mode === "demo");
  const [storageError, setStorageError] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"custom" | "folder" | null>(null);

  useEffect(() => {
    if (mode === "demo") return;
    let stored: StudioSkillPreview[] = [];
    try {
      stored = parseStudioSkillPreviews(
        window.localStorage.getItem(STUDIO_SKILL_PREVIEW_STORAGE_KEY)
      );
    } catch {
      // Preview edits still work in memory when browser storage is unavailable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStorageError(true);
    }
    // Restore after hydration so server and client markup remain identical.
    setAddedSkills(stored);
    setHydrated(true);
  }, [mode]);

  const persist = (next: StudioSkillPreview[]) => {
    setAddedSkills(next);
    if (mode === "live") {
      try {
        window.localStorage.setItem(
          STUDIO_SKILL_PREVIEW_STORAGE_KEY,
          JSON.stringify(next)
        );
        setStorageError(false);
      } catch {
        setStorageError(true);
      }
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleAdded =
    scope === "personal"
      ? addedSkills.filter(
          (skill) =>
            !normalizedQuery ||
            skill.title.toLowerCase().includes(normalizedQuery) ||
            skill.description.toLowerCase().includes(normalizedQuery)
        )
      : [];
  const visibleCatalog = filterStudioSkillCatalog(
    STUDIO_SKILL_CATALOG[scope],
    query
  ).filter(
    (skill) =>
      scope !== "personal" || !hasStudioSkillName(addedSkills, skill.title)
  );
  const hasResults = visibleAdded.length + visibleCatalog.length > 0;

  const addPreview = (input: Omit<StudioSkillPreview, "id">) => {
    if (hasStudioSkillName(addedSkills, input.title)) return;
    persist([createStudioSkillPreview(input), ...addedSkills]);
    setModalMode(null);
    setScopeToPersonal();
  };

  const setScopeToPersonal = () => onScopeChange("personal");

  const refreshLocalPreviews = () => {
    if (mode === "demo") return;
    try {
      setAddedSkills(
        parseStudioSkillPreviews(
          window.localStorage.getItem(STUDIO_SKILL_PREVIEW_STORAGE_KEY)
        )
      );
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };

  return (
    <section aria-labelledby="skills-catalog-heading">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="skills-catalog-heading"
              className="text-base font-semibold text-foreground"
            >
              Skill catalog
            </h2>
            <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              Preview only
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            Skill entries here are local preview metadata. Adding or removing
            one does not install it into an AI Client, read a folder, or change
            Koed services.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip
            content={
              mode === "demo"
                ? "Demo previews reset when you leave"
                : "Reload local skill previews"
            }
          >
            <button
              type="button"
              aria-label="Refresh skill previews"
              onClick={refreshLocalPreviews}
              className="rounded-md p-2 text-muted transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </Tooltip>
          <div className="relative">
            <button
              type="button"
              aria-expanded={addMenuOpen}
              aria-haspopup="menu"
              onClick={() => setAddMenuOpen((current) => !current)}
              className="inline-flex min-h-9 items-center gap-2 rounded-md bg-chip px-3 text-sm font-medium text-chip-foreground transition-colors hover:bg-chip-hover"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add preview
            </button>
            {addMenuOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close add menu"
                  className="fixed inset-0 z-30 cursor-default"
                  onClick={() => setAddMenuOpen(false)}
                />
                <div
                  role="menu"
                  className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-border bg-surface p-1 shadow-xl"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false);
                      setModalMode("custom");
                    }}
                    className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
                  >
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" /> Create
                    skill preview
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false);
                      setModalMode("folder");
                    }}
                    className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
                  >
                    <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />{" "}
                    Add folder path preview
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {mode === "demo" && (
        <p
          className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground-secondary"
          role="note"
        >
          Demo mode: added skill previews stay in page memory and reset when you
          leave. They never call a service or install a skill.
        </p>
      )}
      {storageError && mode === "live" && (
        <p
          className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground-secondary"
          role="status"
        >
          Browser storage is unavailable. Preview edits may be lost when this
          page closes.
        </p>
      )}

      <div
        className="mb-4 flex flex-wrap items-center gap-1 border-b border-border pb-2"
        role="tablist"
        aria-label="Skill preview scope"
      >
        {(
          [
            ["personal", "Personal"],
            ["system", "System"],
            ["koed", "koed-self-hosted"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={scope === id}
            onClick={() => onScopeChange(id)}
            className={`min-h-9 rounded-t-md border-b-2 px-3 text-sm font-medium transition-colors ${scope === id ? "border-accent text-foreground" : "border-transparent text-subtle hover:text-foreground-secondary"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {!hydrated ? (
        <p className="py-10 text-center text-sm text-subtle">
          Loading local skill previews…
        </p>
      ) : !hasResults ? (
        <p className="py-10 text-center text-sm text-subtle">
          {normalizedQuery
            ? "No skills match this search."
            : `No ${scope === "koed" ? "koed-self-hosted" : scope} skills match this view.`}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {visibleAdded.map((skill) => (
            <SkillPreviewCard
              key={skill.id}
              title={skill.title}
              description={
                skill.path
                  ? `${skill.description} · path label: ${skill.path}`
                  : skill.description
              }
              icon="puzzle"
              badge={
                skill.source === "folder" ? "Folder preview" : "Local preview"
              }
              onRemove={() =>
                persist(
                  addedSkills.filter((candidate) => candidate.id !== skill.id)
                )
              }
            />
          ))}
          {visibleCatalog.map((skill) => (
            <SkillPreviewCard
              key={`${scope}-${skill.id}`}
              title={skill.title}
              description={skill.description}
              icon={skill.icon}
              badge={
                scope === "system"
                  ? "System catalog"
                  : scope === "koed"
                    ? "Koed catalog"
                    : undefined
              }
              onAdd={() =>
                addPreview({ ...skillToPreview(skill), source: "catalog" })
              }
            />
          ))}
        </div>
      )}

      {modalMode && (
        <AddSkillPreviewModal
          mode={modalMode}
          existingSkills={addedSkills}
          onClose={() => setModalMode(null)}
          onAdd={addPreview}
        />
      )}
    </section>
  );
}

function skillToPreview(
  skill: StudioSkillCatalogEntry
): Omit<StudioSkillPreview, "id"> {
  return {
    title: skill.title,
    description: skill.description,
    source: "catalog"
  };
}

function SkillPreviewCard({
  title,
  description,
  icon,
  badge,
  onAdd,
  onRemove
}: {
  title: string;
  description: string;
  icon: StudioSkillIcon | "puzzle";
  badge?: string;
  onAdd?: () => void;
  onRemove?: () => void;
}) {
  const Icon = icon === "puzzle" ? Puzzle : SKILL_ICONS[icon];
  return (
    <article className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-surface/50 p-3 transition-colors hover:bg-surface-hover/70">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
          <Icon
            aria-hidden="true"
            className="h-4 w-4 text-foreground-secondary"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground-secondary">
            {title}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-subtle">
            {description}
          </span>
          {badge && (
            <span className="mt-1 block text-[10px] font-medium text-warning">
              {badge}
            </span>
          )}
        </span>
      </div>
      {onAdd && (
        <Tooltip content={`Add ${title} to local preview`}>
          <button
            type="button"
            aria-label={`Add ${title} preview`}
            onClick={onAdd}
            className="shrink-0 rounded-md p-2 text-muted hover:bg-surface-active hover:text-foreground"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </button>
        </Tooltip>
      )}
      {onRemove && (
        <Tooltip content="Remove from local preview">
          <button
            type="button"
            aria-label={`Remove ${title} preview`}
            onClick={onRemove}
            className="shrink-0 rounded-md p-2 text-muted hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </Tooltip>
      )}
    </article>
  );
}

function AddSkillPreviewModal({
  mode,
  existingSkills,
  onClose,
  onAdd
}: {
  mode: "custom" | "folder";
  existingSkills: StudioSkillPreview[];
  onClose: () => void;
  onAdd: (input: Omit<StudioSkillPreview, "id">) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [path, setPath] = useState("");
  const isFolder = mode === "folder";
  const duplicate = hasStudioSkillName(existingSkills, title);
  const canAdd =
    Boolean(title.trim()) && (!isFolder || Boolean(path.trim())) && !duplicate;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-preview-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2
            id="skill-preview-modal-title"
            className="text-sm font-semibold text-foreground"
          >
            {isFolder ? "Add folder path preview" : "Create skill preview"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 p-4">
          <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-foreground-secondary">
            Preview metadata only. This does not create files, read the folder,
            or install a skill into an AI Client.
          </p>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Skill name
            </span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Frontend review"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Description
            </span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this skill preview describes"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>
          {isFolder && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">
                Folder path label
              </span>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={`~/skills/${slugifyStudioSkillName(title)}`}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </label>
          )}
          {duplicate && (
            <p className="text-xs text-warning" role="status">
              A preview with this name already exists in Personal.
            </p>
          )}
        </div>
        <footer className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            disabled={!canAdd}
            onClick={() =>
              onAdd({
                title: title.trim(),
                description:
                  description.trim() ||
                  (isFolder ? "Folder path preview" : "Custom skill preview"),
                source: isFolder ? "folder" : "custom",
                ...(isFolder ? { path: path.trim() } : {})
              })
            }
            className="min-h-9 rounded-md bg-chip px-4 text-sm font-medium text-chip-foreground hover:bg-chip-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add preview
          </button>
        </footer>
      </section>
    </div>
  );
}
