import {
  FIXTURE_VERSION,
  fixtureTeam,
  fixtureMemoryRows,
  fixtureUsers,
  fixtureWorkspaces,
  validateFixture
} from "./team-saas-fixture-lib.mjs";

export const launchValidationGates = [
  {
    id: "auth-fixture-sessions",
    area: "Auth",
    mode: "automated",
    description:
      "Synthetic users can authenticate through deterministic fixture sessions when API_TOKEN_PEPPER is configured.",
    launchCriterion: "User signs up or signs in."
  },
  {
    id: "team-workspace-data-shape",
    area: "Team and Workspace",
    mode: "automated",
    description:
      "The fixture contains one Team, three Workspaces, accepted memberships, and Workspace access grants.",
    launchCriterion: "User creates or joins a Team and Workspace."
  },
  {
    id: "shared-session-recall",
    area: "Recall",
    mode: "automated",
    description:
      "Authorized Workspace members can see shared personal memories and hook message rows.",
    launchCriterion:
      "Captured Session is shared to a Workspace and recalled by another authorized member."
  },
  {
    id: "revoked-private-access",
    area: "Access control",
    mode: "automated",
    description:
      "Revoked shares and private memories are excluded from Team-visible recall paths.",
    launchCriterion: "Unauthorized user cannot access hidden memory."
  },
  {
    id: "removed-member-retention",
    area: "Retention",
    mode: "automated",
    description:
      "A removed Workspace member loses access while their previously shared Team knowledge remains visible to authorized members.",
    launchCriterion:
      "Member removal stops access but retained Team knowledge remains."
  },
  {
    id: "personal-deletion-retention",
    area: "Retention",
    mode: "automated",
    description:
      "Personal soft-deletion does not remove retained Team knowledge from authorized Workspace recall.",
    launchCriterion: "Personal deletion and Team-retained recall."
  },
  {
    id: "team-route-auth-boundaries",
    area: "Remote Team routing",
    mode: "automated",
    description:
      "Team Workspace recall, graph, source expansion, and evidence routes require browser sessions or scoped device credentials; API Tokens remain personal-memory only.",
    launchCriterion:
      "Remote Team recall respects session, device, and API-token route contracts."
  },
  {
    id: "local-edge-fail-closed",
    area: "Remote Team routing",
    mode: "automated",
    description:
      "Local-edge upstream operations fail closed for stale credentials, stale capabilities, disabled route policy, and disabled/private/paused Capture Policy.",
    launchCriterion:
      "Local edge cannot reconfigure MCP/Capture Hooks or write upstream capture without current policy, capabilities, and device authorization."
  },
  {
    id: "candidate-evidence-boundaries",
    area: "Access control",
    mode: "automated",
    description:
      "Unauthorized memory is excluded during candidate selection, graph source expansion, and Evidence Bundle construction before any decrypt, rerank, or display step.",
    launchCriterion:
      "Revoked Workspace Access, revoked Share Grants, and private memory are absent from final results and provenance."
  },
  {
    id: "encrypted-fixture-boundaries",
    area: "Encryption",
    mode: "automated",
    description:
      "Encrypted Team fixture cases prove shared, private, revoked, removed-member, suspended-entitlement, queue, audit, and embedding-source boundaries before decrypt or diagnostics exposure.",
    launchCriterion:
      "Encrypted Memory is decrypted only after authorization, and raw Memory is absent from storage companions, queues, audit metadata, request logs, and diagnostics."
  },
  {
    id: "workos-user-mapping-boundary",
    area: "Auth",
    mode: "automated",
    description:
      "WorkOS/AuthKit is only an identity provider; mapped Koed Users still pass normal Team membership, Workspace Access, Share Grant, and entitlement authorization.",
    launchCriterion: "External identity cannot bypass Koed Team authorization."
  },
  {
    id: "capability-diagnostics-redaction",
    area: "Operations",
    mode: "automated",
    description:
      "Capability discovery, hook environment, route diagnostics, request logs, and status endpoints redact secrets, raw Memory, and local-only paths.",
    launchCriterion:
      "Capability discovery and diagnostics are useful without leaking sensitive data."
  },
  {
    id: "electron-cloud-connection",
    area: "Electron",
    mode: "manual",
    description:
      "Run Electron against the target backend, confirm capability discovery, connection status, and account context.",
    launchCriterion: "Electron app connects to cloud backend."
  },
  {
    id: "guided-client-setup",
    area: "Electron",
    mode: "manual",
    description:
      "Walk through MCP Server and Supported Capture Hook setup from the app and confirm Codex can call memory_answer.",
    launchCriterion:
      "MCP and Supported Capture Hook setup are guided from the app."
  },
  {
    id: "capture-to-recall-flow",
    area: "End-to-end",
    mode: "manual",
    description:
      "Capture a real session, share it to a Workspace, recall it from another member, and inspect evidence in the UI.",
    launchCriterion: "User captures, shares, recalls, and inspects a session."
  },
  {
    id: "billing-seat-state",
    area: "Billing",
    mode: "staging",
    description:
      "Exercise paid, grace, plan-limited, and blocked states against the staging billing provider or stub.",
    launchCriterion: "Billing/seat state updates appropriately."
  },
  {
    id: "audit-observability",
    area: "Operations",
    mode: "staging",
    description:
      "Verify audit events, health checks, error logs, and alerting for the critical launch path.",
    launchCriterion: "Audit log and observability show health and errors."
  },
  {
    id: "backup-restore-smoke",
    area: "Operations",
    mode: "staging",
    description:
      "Create a hosted backup, verify the archive, restore-smoke it into a clean target database, and confirm /ops/status reports fresh backup status.",
    launchCriterion: "Backups are fresh, verified, and restorable."
  },
  {
    id: "capacity-load-test",
    area: "Operations",
    mode: "staging",
    description:
      "Run the hosted capacity harness against the target deployment and review API latency, error rate, queue pressure, embedding progress, database growth, and storage growth.",
    launchCriterion:
      "Hosted backend capacity has been measured against the first 1,000 paid-customer assumptions."
  }
];

