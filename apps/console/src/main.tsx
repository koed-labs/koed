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
  visibility: "personal" | "team" | null;
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
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(
    null
  );
  const [memoryExport, setMemoryExport] = useState<Record<string, unknown> | null>(
    null
  );
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
    nodes: Number(overview?.leafNodes ?? 0) + Number(overview?.rollupNodes ?? 0),
    pending: Number(overview?.pendingSummaries ?? 0),
    deleted: Number(overview?.invalidatedRecords ?? 0)
  };

  const tokenForSetup = newToken ?? "<create a token first>";
  const mcpArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/cli.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/cli.js";
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
    ["security", "Security"]
  ] as const;

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
                    <button>{setup?.configured ? "Sign in" : "Create admin"}</button>
                  </form>
                </>
              ) : (
                <>
                  <h2>Next action</h2>
                  {tokens.length === 0 ? (
                    <>
                      <p>Create a token for Codex or another local AI client.</p>
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
                  label="MEMORY_API_URL"
                  value={apiBaseUrl}
                />
                <FieldCopy
                  label="MEMORY_API_TOKEN"
                  value={tokenForSetup}
                  masked={newToken === null}
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
                    {state}
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
