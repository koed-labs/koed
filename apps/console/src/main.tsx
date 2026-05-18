import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD ? window.location.origin : "http://localhost:3000")
).replace(/\/$/, "");

type SetupStatus = { configured: boolean; authMode: string };
type User = { id: string; email: string; displayName: string | null };
type ApiToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
};
type CapturePolicy = {
  id: string;
  targetType: "global" | "project" | "thread";
  captureState: "enabled" | "disabled" | "ask" | null;
  visibility: "personal" | "team" | null;
  pauseUntil: string | null;
};
type GraphRecord = {
  id: string;
  summaryText?: string;
  contentPreview?: string;
  visibility: string;
  invalidatedAt: string | null;
};
type GraphEvent = GraphRecord & {
  actor: string | null;
  eventType: string;
  sourceRuntime: string | null;
  captureMethod: string;
  model: string | null;
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  timestamp: string;
  rawContent?: string;
  metadata: Record<string, unknown>;
  linkedNodeIds: string[];
};
type GraphNode = GraphRecord & {
  kind: "leaf" | "rollup";
  depth: number;
  summaryStatus: "pending" | "summarized";
  projectId: string | null;
  projectName: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  createdAt: string;
  updatedAt: string;
  sourceEventCount: number;
  embeddingCount: number;
};
type ThreadGroup = {
  id: string;
  name: string;
  projectName: string;
  projectId: string | null;
  latestAt: string;
  eventCount: number;
  sample: string;
};
type MemoryAnswer = {
  markdown?: string;
  mode?: string;
  evidence?: Array<{ summaryText?: string; visibility?: string; nodeId?: string }>;
  retrieval?: Record<string, unknown>;
  localMemoryWorker?: Record<string, unknown>;
};
type SmokeResult = {
  ok: boolean;
  marker: string;
  content: string;
  recall: { hits: number; topHit: unknown; retrieval: unknown };
};

const requestJson = async <T,>(
  path: string,
  options: RequestInit = {}
): Promise<T> => {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
};

const copyText = (value: string) => void navigator.clipboard.writeText(value);

const FieldCopy = ({
  label,
  value,
  masked = false
}: {
  label: string;
  value: string;
  masked?: boolean;
}) => (
  <div className="copy-field">
    <span>{label}</span>
    <code>{masked ? value.replace(/^(.{8}).+(.{4})$/, "$1...$2") : value}</code>
    <button type="button" className="ghost" onClick={() => copyText(value)}>
      Copy
    </button>
  </div>
);

const StatusDot = ({ status }: { status: string }) => {
  const normalized = status.toLowerCase();
  const tone =
    normalized.includes("ok") ||
    normalized.includes("true") ||
    normalized.includes("healthy")
      ? "ok"
      : normalized.includes("error") || normalized.includes("false")
        ? "error"
        : "warn";
  return <span className={`status-dot ${tone}`}>{status}</span>;
};

const JsonBlock = ({ value }: { value: unknown }) => (
  <div className="code-box">
    <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    <button
      type="button"
      className="secondary"
      onClick={() =>
        copyText(typeof value === "string" ? value : JSON.stringify(value, null, 2))
      }
    >
      Copy
    </button>
  </div>
);

const eventThreadId = (event: GraphEvent) =>
  event.threadId ?? event.sessionId ?? event.projectId ?? "unthreaded";

const nodeThreadId = (node: GraphNode) =>
  node.threadId ?? node.sessionId ?? node.projectId ?? "unthreaded";