export const automatedLaunchTestCommands = [
  {
    id: "api-auth-runtime-boundaries",
    command: "pnpm",
    args: [
      "--filter",
      "@koed/api",
      "test",
      "--",
      "src/server.test.ts",
      "src/server/logging.test.ts",
      "src/server/route-identity.test.ts",
      "-t",
      "WorkOS|AuthKit|capabilities|support overview|activation analytics|billing seats|entitlement|redact|route identity|device|local-edge|ops|backup|export|return targets"
    ]
  },
  {
    id: "db-encrypted-tenant-boundaries",
    command: "pnpm",
    args: [
      "--filter",
      "@koed/db",
      "test",
      "--",
      "tests/repository.test.ts",
      "-t",
      "encrypted|support overview|activation analytics|billing seats|Cross-Identity Sync|device credentials|Captured Session Share Grants|Team fixture boundaries|managed-cloud|plaintext lexical"
    ]
  },
  {
    id: "hosted-ops-boundaries",
    command: "node",
    args: [
      "--test",
      "scripts/hosted-backup-lib.test.mjs",
      "scripts/hosted-db-roles-lib.test.mjs",
      "scripts/hosted-capacity-lib.test.mjs",
      "scripts/team-saas-launch-validation-lib.test.mjs"
    ]
  }
];

const modeOrder = ["automated", "manual", "staging"];

export const assertLaunchValidationEnvironment = (env = process.env) => {
  if (!env.API_TOKEN_PEPPER?.trim()) {
    throw new Error(
      "API_TOKEN_PEPPER is required for Team SaaS launch validation because the Auth gate depends on deterministic fixture sessions."
    );
  }
};

const fixtureDefaultNode = fixtureMemoryRows.find(
  (memory) => memory.workspace === "electron" && memory.expectedTeamVisible
);

export const defaultStagedRemoteOptions = (env = process.env) => ({
  baseUrl: env.KOED_LAUNCH_BASE_URL || env.MEMORY_API_URL || "",
  sessionCookie: env.KOED_LAUNCH_SESSION_COOKIE || "",
  deviceCredential: env.KOED_LAUNCH_DEVICE_CREDENTIAL || "",
  apiToken: env.KOED_LAUNCH_API_TOKEN || "",
  teamWorkspaceId:
    env.KOED_LAUNCH_TEAM_WORKSPACE_ID || fixtureWorkspaces.electron.id,
  teamNodeId: env.KOED_LAUNCH_TEAM_NODE_ID || fixtureDefaultNode?.nodeId || "",
  localEdgeBaseUrl: env.KOED_LAUNCH_LOCAL_EDGE_BASE_URL || "",
  localEdgeBackendId: env.KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID || ""
});

const normalizeBaseUrl = (value) => {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
};

const normalizeDeviceAuthorization = (value) => {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("koed-device ")
    ? trimmed
    : `Koed-Device ${trimmed}`;
};

