import assert from "node:assert/strict";
import test from "node:test";
// Node's native TypeScript runner needs the source extension here.
import {
  deriveProjectBrowserView,
  hasExplainableProjectAssociation
  // @ts-expect-error -- Next's app compiler does not enable TS extension imports.
} from "./LocalConversationBrowser.projects.ts";
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { normalizeConversationProvider } from "./LocalConversationBrowser.match.ts";

const projects = [
  { id: "lp_codex", name: "Codex Project" },
  { id: "lp_claude", name: "Claude Project" },
  { id: "lp_managed_claude", name: "Managed Claude Project" },
  { id: "lp_empty", name: "Empty Project" }
];

const managed = [
  {
    id: "claude-managed",
    projectId: "lp_managed_claude",
    provider: "claude",
    state: "running"
  },
  {
    id: "codex-managed",
    projectId: "lp_codex",
    provider: "codex",
    state: "ready"
  },
  {
    id: "stopped-project-history",
    projectId: "lp_claude",
    provider: "claude",
    state: "stopped"
  },
  {
    id: "stopped-projectless-history",
    projectId: null,
    provider: "codex",
    state: "stopped"
  },
  {
    id: "inactive-claude-managed",
    projectId: "lp_claude",
    provider: "claude-code",
    state: "complete"
  }
];

test("provider view shows matching source and managed Projects and managed rows only", () => {
  const view = deriveProjectBrowserView({
    items: [
      {
        provider: "claude-code" as const,
        projectId: "lp_claude",
        projectName: "Claude from catalog"
      },
      {
        provider: "codex" as const,
        projectId: "lp_codex",
        projectName: "Codex from catalog"
      }
    ],
    registeredProjects: projects,
    managedConversations: managed,
    provider: "claude-code",
    normalizeProvider: normalizeConversationProvider
  });

  assert.deepEqual(
    view.projects.map((project) => project.id),
    ["lp_claude", "lp_managed_claude"]
  );
  assert.deepEqual(
    view.projects.map((project) => project.name),
    ["Claude Project", "Managed Claude Project"]
  );
  assert.deepEqual(
    view.activeManagedConversations.map((conversation) => conversation.id),
    ["claude-managed", "stopped-project-history"]
  );
});

test("All clients keeps registered empty Projects and active managed rows for every provider", () => {
  const view = deriveProjectBrowserView({
    items: [],
    registeredProjects: projects,
    managedConversations: managed,
    provider: "all",
    normalizeProvider: normalizeConversationProvider
  });

  assert.deepEqual(
    view.projects.map((project) => project.id),
    projects.map((project) => project.id)
  );
  assert.deepEqual(
    view.activeManagedConversations.map((conversation) => conversation.id),
    [
      "claude-managed",
      "codex-managed",
      "stopped-project-history",
      "stopped-projectless-history"
    ]
  );
});

test("provider aliases normalize runtime driver IDs to sidebar providers", () => {
  assert.equal(normalizeConversationProvider("claude"), "claude-code");
  assert.equal(normalizeConversationProvider("claude-code"), "claude-code");
  assert.equal(normalizeConversationProvider("codex-cli"), "codex");
  assert.equal(normalizeConversationProvider("codex"), "codex");
  assert.equal(normalizeConversationProvider("pi"), "pi");
  assert.equal(normalizeConversationProvider("unknown"), null);
});

test("discovery Projects require a human label unless registered", () => {
  const registered = new Set(["lp_registered"]);
  assert.equal(
    hasExplainableProjectAssociation(
      {
        provider: "codex",
        projectId: "folder-id",
        projectName: "Working folder"
      },
      registered
    ),
    true
  );
  assert.equal(
    hasExplainableProjectAssociation(
      { provider: "codex", projectId: "lp_registered" },
      registered
    ),
    true
  );
  assert.equal(
    hasExplainableProjectAssociation(
      { provider: "codex", projectId: "opaque-folder-id" },
      registered
    ),
    false
  );
  assert.equal(
    hasExplainableProjectAssociation(
      {
        provider: "codex",
        projectId: "123e4567-e89b-42d3-a456-426614174000",
        projectName: "Runtime folder"
      },
      registered
    ),
    false
  );
});
