import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ViteEnvironment = {
  VITE_API_BASE_URL?: string;
  PROD?: boolean;
};

const viteEnvironment = import.meta.env as ViteEnvironment;
const apiBaseUrl = (
  viteEnvironment.VITE_API_BASE_URL ??
  (viteEnvironment.PROD ? window.location.origin : "http://localhost:3000")
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
  visibility: "personal" | null;
};
type GraphRecord = {
  id: string;
  summaryText?: string;
  contentPreview?: string;
  visibility: string;
  invalidatedAt: string | null;
};
type SmokeResult = {
  ok: boolean;
  marker: string;
  content: string;
  recall: { hits: number; topHit: unknown; retrieval: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const errorMessageFromBody = (body: unknown): string | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  return typeof body.error === "string" ? body.error : undefined;
};

const displayString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : fallback;

const displayRuntimeValue = (value: unknown): string =>
  Array.isArray(value)
    ? value.map((item) => displayString(item, "unknown")).join(", ")
    : displayString(value, "unknown");

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
    const body = (await response.json().catch(() => ({}))) as unknown;
    throw new Error(errorMessageFromBody(body) ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
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
    normalized.includes("ready") ||
    normalized.includes("good") ||
    normalized.includes("enabled") ||
    normalized.includes("verified") ||
    normalized.includes("configured") ||
    normalized.includes("true") ||
    normalized.includes("healthy")
      ? "ok"
      : normalized.includes("error") ||
          normalized.includes("false") ||
          normalized.includes("failed") ||
          normalized.includes("disabled")
        ? "error"
        : "warn";
  return <span className={`status-dot ${tone}`}>{status}</span>;
};

const JsonBlock = ({ value }: { value: unknown }) => (
  <div className="code-box">
    <pre>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
    <button
      type="button"
      className="secondary"
      onClick={() =>
        copyText(
          typeof value === "string" ? value : JSON.stringify(value, null, 2)
        )
      }
    >
      Copy
    </button>
  </div>
);

const App = () => {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [overview, setOverview] = useState<Record<string, unknown> | null>(
    null
  );
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [policies, setPolicies] = useState<CapturePolicy[]>([]);
  const [nodes, setNodes] = useState<GraphRecord[]>([]);
  const [events, setEvents] = useState<GraphRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [memoryExport, setMemoryExport] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [smokeResult, setSmokeResult] = useState<SmokeResult | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokenName, setTokenName] = useState("Client Integration");
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
      ? displayString(
          (selfHostStatus.configuration as Record<string, unknown>)
            .localRepositoryPath
        )
      : "";
    if (!repoPath && configuredPath) {
      setCheckoutPath(configuredPath);
    }
  };

  const refreshPrivate = async () => {
    const [me, graph, apiTokens, capturePolicies] = await Promise.all([
      requestJson<{ user: User }>("/me"),
      requestJson<{ overview: Record<string, unknown> }>(
        "/v1/memory/graph/overview"
      ),
      requestJson<{ apiTokens: ApiToken[] }>("/api-tokens"),
      requestJson<{ policies: CapturePolicy[] }>("/v1/capture-policies")
    ]);
    setUser(me.user);
    setOverview(graph.overview);
    setTokens(apiTokens.apiTokens);
    setPolicies(capturePolicies.policies);
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
        body: JSON.stringify({ name: tokenName })
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

  const saveGlobalPolicy = async (captureState: string) => {
    await requestJson("/v1/capture-policies", {
      method: "PUT",
      body: JSON.stringify({
        targetType: "global",
        captureState,
        visibility: "personal"
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

  const graphCounts = {
    events: Number(overview?.capturedEvents ?? 0),
    nodes:
      Number(overview?.leafNodes ?? 0) + Number(overview?.rollupNodes ?? 0),
    leafNodes: Number(overview?.leafNodes ?? 0),
    rollups: Number(overview?.rollupNodes ?? 0),
    pending: Number(overview?.pendingSummaries ?? 0),
    deleted: Number(overview?.invalidatedRecords ?? 0)
  };

  const tokenForSetup = newToken ?? "<create a token first>";
  const mcpArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/cli.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/cli.js";
  const captureHookArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/capture-hook.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js";
  const setupComplete =
    Boolean(user) &&
    tokens.length > 0 &&
    Boolean(configuration?.embeddingModel) &&
    Boolean(smokeResult?.ok || graphCounts.events > 0);

  const sections = [
    ["setup", "Setup & Status"],
    ["memory", "Memory"],
    ["security", "Security"]
  ] as const;

  const pageCopy = {
    setup: {
      title: setupComplete ? "Koed is ready" : "Finish local setup",
      body: "Configure the local backend, check runtime health, and verify capture from one place."
    },
    memory: {
      title: "Memory usage",
      body: "Track local ingestion volume, summarisation health, and capture controls."
    },
    security: {
      title: "Security",
      body: "Manage local API tokens and generate redacted diagnostics."
    }
  }[activeSection as "setup" | "memory" | "security"] ?? {
    title: "Koed",
    body: "Local operator console."
  };

  const runtimeItems = [
    ["Embedding model", configuration?.embeddingModel],
    ["Embedding dimensions", configuration?.embeddingDimensions],
    ["Reranking enabled", configuration?.rerankingEnabled]
  ] as const;

  const globalCapturePolicy = policies.find(
    (policy) => policy.targetType === "global"
  );
  const captureStatus = globalCapturePolicy?.captureState ?? "enabled";

  const quickStartItems = [
    {
      label: "Local admin",
      detail: user
        ? `Signed in as ${user.email}`
        : "Create the first local account.",
      done: Boolean(user)
    },
    {
      label: "API token",
      detail: tokens.length
        ? `${tokens.length} active token${tokens.length === 1 ? "" : "s"}`
        : "Create one token for your AI client.",
      done: tokens.length > 0
    },
    {
      label: "Runtime ready",
      detail: configuration?.embeddingModel
        ? "Embedding runtime is configured."
        : "Waiting for local runtime configuration.",
      done: Boolean(configuration?.embeddingModel)
    },
    {
      label: "Memory verified",
      detail:
        smokeResult?.ok || graphCounts.events > 0
          ? "Koed has captured local memory."
          : "Verify capture once the token exists.",
      done: Boolean(smokeResult?.ok || graphCounts.events > 0)
    }
  ];

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
            <h1>{pageCopy.title}</h1>
            <p>{pageCopy.body}</p>
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
            <section className="surface quick-start">
              <div className="section-title-row">
                <div>
                  <h2>Quick start</h2>
                  <p>Core checks for a working local Koed install.</p>
                </div>
                <StatusDot
                  status={setupComplete ? "good to go" : "in progress"}
                />
              </div>
              <ol>
                {quickStartItems.map((item, index) => (
                  <li
                    key={item.label}
                    className={item.done ? "done" : "current"}
                  >
                    <span>{item.done ? "OK" : index + 1}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {tokens.length > 0 &&
              !smokeResult?.ok &&
              graphCounts.events === 0 ? (
                <button type="button" onClick={() => void runSmokeTest()}>
                  Verify local memory
                </button>
              ) : null}
            </section>

            <section className="surface action-panel">
              {!user ? (
                <>
                  <h2>
                    {setup?.configured ? "Sign in" : "Create local admin"}
                  </h2>
                  <p>
                    This account exists only in the self-hosted Postgres
                    database.
                  </p>
                  <form onSubmit={(event) => void submitAuth(event)}>
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
                    <button>
                      {setup?.configured ? "Sign in" : "Create admin"}
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <h2>Token setup</h2>
                  {tokens.length === 0 ? (
                    <>
                      <p>
                        Create a token for Codex recall and automatic capture.
                      </p>
                      <form
                        className="inline-form"
                        onSubmit={(event) => void createToken(event)}
                      >
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
                        Token setup is complete. Use the same token for the MCP
                        Server and Capture Hook below.
                      </p>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="surface">
              <h2>MCP Server</h2>
              <p>
                Recall path for Codex. MCP alone does not capture full
                conversations automatically.
              </p>
              <div className="field-grid">
                <FieldCopy label="Name" value="koed-selfhost" />
                <FieldCopy label="Transport" value="STDIO" />
                <FieldCopy label="Command" value={nodeCommand} />
                <FieldCopy label="Argument" value={mcpArg} />
                <FieldCopy label="MEMORY_API_URL" value={apiBaseUrl} />
                <FieldCopy
                  label="MEMORY_API_TOKEN"
                  value={tokenForSetup}
                  masked={newToken === null}
                />
                <FieldCopy
                  label="MEMORY_CODEX_APP_SERVER_BINARY"
                  value="codex"
                />
                <FieldCopy
                  label="MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS"
                  value="48000"
                />
                <FieldCopy
                  label="Working directory"
                  value={repoPath || "/path/to/koed-self-hosted"}
                />
              </div>
            </section>

            <section className="surface">
              <h2>Capture Hook</h2>
              <p>
                Supported automatic capture path for Codex. Configure this
                alongside MCP using the same token.
              </p>
              <p>
                Codex may ask you to review or trust changed hooks after editing
                config.toml; approve only entries pointing at this checkout or
                the installed Koed package.
              </p>
              <div className="field-grid">
                <FieldCopy label="Hook command" value={nodeCommand} />
                <FieldCopy label="Hook argument" value={captureHookArg} />
                <FieldCopy label="MEMORY_API_URL" value={apiBaseUrl} />
                <FieldCopy
                  label="MEMORY_API_TOKEN"
                  value={tokenForSetup}
                  masked={newToken === null}
                />
                <FieldCopy label="MEMORY_HOOK_STRICT" value="false" />
                <FieldCopy label="MEMORY_RAW_INGEST_BATCH_ITEMS" value="10" />
                <FieldCopy
                  label="MEMORY_HOOK_TRIGGER_LCM_SUMMARY"
                  value="true"
                />
                <FieldCopy
                  label="MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS"
                  value="48000"
                />
              </div>
            </section>

            <section className="surface">
              <h2>Service status</h2>
              <div className="status-list">
                {components
                  ? Object.entries(components).map(([name, component]) => (
                      <div key={name}>
                        <span>{name}</span>
                        <StatusDot
                          status={displayString(
                            component.status ??
                              component.healthy ??
                              component.enabled ??
                              "configured",
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
                {runtimeItems.map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <strong>{displayRuntimeValue(value)}</strong>
                  </div>
                ))}
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
                <FieldCopy label="MEMORY_API_URL" value={apiBaseUrl} />
                <FieldCopy
                  label="MEMORY_API_TOKEN"
                  value={tokenForSetup}
                  masked={newToken === null}
                />
                <FieldCopy
                  label="MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS"
                  value="48000"
                />
                <FieldCopy
                  label="Working directory"
                  value={repoPath || "/path/to/koed-self-hosted"}
                />
              </div>
            </section>
            <section className="surface">
              <h2>Other clients</h2>
              <p>
                Claude, Gemini, Cursor, Pi, and other clients will need their
                own setup surfaces. This console should keep each guide explicit
                instead of pretending every client can be automated the same
                way.
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
            <section className="surface wide memory-overview">
              <div className="section-title-row">
                <div>
                  <h2>Usage overview</h2>
                  <p>
                    A high-level view of local ingestion, summarisation, and
                    retained memory.
                  </p>
                </div>
                <StatusDot status={captureStatus} />
              </div>
              <div className="metric-row expanded">
                <div>
                  <span>Captured events</span>
                  <strong>{graphCounts.events}</strong>
                </div>
                <div>
                  <span>Memory nodes</span>
                  <strong>{graphCounts.nodes}</strong>
                </div>
                <div>
                  <span>Leaf memories</span>
                  <strong>{graphCounts.leafNodes}</strong>
                </div>
                <div>
                  <span>Rollups</span>
                  <strong>{graphCounts.rollups}</strong>
                </div>
                <div>
                  <span>Pending summaries</span>
                  <strong>{graphCounts.pending}</strong>
                </div>
                <div>
                  <span>Deleted</span>
                  <strong>{graphCounts.deleted}</strong>
                </div>
              </div>
            </section>

            <section className="surface">
              <h2>Ingestion health</h2>
              <div className="status-list">
                <div>
                  <span>Capture policy</span>
                  <StatusDot status={captureStatus} />
                </div>
                <div>
                  <span>API tokens</span>
                  <strong>{tokens.length}</strong>
                </div>
                <div>
                  <span>Capture policies</span>
                  <strong>{policies.length}</strong>
                </div>
                <div>
                  <span>Verification</span>
                  <StatusDot
                    status={
                      smokeResult?.ok || graphCounts.events > 0
                        ? "verified"
                        : "pending"
                    }
                  />
                </div>
              </div>
              {smokeResult ? (
                <div className="result-box">
                  <StatusDot status={smokeResult.ok ? "verified" : "failed"} />
                  <p>{smokeResult.content}</p>
                  <small>{smokeResult.marker}</small>
                </div>
              ) : (
                <p className="empty">
                  Run the smoke test to create the first memory.
                </p>
              )}
            </section>
            <section className="surface">
              <h2>Capture control</h2>
              <p>
                Hooks check this policy before storing conversation events.
                Disable or pause capture here to stop automatic ingestion
                without editing Codex config. Ask currently blocks automatic
                capture until an AI-client approval flow exists.
              </p>
              <div className="segmented">
                {["enabled", "ask", "disabled"].map((state) => (
                  <button
                    key={state}
                    type="button"
                    className={
                      policies.some((policy) => policy.captureState === state)
                        ? ""
                        : "secondary"
                    }
                    onClick={() => void saveGlobalPolicy(state)}
                  >
                    {state === "ask" ? "ask (blocks)" : state}
                  </button>
                ))}
              </div>
              <ul className="plain-list">
                {policies.map((policy) => (
                  <li key={policy.id}>
                    {policy.targetType}: {policy.captureState ?? "inherit"} /{" "}
                    {policy.visibility ?? "inherit"}
                  </li>
                ))}
              </ul>
            </section>
            <section className="surface wide">
              <h2>Recent memory records</h2>
              <p>
                Load recent records only when you need to audit or invalidate
                captured data.
              </p>
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

        {activeSection === "security" ? (
          <div className="section-grid">
            <section className="surface">
              <h2>API tokens</h2>
              <form
                className="inline-form"
                onSubmit={(event) => void createToken(event)}
              >
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
