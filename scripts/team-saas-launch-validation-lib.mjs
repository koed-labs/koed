import {
  FIXTURE_VERSION,
  fixtureTeam,
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

export const summarizeLaunchValidation = (fixtureResult) => {
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
    automatedChecks: fixtureResult.checks
  };
};

export const validateLaunchReadiness = async (client) => {
  const fixtureResult = await validateFixture(client);
  return summarizeLaunchValidation(fixtureResult);
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
