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

type CodexSetup = {
  localRepositoryPath: string | null;
};

type CodexSetupMode = "manual" | "configToml";

type EnvVarStatus = "required" | "optional" | "defaulted";

type EnvVarItem = {
  key: string;
  value: string;
  status: EnvVarStatus;
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

const copyText = async (value: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall back for non-secure contexts like custom local hosts.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
};

const CopyButton = ({
  value,
  className = "ghost"
}: {
  value: string;
  className?: string;
}) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`${className} copy-feedback-button ${copied ? "copied" : ""}`}
      onClick={() => {
        void copyText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1000);
      }}
      aria-label={copied ? "Copied" : "Copy"}
    >
      <span className="copy-feedback-label">Copy</span>
      <span className="copy-feedback-tick" aria-hidden="true">
        ✅
      </span>
    </button>
  );
};

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
    <CopyButton value={value} className="ghost" />
  </div>
);

const EnvVarGroup = ({
  items,
  maskedKeys = []
}: {
  items: ReadonlyArray<EnvVarItem>;
  maskedKeys?: string[];
}) => (
  <div className="env-var-group">
    <div className="env-var-header">
      <strong>Environment Variables</strong>
    </div>
    <div className="env-var-list">
      {items.map(({ key, value, status }) => {
        const masked = maskedKeys.includes(key);
        const displayValue = masked
          ? value.replace(/^(.{8}).+(.{4})$/, "$1...$2")
          : value;
        return (
          <div key={key} className="env-var-row">
            <div className="env-var-pair">
              <div>
                <span>
                  Name <span className={`env-var-badge ${status}`}>{status === "required" ? "Required" : status === "defaulted" ? "Defaulted" : "Optional"}</span>
                </span>
                <div className="inline-copy-value">
                  <code>{key}</code>
                  <CopyButton value={key} className="ghost mini-copy" />
                </div>
              </div>
              <div>
                <span>Value</span>
                <div className="inline-copy-value">
                  <code>{displayValue}</code>
                  <CopyButton value={value} className="ghost mini-copy" />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const ManualConfigValueSection = ({
  title,
  value
}: {
  title: string;
  value: string;
}) => (
  <div className="env-var-group">
    <div className="env-var-header">
      <strong>{title}</strong>
    </div>
    <div className="value-copy-row">
      <code>{value}</code>
      <CopyButton value={value} className="ghost mini-copy" />
    </div>
  </div>
);

const EmptyConfigSection = ({
  title,
  tone = "subtle"
}: {
  title: string;
  tone?: "subtle" | "neutral";
}) => (
  <div className={`env-var-group ${tone === "neutral" ? "neutral-note" : ""}`}>
    <div className="env-var-header">
      <strong>{title}</strong>
    </div>
    <p className="empty-config-copy">None</p>
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

const JsonBlock = ({
  value,
  title
}: {
  value: unknown;
  title?: string;
}) => (
  <div className="code-card">
    <div className="code-card-header">
      <strong>{title ?? "Configuration block"}</strong>
      <CopyButton
        value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
        className="secondary"
      />
    </div>
    <div className="code-box">
      <pre>
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  </div>
);

const codexHookEvents = [
  ["SessionStart", 10],
  ["UserPromptSubmit", 10],
  ["PostToolUse", 10],
  ["Stop", 30],
  ["SubagentStart", 10],
  ["SubagentStop", 30]
] as const;

const escapeToml = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const escapeShellDoubleQuoted = (value: string): string =>
  value.replace(/([\\"$`])/g, "\\$1");

const shellDoubleQuoted = (value: string): string =>
  `"${escapeShellDoubleQuoted(value)}"`;

const buildHookEnvAssignments = ({
  apiUrl,
  token
}: {
  apiUrl: string;
  token: string;
}): string[] => [
  `MEMORY_API_URL=${shellDoubleQuoted(apiUrl)}`,
  `MEMORY_API_TOKEN=${shellDoubleQuoted(token)}`,
  'MEMORY_CODEX_APP_SERVER_BINARY="codex"',
  'MEMORY_HOOK_STRICT="false"',
  'MEMORY_HOOK_TRIGGER_LCM_SUMMARY="true"',
  'MEMORY_HOOK_LCM_SUMMARY_DELAY_MS="10000"',
  'MEMORY_HOOK_LCM_SUMMARY_LIMIT="2"',
  'MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS="48000"'
];

const buildCodexHookCommand = ({
  apiUrl,
  token,
  nodeCommand,
  captureHookArg
}: {
  apiUrl: string;
  token: string;
  nodeCommand: string;
  captureHookArg: string;
}): string =>
  `env ${buildHookEnvAssignments({ apiUrl, token }).join(" ")} ${shellDoubleQuoted(nodeCommand)} ${shellDoubleQuoted(captureHookArg)}`;

const buildCodexHookTomlBlock = ({
  apiUrl,
  token,
  nodeCommand,
  captureHookArg
}: {
  apiUrl: string;
  token: string;
  nodeCommand: string;
  captureHookArg: string;
}): string => {
  const hookCommand = buildCodexHookCommand({
    apiUrl,
    token,
    nodeCommand,
    captureHookArg
  });

  return codexHookEvents
    .map(
      ([eventName, timeout]) => `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = "${escapeToml(hookCommand)}"
timeout = ${timeout}`
    )
    .join("\n\n");
};

const buildCodexTomlBlock = ({
  apiUrl,
  token,
  nodeCommand,
  mcpArg,
  captureHookArg
}: {
  apiUrl: string;
  token: string;
  nodeCommand: string;
  mcpArg: string;
  captureHookArg: string;
}): string => {
  const hookBlocks = buildCodexHookTomlBlock({
    apiUrl,
    token,
    nodeCommand,
    captureHookArg
  });

  return `# Replace any existing [mcp_servers.koed-selfhost] block before pasting again.
# >>> koed-self-hosted
[mcp_servers.koed-selfhost]
command = "${escapeToml(nodeCommand)}"
args = ["${escapeToml(mcpArg)}"]
enabled = true

[mcp_servers.koed-selfhost.env]
MEMORY_API_URL = "${escapeToml(apiUrl)}"
MEMORY_API_TOKEN = "${escapeToml(token)}"
MEMORY_CODEX_APP_SERVER_BINARY = "codex"
MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS = "48000"

${hookBlocks}
# <<< koed-self-hosted`;
};

const defaultMemoryApiUrl = "http://localhost:3000";

const codexMcpEnvItems = (apiUrl: string, token: string): ReadonlyArray<EnvVarItem> => [
  {
    key: "MEMORY_API_URL",
    value: apiUrl,
    status: apiUrl === defaultMemoryApiUrl ? "defaulted" : "required"
  },
  { key: "MEMORY_API_TOKEN", value: token, status: "required" },
  {
    key: "MEMORY_CODEX_APP_SERVER_BINARY",
    value: "codex",
    status: "defaulted"
  },
  {
    key: "MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS",
    value: "48000",
    status: "optional"
  }
];

const CodexSetupModeToggle = ({
  mode,
  setMode
}: {
  mode: CodexSetupMode;
  setMode: (mode: CodexSetupMode) => void;
}) => (
  <div className="pill-row" role="tablist" aria-label="Codex setup mode">
    <button
      type="button"
      className={mode === "configToml" ? "active" : "ghost"}
      onClick={() => setMode("configToml")}
    >
      Edit config
    </button>
    <button
      type="button"
      className={mode === "manual" ? "active" : "ghost"}
      onClick={() => setMode("manual")}
    >
      Manual entry
    </button>
  </div>
);

type AuthMode = "login" | "signup";

type AuthGateProps = {
  setup: SetupStatus | null;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  onSubmit: (mode: AuthMode, event: FormEvent) => void;
  error: string | null;
  clearError: () => void;
};

const AuthGate = ({
  setup,
  email,
  setEmail,
  password,
  setPassword,
  onSubmit,
  error,
  clearError
}: AuthGateProps) => {
  const configured = Boolean(setup?.configured);
  const [mode, setMode] = useState<AuthMode>(configured ? "login" : "signup");

  useEffect(() => {
    setMode(configured ? "login" : "signup");
  }, [configured]);

  const switchMode = (next: AuthMode) => {
    if (next === mode) return;
    clearError();
    setPassword("");
    setMode(next);
  };

  const isSignup = mode === "signup";
  const heading = !configured
    ? "Create local admin"
    : isSignup
      ? "Sign Up"
      : "Log In";
  const subheading = !configured
    ? "Set the first account for this local Koed service."
    : isSignup
      ? "Create another account on this local Koed service."
      : "Welcome back. Sign in to the operator console.";
  const buttonLabel = !configured
    ? "Create admin"
    : isSignup
      ? "Create account"
      : "Log in";

  return (
    <main className="auth-gate">
      <div className="auth-gate-inner">
        <img
          src="/koed-logo.svg"
          alt="Koed"
          className="auth-gate-logo"
          width={152}
          height={48}
        />
        <section className="auth-card" aria-labelledby="auth-card-title">
          {configured ? (
            <div
              className="auth-tabs"
              role="tablist"
              aria-label="Authentication mode"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "login"}
                className={mode === "login" ? "active" : ""}
                onClick={() => switchMode("login")}
              >
                Log In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signup"}
                className={mode === "signup" ? "active" : ""}
                onClick={() => switchMode("signup")}
              >
                Sign Up
              </button>
            </div>
          ) : null}

          <div className="auth-card-header">
            <h1 id="auth-card-title">{heading}</h1>
            <p>{subheading}</p>
          </div>

          <form onSubmit={(event) => onSubmit(mode, event)}>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email address"
              aria-label="Email address"
              autoComplete="email"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              aria-label="Password"
              autoComplete={isSignup ? "new-password" : "current-password"}
              required
            />
            <button type="submit">{buttonLabel}</button>
          </form>

          {!configured || isSignup ? (
            <p className="auth-card-footnote">
              {!configured
                ? "This account will have full control over the local service instance."
                : "New accounts can only be created when public registration is enabled on this instance."}
            </p>
          ) : null}

          {error ? (
            <div className="alert auth-card-alert" role="alert">
              {error}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
};

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
  const [codexSetupMode, setCodexSetupMode] =
    useState<CodexSetupMode>("configToml");
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
    const [me, graph, apiTokens, capturePolicies, codexSetup] =
      await Promise.all([
        requestJson<{ user: User }>("/me"),
        requestJson<{ overview: Record<string, unknown> }>(
          "/v1/memory/graph/overview"
        ),
        requestJson<{ apiTokens: ApiToken[] }>("/api-tokens"),
        requestJson<{ policies: CapturePolicy[] }>("/v1/capture-policies"),
        requestJson<CodexSetup>("/self-host/codex-setup")
      ]);
    setUser(me.user);
    setOverview(graph.overview);
    setTokens(apiTokens.apiTokens);
    setPolicies(capturePolicies.policies);
    if (!repoPath && codexSetup.localRepositoryPath) {
      setCheckoutPath(codexSetup.localRepositoryPath);
    }
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

  const submitAuth = async (mode: AuthMode, event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const endpoint = !setup?.configured
      ? "/auth/setup"
      : mode === "signup"
        ? "/auth/register"
        : "/auth/login";
    try {
      await requestJson(endpoint, {
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

  const tokenForSetup = "<api_token>";
  const mcpArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/cli.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/cli.js";
  const captureHookArg = repoPath
    ? `${repoPath.replace(/\/$/, "")}/packages/mcp-server/dist/capture-hook.js`
    : "/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js";
  const codexTomlBlock = buildCodexTomlBlock({
    apiUrl: apiBaseUrl,
    token: tokenForSetup,
    nodeCommand,
    mcpArg,
    captureHookArg
  });
  const codexHookTomlBlock = buildCodexHookTomlBlock({
    apiUrl: apiBaseUrl,
    token: tokenForSetup,
    nodeCommand,
    captureHookArg
  });
  const mcpEnvItems = codexMcpEnvItems(apiBaseUrl, tokenForSetup);
  const memoryVerified = Boolean(smokeResult?.ok || graphCounts.events > 0);
  const setupComplete =
    Boolean(user) &&
    tokens.length > 0 &&
    Boolean(configuration?.embeddingModel) &&
    memoryVerified;

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
      detail: memoryVerified
        ? "Koed has captured local memory."
        : "Verify capture once the token exists.",
      done: memoryVerified
    }
  ];

  if (!user) {
    return (
      <AuthGate
        setup={setup}
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        onSubmit={(mode, event) => void submitAuth(mode, event)}
        error={error}
        clearError={() => setError(null)}
      />
    );
  }

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
            <button type="button" onClick={() => void copyText(newToken)}>
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
            </section>

            <section className="surface wide">
              <div className="section-title-row codex-setup-header">
                <div>
                  <h2>Codex setup</h2>
                </div>
                <CodexSetupModeToggle
                  mode={codexSetupMode}
                  setMode={setCodexSetupMode}
                />
              </div>

              {codexSetupMode === "manual" ? (
                <div className="codex-setup-stack">
                  <div className="codex-callout">
                    <div>
                      <strong>Manual entry in Codex</strong>
                      <p>
                        Open Codex settings, click <strong>MCP servers</strong>,
                        then <strong>+ Add server</strong>.
                      </p>
                    </div>
                    <a className="button-link" href="codex://settings">
                      Open Codex settings
                    </a>
                  </div>

                  <div className="manual-config-group">
                    <h3>MCP server</h3>
                    <p>
                      Name server <code>koed-selfhost</code>. MCP alone does not
                      capture full conversations automatically.
                    </p>
                    <div className="field-grid">
                      <ManualConfigValueSection
                        title="Command to launch"
                        value={`${nodeCommand} ${mcpArg}`}
                      />
                      <EmptyConfigSection title="Arguments" />
                      <EnvVarGroup
                        items={mcpEnvItems}
                      />
                      <EmptyConfigSection
                        title="Environment variable passthrough"
                        tone="neutral"
                      />
                      <ManualConfigValueSection
                        title="Working Directory"
                        value={repoPath || "/path/to/koed-self-hosted"}
                      />
                    </div>
                  </div>

                  <div className="manual-config-group">
                    <h3>Capture Hook</h3>
                    <p>
                      Codex does not expose hook editing in the MCP settings
                      UI. Add the Koed hook entries directly in
                      <code> ~/.codex/config.toml</code>.
                    </p>
                    <div className="codex-setup-stack compact-stack">
                      <div className="codex-callout">
                        <div>
                          <strong>Hooks live in config.toml</strong>
                          <p>
                            Open Codex settings, click <strong>Configuration</strong>,
                            then <strong>Open config.toml</strong>.
                          </p>
                        </div>
                        <a className="button-link" href="codex://settings">
                          Open Codex settings
                        </a>
                      </div>
                      <JsonBlock
                        title="~/.codex/config.toml hooks"
                        value={codexHookTomlBlock}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="codex-setup-stack">
                  <div className="codex-callout">
                    <div>
                      <strong>config.toml in Codex</strong>
                      <p>
                        Open Codex settings, click <strong>Configuration</strong>,
                        then <strong>Open config.toml</strong>.
                      </p>
                    </div>
                    <a className="button-link" href="codex://settings">
                      Open Codex settings
                    </a>
                  </div>
                  <JsonBlock title="~/.codex/config.toml" value={codexTomlBlock} />
                  <div className="codex-callout">
                    <div>
                      <strong>Trust hooks in Codex</strong>
                      <p>
                        Open Codex Settings, click <strong>Hooks</strong>, then
                        follow review markers and click <strong>Trust</strong>.
                      </p>
                    </div>
                    <a className="button-link" href="codex://settings">
                      Open Codex settings
                    </a>
                  </div>
                </div>
              )}
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
              <div className="section-title-row codex-setup-header">
                <div>
                  <h2>Codex Desktop</h2>
                </div>
                <CodexSetupModeToggle
                  mode={codexSetupMode}
                  setMode={setCodexSetupMode}
                />
              </div>
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
              {codexSetupMode === "manual" ? (
                <div className="codex-setup-stack">
                  <div className="codex-callout">
                    <div>
                      <strong>Manual entry in Codex</strong>
                      <p>
                        Open Codex settings, click <strong>MCP servers</strong>,
                        then <strong>+ Add server</strong>.
                      </p>
                    </div>
                    <a className="button-link" href="codex://settings">
                      Open Codex settings
                    </a>
                  </div>
                  <div className="manual-config-group">
                    <h3>MCP server</h3>
                    <p>Name server <code>koed-selfhost</code>.</p>
                    <div className="field-grid">
                      <ManualConfigValueSection
                        title="Command to launch"
                        value={`${nodeCommand} ${mcpArg}`}
                      />
                      <EmptyConfigSection title="Arguments" />
                      <EnvVarGroup
                        items={mcpEnvItems}
                      />
                      <EmptyConfigSection
                        title="Environment variable passthrough"
                        tone="neutral"
                      />
                      <ManualConfigValueSection
                        title="Working Directory"
                        value={repoPath || "/path/to/koed-self-hosted"}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="codex-setup-stack">
                  <div className="codex-callout">
                    <div>
                      <strong>config.toml in Codex</strong>
                      <p>
                        Open Codex settings, click <strong>Configuration</strong>,
                        then <strong>Open config.toml</strong>.
                      </p>
                    </div>
                    <a className="button-link" href="codex://settings">
                      Open Codex settings
                    </a>
                  </div>
                  <JsonBlock title="~/.codex/config.toml" value={codexTomlBlock} />
                  <div className="codex-callout">
                    <div>
                      <strong>Trust hooks in Codex</strong>
                      <p>
                        Open Codex Settings, click <strong>Hooks</strong>, then
                        follow review markers and click <strong>Trust</strong>.
                      </p>
                    </div>
                    <a className="button-link" href="codex://settings">
                      Open Codex settings
                    </a>
                  </div>
                </div>
              )}
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
                  <StatusDot status={memoryVerified ? "verified" : "pending"} />
                </div>
              </div>
              {smokeResult ? (
                <div className="result-box">
                  <StatusDot status={memoryVerified ? "verified" : "failed"} />
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