const App = () => {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [policies, setPolicies] = useState<CapturePolicy[]>([]);
  const [providers, setProviders] = useState<Array<Record<string, unknown>>>([]);
  const [nodes, setNodes] = useState<GraphRecord[]>([]);
  const [events, setEvents] = useState<GraphRecord[]>([]);
  const [historyEvents, setHistoryEvents] = useState<GraphEvent[]>([]);
  const [historyNodes, setHistoryNodes] = useState<GraphNode[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyAnswer, setHistoryAnswer] = useState<MemoryAnswer | null>(null);
  const [historyToken, setHistoryToken] = useState(
    localStorage.getItem("koed.historyToken") ?? ""
  );
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(
    null
  );
  const [memoryExport, setMemoryExport] = useState<Record<string, unknown> | null>(
    null
  );
  const [smokeResult, setSmokeResult] = useState<SmokeResult | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokenName, setTokenName] = useState("Codex MCP");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [repoPath, setCheckoutPath] = useState(
    localStorage.getItem("koed.repoPath") ?? ""
  );
  const [nodeCommand, setNodeCommand] = useState(
    localStorage.getItem("koed.nodeCommand") ?? "node"
  );
  const [activeSection, setActiveSection] = useState("setup");
  const [error, setError] = useState<string | null>(null);

  const components = status?.components as
    | Record<string, Record<string, unknown>>
    | undefined;
  const configuration = status?.configuration as
    | Record<string, unknown>
    | undefined;

  const refreshPublic = async () => {
    const [setupStatus, selfHostStatus] = await Promise.all([
      requestJson<SetupStatus>("/auth/setup-status"),
      requestJson<Record<string, unknown>>("/self-host/status")
    ]);
    setSetup(setupStatus);
    setStatus(selfHostStatus);
    const configuredPath = selfHostStatus.configuration
      ? String(
          (selfHostStatus.configuration as Record<string, unknown>)
            .localRepositoryPath ?? ""
        )
      : "";
    if (!repoPath && configuredPath) {
      setCheckoutPath(configuredPath);
    }
  };

  const refreshPrivate = async () => {
    const [me, graph, apiTokens, capturePolicies, providerConfigs] =
      await Promise.all([
        requestJson<{ user: User }>("/me"),
        requestJson<{ overview: Record<string, unknown> }>(
          "/v1/memory/graph/overview"
        ),
        requestJson<{ apiTokens: ApiToken[] }>("/api-tokens"),
        requestJson<{ policies: CapturePolicy[] }>("/v1/capture-policies"),
        requestJson<{ providerConfigs: Array<Record<string, unknown>> }>(
          "/provider-configs"
        )
      ]);
    setUser(me.user);
    setOverview(graph.overview);
    setTokens(apiTokens.apiTokens);
    setPolicies(capturePolicies.policies);
    setProviders(providerConfigs.providerConfigs);
  };

  useEffect(() => {
    refreshPublic()
      .then(refreshPrivate)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    localStorage.setItem("koed.repoPath", repoPath);
  }, [repoPath]);

  useEffect(() => {
    localStorage.setItem("koed.nodeCommand", nodeCommand);
  }, [nodeCommand]);

  useEffect(() => {
    localStorage.setItem("koed.historyToken", historyToken);
  }, [historyToken]);

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await requestJson(setup?.configured ? "/auth/login" : "/auth/setup", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      await refreshPublic();
      await refreshPrivate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const createToken = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    try {
      const created = await requestJson<{ token: string }>("/api-tokens", {
        method: "POST",
        body: JSON.stringify({
          name: tokenName,
          scopes: ["memory:read", "memory:write"]
        })
      });
      setNewToken(created.token);
      await refreshPrivate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const revokeToken = async (id: string) => {
    await requestJson(`/api-tokens/${id}`, { method: "DELETE" });
    if (newToken) {
      setNewToken(null);
    }
    await refreshPrivate();
  };

  const runSmokeTest = async () => {
    setError(null);
    try {
      const result = await requestJson<SmokeResult>("/self-host/smoke-test", {
        method: "POST",
        body: "{}"
      });
      setSmokeResult(result);
      await refreshPrivate();
      setActiveSection("memory");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveGlobalPolicy = async (captureState: string, pauseUntil: string | null = null) => {
    await requestJson("/v1/capture-policies", {
      method: "PUT",
      body: JSON.stringify({
        targetType: "global",
        captureState,
        visibility: "personal",
        pauseUntil
      })
    });
    await refreshPrivate();
  };

  const loadGovernance = async () => {
    const [nodeResult, eventResult, exportResult] = await Promise.all([
      requestJson<{ nodes: GraphRecord[] }>(
        "/v1/memory/graph/nodes?includeInvalidated=true&limit=20"
      ),
      requestJson<{ events: GraphRecord[] }>(
        "/v1/memory/graph/events?includeInvalidated=true&limit=20"
      ),
      requestJson<Record<string, unknown>>("/v1/memory/export")
    ]);
    setNodes(nodeResult.nodes);
    setEvents(eventResult.events);
    setMemoryExport(exportResult);
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const [eventResult, nodeResult] = await Promise.all([
        requestJson<{ events: GraphEvent[] }>(
          "/v1/memory/graph/events?limit=500&includeInvalidated=false"
        ),
        requestJson<{ nodes: GraphNode[] }>(
          "/v1/memory/graph/nodes?limit=500&includeInvalidated=false"
        )
      ]);
      setHistoryEvents(eventResult.events);
      setHistoryNodes(nodeResult.nodes);
    } finally {
      setHistoryLoading(false);
    }
  };

  const invalidateRecord = async (kind: "nodes" | "events", id: string) => {
    await requestJson(`/v1/memory/graph/${kind}/${id}`, { method: "DELETE" });
    await loadGovernance();
    await refreshPrivate();
  };

  const loadDiagnostics = async () => {
    setDiagnostics(
      await requestJson<Record<string, unknown>>("/self-host/diagnostics")
    );
  };

  useEffect(() => {
    if (!user || activeSection !== "history") {
      return;
    }
    void loadHistory();
  }, [user, activeSection]);

  useEffect(() => {
    if (!user) {
      return;
    }
    const stream = new EventSource(`${apiBaseUrl}/v1/memory/graph/stream`, {
      withCredentials: true
    });
    stream.addEventListener("graph_update", () => {
      if (activeSection === "history") {
        void loadHistory();
      }
      void refreshPrivate();
    });
    stream.onerror = () => stream.close();
    return () => stream.close();
  }, [user, activeSection]);

  const graphCounts = {
    events: Number(overview?.capturedEvents ?? 0),
    nodes: Number(overview?.leafNodes ?? 0) + Number(overview?.rollupNodes ?? 0),
    pending: Number(overview?.pendingSummaries ?? 0),
    deleted: Number(overview?.invalidatedRecords ?? 0)
  };
  const globalCapturePolicy = policies.find(
    (policy) => policy.targetType === "global"
  );
  const capturePaused =
    globalCapturePolicy?.pauseUntil &&
    new Date(globalCapturePolicy.pauseUntil).getTime() > Date.now();
  const captureStatus = capturePaused
    ? "paused"
    : (globalCapturePolicy?.captureState ?? "enabled");

  const tokenForSetup = newToken ?? "<create a token first>";
  const mcpArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/cli.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/cli.js";
  const hookArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/capture-hook.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js";
  const hookConfigPath = "~/.koed-memory/config.json";
  const hookCommand = `${nodeCommand} ${hookArg} --config ${hookConfigPath}`;
  const hookConfigJson = JSON.stringify(
    {
      apiUrl: apiBaseUrl,
      apiToken: tokenForSetup,
      captureEnabled: true
    },
    null,
    2
  );
  const codexConfigToml = `[mcp_servers.koed]
command = "${nodeCommand}"
args = ["${mcpArg}"]
enabled = true

[mcp_servers.koed.env]
CODEX_MEMORY_BASE_URL = "${apiBaseUrl}"
CODEX_MEMORY_API_TOKEN = "${tokenForSetup}"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${hookCommand}"
timeout = 10

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "${hookCommand}"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "${hookCommand}"
timeout = 30`;
  const codexConfigureCommand = `CODEX_MEMORY_API_TOKEN="${tokenForSetup}" pnpm codex:configure`;
  const setupComplete =
    Boolean(user) &&
    tokens.length > 0 &&
    Boolean(configuration?.embeddingModel) &&
    Boolean(smokeResult?.ok || graphCounts.events > 0);

  const sections = [
    ["setup", "Setup"],
    ["status", "Status"],
    ["clients", "AI Clients"],
    ["memory", "Memory"],
    ["history", "History"],
    ["security", "Security"]
  ] as const;

  const threadGroups = useMemo(() => {
    const groups = new Map<string, ThreadGroup>();
    for (const event of historyEvents) {
      const id = eventThreadId(event);
      const existing = groups.get(id);
      const projectName = event.projectName ?? event.projectPath ?? "Local workspace";
      if (!existing) {
        groups.set(id, {
          id,
          name: event.threadName ?? event.sessionId ?? "Untitled session",
          projectId: event.projectId,
          projectName,
          latestAt: event.timestamp,
          eventCount: 1,
          sample: event.contentPreview ?? ""
        });
        continue;
      }
      existing.eventCount += 1;
      if (event.timestamp > existing.latestAt) {
        existing.latestAt = event.timestamp;
        existing.sample = event.contentPreview ?? existing.sample;
      }
    }
    return [...groups.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }, [historyEvents]);

  const selectedThread = selectedThreadId
    ? threadGroups.find((thread) => thread.id === selectedThreadId) ?? null
    : (threadGroups[0] ?? null);
  const selectedEvents = selectedThread
    ? historyEvents
        .filter((event) => eventThreadId(event) === selectedThread.id)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    : [];
  const selectedNodes = selectedThread
    ? historyNodes.filter((node) => nodeThreadId(node) === selectedThread.id)
    : [];

  const askMemory = async (event: FormEvent) => {
    event.preventDefault();
    if (!historyQuery.trim()) {
      return;
    }
    if (!historyToken.trim()) {
      setError("Paste a Koed API token before querying memory.");
      return;
    }
    setError(null);
    try {
      const answer = await requestJson<MemoryAnswer>("/v1/memory/answer", {
        method: "POST",
        headers: { authorization: `Bearer ${historyToken.trim()}` },
        body: JSON.stringify({
          query: historyQuery.trim(),
          retrieval_scope: "personal",
          search_domain: selectedThread?.projectId ? "project" : "global",
          workspace_id: selectedThread?.projectId,
          limit: 10
        })
      });
      setHistoryAnswer(answer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <main>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">K</div>
          <div>
            <strong>Koed</strong>
            <span>Self-hosted</span>
          </div>
        </div>
        <nav>
          {sections.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={activeSection === id ? "active" : ""}
              onClick={() => setActiveSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusDot status={setupComplete ? "ready" : "setup"} />
          <button
            type="button"
            className="ghost"
            onClick={() => void refreshPublic().then(refreshPrivate)}
          >
            Refresh
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="page-header">
          <div>
            <p className="eyebrow">Local operator console</p>
            <h1>{setupComplete ? "Koed is ready" : "Finish local setup"}</h1>
            <p>
              Configure the local backend, generate AI-client fields, and verify
              capture without leaving this console.
            </p>
          </div>
          <div className="header-stats">
            <div>
              <span>Events</span>
              <strong>{graphCounts.events}</strong>
            </div>
            <div>
              <span>Nodes</span>
              <strong>{graphCounts.nodes}</strong>
            </div>
            <div>
              <span>Pending</span>
              <strong>{graphCounts.pending}</strong>
            </div>
          </div>
        </header>

        {error ? <div className="alert">{error}</div> : null}
        {newToken ? (
          <div className="token-banner">
            <div>
              <strong>New token created</strong>
              <span>Copy it now. Koed will only show the full value once.</span>
            </div>
            <code>{newToken}</code>
            <button type="button" onClick={() => copyText(newToken)}>
              Copy token
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setNewToken(null)}
            >
              Hide
            </button>
          </div>
        ) : null}

        {activeSection === "setup" ? (
          <div className="section-grid">
            <section className="surface setup-flow">
              <h2>Setup checklist</h2>
              <ol>
                <li className={user ? "done" : "current"}>
                  <span>1</span>
                  <div>
                    <strong>Local admin</strong>
                    <p>
                      {user
                        ? `Signed in as ${user.email}`
                        : "Create the first account inside this local database."}
                    </p>
                  </div>
                </li>
                <li className={tokens.length > 0 ? "done" : user ? "current" : ""}>
                  <span>2</span>
                  <div>
                    <strong>API token</strong>
                    <p>
                      {tokens.length > 0
                        ? `${tokens.length} active token${tokens.length === 1 ? "" : "s"}`
                        : "Create one token for your AI client."}
                    </p>
                  </div>
                </li>
                <li className={smokeResult?.ok ? "done" : tokens.length > 0 ? "current" : ""}>
                  <span>3</span>
                  <div>
                    <strong>Smoke test</strong>
                    <p>
                      {smokeResult?.ok
                        ? "Capture and recall verified."
                        : "Let Koed create and recall a local test memory."}
                    </p>
                  </div>
                </li>
                <li className={tokens.length > 0 ? "current" : ""}>
                  <span>4</span>
                  <div>
                    <strong>AI client</strong>
                    <p>Copy generated fields into your selected local client.</p>
                  </div>
                </li>
              </ol>
            </section>

            <section className="surface action-panel">
              {!user ? (
                <>
                  <h2>{setup?.configured ? "Sign in" : "Create local admin"}</h2>
                  <p>
                    This account exists only in the self-hosted Postgres
                    database.
                  </p>
                  <form onSubmit={submitAuth}>
                    <label>
                      Email
                      <input
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                      />
                    </label>
                    <label>
                      Password
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Minimum 8 characters"
                      />
                    </label>
                    <button>{setup?.configured ? "Sign in" : "Create admin"}</button>
                  </form>
                </>
              ) : (
                <>
                  <h2>Next action</h2>
                  {tokens.length === 0 ? (
                    <>
                      <p>Create a token for Codex or another local AI client.</p>
                      <form className="inline-form" onSubmit={createToken}>
                        <input
                          value={tokenName}
                          onChange={(event) => setTokenName(event.target.value)}
                        />
                        <button>Create token</button>
                      </form>
                    </>
                  ) : (
                    <>
                      <p>
                        Run the smoke test to verify capture, compaction, and
                        recall from the console.
                      </p>
                      <button type="button" onClick={() => void runSmokeTest()}>
                        Run smoke test
                      </button>
                    </>
                  )}
                </>
              )}
            </section>
          </div>
        ) : null}

        {activeSection === "status" ? (
          <div className="section-grid">
            <section className="surface">
              <h2>Service status</h2>
              <div className="status-list">
                {components
                  ? Object.entries(components).map(([name, component]) => (
                      <div key={name}>
                        <span>{name}</span>
                        <StatusDot
                          status={String(
                            component.status ??
                              component.healthy ??
                              component.enabled ??
                              "configured"
                          )}
                        />
                      </div>
                    ))
                  : null}
              </div>
            </section>
            <section className="surface">
              <h2>Runtime</h2>
              <div className="status-list">
                {configuration
                  ? Object.entries(configuration)
                      .filter(([key]) => key !== "localRepositoryPath")
                      .map(([key, value]) => (
                        <div key={key}>
                          <span>{key}</span>
                          <strong>
                            {Array.isArray(value) ? value.join(", ") : String(value)}
                          </strong>
                        </div>
                      ))
                  : null}
              </div>
            </section>
          </div>
        ) : null}

        {activeSection === "clients" ? (
          <div className="client-layout">
            <section className="surface">
              <h2>Codex Desktop</h2>
              <p>
                Codex is supported now. The console can generate the fields, but
                Codex Desktop must save its own MCP configuration.
              </p>
              <div className="form-stack">
                <label>
                  Local repository path
                  <input
                    value={repoPath}
                    onChange={(event) => setCheckoutPath(event.target.value)}
                    placeholder="/path/to/koed-self-hosted"
                  />
                </label>
                <label>
                  Command
                  <input
                    value={nodeCommand}
                    onChange={(event) => setNodeCommand(event.target.value)}
                  />
                </label>
              </div>
              <div className="field-grid">
                <FieldCopy label="Name" value="koed-selfhost" />
                <FieldCopy label="Transport" value="STDIO" />
                <FieldCopy label="Command" value={nodeCommand} />
                <FieldCopy label="Argument" value={mcpArg} />
                <FieldCopy
                  label="CODEX_MEMORY_BASE_URL"
                  value={apiBaseUrl}
                />
                <FieldCopy
                  label="CODEX_MEMORY_API_TOKEN"
                  value={tokenForSetup}
                  masked={newToken === null}
                />
                <FieldCopy
                  label="Working directory"
                  value={repoPath || "/path/to/koed-self-hosted"}
                />
              </div>
            </section>
            <section className="surface wide">
              <h2>Automatic capture hooks</h2>
              <p>
                MCP enables memory answers. Codex hooks capture prompts,
                assistant messages, and tool results into Koed automatically.
                Run the setup command from this repo, or add the generated TOML
                block manually, then restart Codex.
              </p>
              <FieldCopy label="Setup command" value={codexConfigureCommand} />
              <JsonBlock value={codexConfigToml} />
              <h3>Hook config file</h3>
              <p>
                Save this JSON at `~/.koed-memory/config.json` with file mode
                `0600`. The hook reads it outside the MCP process.
              </p>
              <JsonBlock value={hookConfigJson} />
            </section>
            <section className="surface">
              <h2>Other clients</h2>
              <p>
                Claude, Gemini, Cursor, Pi, and other clients will need their
                own setup surfaces. This console should keep each guide explicit
                instead of pretending every client can be automated the same way.
              </p>
              <div className="client-list">
                {["Claude", "Gemini", "Cursor", "Pi"].map((client) => (
                  <div key={client}>
                    <strong>{client}</strong>
                    <span>Planned setup guide</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {activeSection === "memory" ? (
          <div className="section-grid">
            <section className="surface">
              <h2>Memory graph</h2>
              <div className="metric-row">
                <div>
                  <span>Captured events</span>
                  <strong>{graphCounts.events}</strong>
                </div>
                <div>
                  <span>Nodes</span>
                  <strong>{graphCounts.nodes}</strong>
                </div>
                <div>
                  <span>Deleted</span>
                  <strong>{graphCounts.deleted}</strong>
                </div>
              </div>
              {smokeResult ? (
                <div className="result-box">
                  <StatusDot status={smokeResult.ok ? "verified" : "failed"} />
                  <p>{smokeResult.content}</p>
                  <small>{smokeResult.marker}</small>
                </div>
              ) : (
                <p className="empty">Run the smoke test to create the first memory.</p>
              )}
            </section>
            <section className="surface">
              <h2>Capture policy</h2>
              <p>
                Hooks check this policy before storing conversation events.
                Disable or pause capture here to stop automatic ingestion without
                editing Codex config.
              </p>
              <div className="segmented">
                <button
                  type="button"
                  className={captureStatus === "enabled" ? "" : "secondary"}
                  onClick={() => void saveGlobalPolicy("enabled")}
                >
                  enabled
                </button>
                <button
                  type="button"
                  className={captureStatus === "paused" ? "" : "secondary"}
                  onClick={() =>
                    void saveGlobalPolicy(
                      "enabled",
                      new Date(Date.now() + 60 * 60 * 1000).toISOString()
                    )
                  }
                >
                  pause 1h
                </button>
                <button
                  type="button"
                  className={captureStatus === "disabled" ? "" : "secondary"}
                  onClick={() => void saveGlobalPolicy("disabled")}
                >
                  disabled
                </button>
              </div>
              <ul className="plain-list">
                <li>global: {captureStatus}</li>
                {globalCapturePolicy?.pauseUntil ? (
                  <li>pause until: {new Date(globalCapturePolicy.pauseUntil).toLocaleString()}</li>
                ) : null}
              </ul>
            </section>
            <section className="surface wide">
              <h2>Governance</h2>
              <button type="button" onClick={() => void loadGovernance()}>
                Load export and recent records
              </button>
              <div className="governance-grid">
                <RecordTable
                  title="Nodes"
                  records={nodes}
                  textKey="summaryText"
                  onDelete={(id) => void invalidateRecord("nodes", id)}
                />
                <RecordTable
                  title="Events"
                  records={events}
                  textKey="contentPreview"
                  onDelete={(id) => void invalidateRecord("events", id)}
                />
              </div>
              {memoryExport ? <JsonBlock value={memoryExport} /> : null}
            </section>
          </div>
        ) : null}

        {activeSection === "history" ? (
          <div className="history-shell">
            <section className="history-sidebar surface">
              <div className="section-title-row">
                <div>
                  <h2>Captured sessions</h2>
                  <p>{threadGroups.length} threads from recent graph events.</p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void loadHistory()}
                >
                  {historyLoading ? "Loading" : "Reload"}
                </button>
              </div>
              <div className="thread-list">
                {threadGroups.length === 0 ? (
                  <p className="empty">No captured sessions yet.</p>
                ) : (
                  threadGroups.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className={selectedThread?.id === thread.id ? "active" : ""}
                      onClick={() => setSelectedThreadId(thread.id)}
                    >
                      <strong>{thread.name}</strong>
                      <span>{thread.projectName}</span>
                      <small>
                        {thread.eventCount} events ·{" "}
                        {new Date(thread.latestAt).toLocaleString()}
                      </small>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="history-main">
              <div className="history-toolbar surface">
                <div>
                  <p className="eyebrow">History browser</p>
                  <h2>{selectedThread?.name ?? "No session selected"}</h2>
                  <p>
                    Browse captured conversation events, inspect linked memory,
                    and query recall against the local API.
                  </p>
                </div>
                <div className="history-kpis">
                  <div>
                    <span>Events</span>
                    <strong>{selectedEvents.length}</strong>
                  </div>
                  <div>
                    <span>Nodes</span>
                    <strong>{selectedNodes.length}</strong>
                  </div>
                </div>
              </div>

              <form className="memory-ask surface" onSubmit={askMemory}>
                <label>
                  API token for memory query
                  <input
                    value={historyToken}
                    onChange={(event) => setHistoryToken(event.target.value)}
                    placeholder="Paste a console-created token"
                  />
                </label>
                <label>
                  Ask local memory
                  <input
                    value={historyQuery}
                    onChange={(event) => setHistoryQuery(event.target.value)}
                    placeholder="What should Koed remember about this project?"
                  />
                </label>
                <button>Ask</button>
              </form>

              {historyAnswer ? (
                <section className="surface answer-panel">
                  <h2>Answer</h2>
                  <p>{historyAnswer.markdown ?? "No answer returned."}</p>
                  {historyAnswer.evidence?.length ? (
                    <div className="evidence-list">
                      {historyAnswer.evidence.slice(0, 4).map((item, index) => (
                        <div key={`${item.nodeId ?? index}`}>
                          <strong>{item.visibility ?? "personal"}</strong>
                          <span>{item.summaryText ?? item.nodeId}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section className="surface event-timeline">
                <h2>Timeline</h2>
                {selectedEvents.length === 0 ? (
                  <p className="empty">Select a thread with captured events.</p>
                ) : (
                  selectedEvents.map((event) => (
                    <article key={event.id}>
                      <div>
                        <strong>{event.actor ?? "event"}</strong>
                        <span>{event.eventType}</span>
                      </div>
                      <p>{event.contentPreview}</p>
                      <small>
                        {event.sourceRuntime ?? "unknown"} · {event.captureMethod} ·{" "}
                        {new Date(event.timestamp).toLocaleString()}
                      </small>
                    </article>
                  ))
                )}
              </section>
            </section>
          </div>
        ) : null}

        {activeSection === "security" ? (
          <div className="section-grid">
            <section className="surface">
              <h2>API tokens</h2>
              <form className="inline-form" onSubmit={createToken}>
                <input
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                />
                <button>Create</button>
              </form>
              <div className="token-list">
                {tokens.map((token) => (
                  <div key={token.id}>
                    <div>
                      <strong>{token.name}</strong>
                      <span>{token.tokenPrefix}</span>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void revokeToken(token.id)}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            </section>
            <section className="surface">
              <h2>Provider keys</h2>
              <p>
                {providers.length
                  ? `${providers.length} server-side provider configuration(s) saved.`
                  : "No server-side model provider configured. This is expected in codex_subscription mode."}
              </p>
            </section>
            <section className="surface wide">
              <h2>Diagnostics</h2>
              <button type="button" onClick={() => void loadDiagnostics()}>
                Generate redacted output
              </button>
              {diagnostics ? <JsonBlock value={diagnostics} /> : null}
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
};

const RecordTable = ({
  title,
  records,
  textKey,
  onDelete
}: {
  title: string;
  records: GraphRecord[];
  textKey: "summaryText" | "contentPreview";
  onDelete: (id: string) => void;
}) => (
  <div>
    <h3>{title}</h3>
    {records.length === 0 ? (
      <p className="empty">No records loaded.</p>
    ) : (
      <table>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td>{record[textKey] ?? record.id}</td>
              <td>{record.visibility}</td>
              <td>
                {record.invalidatedAt ? (
                  <StatusDot status="deleted" />
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => onDelete(record.id)}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

createRoot(document.getElementById("root")!).render(<App />);