const readResponseJson = async (response) => {
  const text = await response.text().catch(() => "");
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const stagedProbe = async ({
  fetcher,
  baseUrl,
  name,
  method = "GET",
  path,
  headers = {},
  body,
  expect = "ok",
  redactionSentinels = []
}) => {
  const response = await fetcher(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const json = await readResponseJson(response);
  const ok =
    expect === "ok"
      ? response.ok
      : Array.isArray(expect)
        ? expect.includes(response.status)
        : response.status === expect;
  if (!ok) {
    throw new Error(
      `${name} returned HTTP ${response.status}; expected ${Array.isArray(expect) ? expect.join("/") : expect}`
    );
  }
  const serialized =
    typeof json === "string" ? json : JSON.stringify(json ?? null);
  for (const sentinel of redactionSentinels.filter(Boolean)) {
    if (serialized.includes(sentinel)) {
      throw new Error(`${name} response leaked staged credential sentinel.`);
    }
  }
  return {
    name,
    status: response.status,
    ok: true,
    json
  };
};

export const runStagedRemoteValidation = async (input, fetcher = fetch) => {
  const options = {
    ...defaultStagedRemoteOptions({}),
    ...input
  };
  const missing = [];
  if (!options.baseUrl?.trim()) {
    missing.push("--base-url or KOED_LAUNCH_BASE_URL");
  }
  if (!options.sessionCookie?.trim()) {
    missing.push("--session-cookie or KOED_LAUNCH_SESSION_COOKIE");
  }
  if (!options.deviceCredential?.trim()) {
    missing.push("--device-credential or KOED_LAUNCH_DEVICE_CREDENTIAL");
  }
  if (!options.teamWorkspaceId?.trim()) {
    missing.push("--team-workspace-id or KOED_LAUNCH_TEAM_WORKSPACE_ID");
  }
  if (missing.length) {
    throw new Error(`Staged remote validation requires ${missing.join(", ")}.`);
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const localEdgeBaseUrl = options.localEdgeBaseUrl?.trim()
    ? normalizeBaseUrl(options.localEdgeBaseUrl)
    : "";
  const deviceAuthorization = normalizeDeviceAuthorization(
    options.deviceCredential
  );
  const credentialSentinels = [
    options.sessionCookie,
    options.deviceCredential,
    deviceAuthorization,
    options.apiToken
  ];
  const answerBody = {
    query: "Workspace Memory Timeline UX",
    retrieval_scope: "personal",
    retrieval_stage: "score_scan",
    strict_limit: true,
    limit: 3,
    team_workspace_id: options.teamWorkspaceId
  };
  const results = [];

  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "public-capabilities",
      path: "/v1/capabilities",
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-authenticated-capabilities",
      path: "/v1/capabilities/authenticated",
      headers: { cookie: options.sessionCookie },
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-team-answer",
      method: "POST",
      path: "/v1/memory/answer",
      headers: { cookie: options.sessionCookie },
      body: answerBody,
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-team-answer",
      method: "POST",
      path: "/v1/memory/answer",
      headers: { authorization: deviceAuthorization },
      body: answerBody,
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-team-search",
      method: "POST",
      path: "/v1/memory/search",
      headers: { authorization: deviceAuthorization },
      body: answerBody,
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-team-graph-nodes",
      path: `/v1/memory/graph/nodes?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: { cookie: options.sessionCookie },
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-team-graph-events",
      path: `/v1/memory/graph/events?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: { cookie: options.sessionCookie },
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-team-graph-nodes",
      path: `/v1/memory/graph/nodes?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: { authorization: deviceAuthorization },
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-team-graph-events",
      path: `/v1/memory/graph/events?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: { authorization: deviceAuthorization },
      redactionSentinels: credentialSentinels
    })
  );

  if (options.teamNodeId?.trim()) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "device-team-node-detail",
        path: `/v1/memory/graph/nodes/${encodeURIComponent(options.teamNodeId)}?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { authorization: deviceAuthorization },
        expect: [200, 404],
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "session-team-node-detail",
        path: `/v1/memory/graph/nodes/${encodeURIComponent(options.teamNodeId)}?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { cookie: options.sessionCookie },
        expect: [200, 404],
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "device-team-node-expand",
        path: `/v1/memory/nodes/${encodeURIComponent(options.teamNodeId)}/expand?team_workspace_id=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { authorization: deviceAuthorization },
        expect: [200, 404],
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "session-team-node-expand",
        path: `/v1/memory/nodes/${encodeURIComponent(options.teamNodeId)}/expand?team_workspace_id=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { cookie: options.sessionCookie },
        expect: [200, 404],
        redactionSentinels: credentialSentinels
      })
    );
  }

  if (options.apiToken?.trim()) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "api-token-team-answer-rejected",
        method: "POST",
        path: "/v1/memory/answer",
        headers: { authorization: `Bearer ${options.apiToken}` },
        body: answerBody,
        expect: [401, 403],
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "api-token-team-graph-rejected",
        path: `/v1/memory/graph/events?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { authorization: `Bearer ${options.apiToken}` },
        expect: [401, 403],
        redactionSentinels: credentialSentinels
      })
    );
  }

  if (localEdgeBaseUrl && options.localEdgeBackendId?.trim()) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl: localEdgeBaseUrl,
        name: "local-edge-team-answer-proxy",
        method: "POST",
        path: "/v1/local-edge/upstream-operations",
        headers: { authorization: deviceAuthorization },
        body: {
          operation_family: "team_workspace_read",
          upstream_backend_id: options.localEdgeBackendId,
          requested_mode: "live_upstream_proxy",
          method: "POST",
          path: "/v1/memory/answer",
          body: answerBody
        },
        redactionSentinels: credentialSentinels
      })
    );
  } else {
    results.push({
      name: "local-edge-team-answer-proxy",
      status: "skipped",
      ok: true,
      reason:
        "Set KOED_LAUNCH_LOCAL_EDGE_BASE_URL and KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID to probe local-edge proxying."
    });
  }

  return {
    baseUrl,
    localEdgeBaseUrl: localEdgeBaseUrl || null,
    teamWorkspaceId: options.teamWorkspaceId,
    probes: results
  };
};

export const summarizeLaunchValidation = (
  fixtureResult,
  options = { automatedTestStatus: "not_run" }
) => {
  const byMode = Object.fromEntries(modeOrder.map((mode) => [mode, 0]));
  for (const gate of launchValidationGates) {
    byMode[gate.mode] += 1;
  }

  return {
    fixture: FIXTURE_VERSION,
    team: fixtureTeam.name,
    users: Object.keys(fixtureUsers).length,
    workspaces: Object.keys(fixtureWorkspaces).length,
    memories: fixtureResult.memories,
    gates: launchValidationGates.length,
    byMode,
    automatedChecks: fixtureResult.checks,
    automatedTestStatus: options.automatedTestStatus ?? "not_run",
    stagedRemote: options.stagedRemote ?? null,
    automatedTestCommands: automatedLaunchTestCommands.map((item) => ({
      id: item.id,
      command: [item.command, ...item.args].join(" ")
    }))
  };
};

export const validateLaunchReadiness = async (client, options) => {
  const fixtureResult = await validateFixture(client);
  return summarizeLaunchValidation(fixtureResult, options);
};

export const formatLaunchValidationReport = (summary) => {
  const lines = [
    `Team SaaS launch validation report (${summary.fixture})`,
    "",
    `Fixture: ${summary.users} users, ${summary.workspaces} Workspaces, ${summary.memories} memories`,
    `Gates: ${summary.gates} total, ${summary.byMode.automated} automated, ${summary.byMode.manual} manual, ${summary.byMode.staging} staging`,
    "",
    "Automated fixture checks:"
  ];

  for (const check of summary.automatedChecks) {
    lines.push(`- ${check}`);
  }

  lines.push(
    "",
    `Automated repository test gates: ${summary.automatedTestStatus}`
  );
  for (const command of summary.automatedTestCommands) {
    lines.push(`- [${command.id}] ${command.command}`);
  }

  if (summary.stagedRemote) {
    lines.push(
      "",
      `Staged remote HTTP probes: ${summary.stagedRemote.baseUrl}`,
      `Team Workspace: ${summary.stagedRemote.teamWorkspaceId}`
    );
    for (const probe of summary.stagedRemote.probes) {
      lines.push(`- ${probe.name}: ${probe.status}`);
      if (probe.reason) {
        lines.push(`  ${probe.reason}`);
      }
    }
  }

  for (const mode of modeOrder) {
    lines.push("", `${mode[0].toUpperCase()}${mode.slice(1)} launch gates:`);
    for (const gate of launchValidationGates.filter(
      (candidate) => candidate.mode === mode
    )) {
      lines.push(`- [${gate.area}] ${gate.description}`);
      lines.push(`  Criterion: ${gate.launchCriterion}`);
    }
  }

  lines.push(
    "",
    "Any failed launch blocker should be linked to a Linear ticket before release."
  );

  return `${lines.join("\n")}\n`;
};
