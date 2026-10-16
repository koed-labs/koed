import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOwnedAgentHandoffDraft,
  buildTeamAgentMentions,
  privateAgentHandoffHref,
  privateAgentHandoffSelection,
  teamAgentRequestBindingFromRuntime,
  teamAgentFreshPlanningHref,
  teamAgentMentionsForParticipants,
  teamMentionSelectionForScope
  // @ts-expect-error -- Node's native TypeScript runner needs the source extension.
} from "./team-agent-mentions-state.ts";
import type { PersonalAgent } from "./personal-agents-client.ts";
import type { TeamAgentOffer } from "@koed/shared/team-agent-requests";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { unresolvedAgentMentions } from "./agent-mentions.ts";

const owned = (id: string, lifecycle: "active" | "retired" = "active") =>
  ({
    id,
    name: `Agent ${id}`,
    role: "Research",
    lifecycle,
    currentVersion: 3,
    defaultProvider: "codex",
    defaultModel: "gpt-6.1",
    defaultReasoningEffort: "high"
  }) as unknown as PersonalAgent;

const offer = (overrides: Partial<TeamAgentOffer> = {}): TeamAgentOffer => ({
  teamId: "team",
  agentId: "colleague-agent",
  ownerId: "owner-b",
  ownerName: "Bea",
  agentName: "Bea · Analyst",
  description: "Short public description",
  enabled: true,
  version: 2,
  canManage: false,
  ...overrides
});

test("selected Team Agent reaches the current composer submit context only in its scope", () => {
  const selection = {
    scopeKey: "account-a:team-a:channel-a",
    agentId: "agent-a"
  };
  const submittedAgentId = teamMentionSelectionForScope(
    selection,
    "account-a:team-a:channel-a"
  );
  assert.equal(submittedAgentId, "agent-a");
  assert.equal(
    teamMentionSelectionForScope(selection, "account-a:team-a:channel-b"),
    null
  );
  assert.equal(
    teamMentionSelectionForScope(selection, "account-b:team-a:channel-a"),
    null
  );
});

test("runtime Team binding parsing distinguishes bound, ordinary and unavailable responses", () => {
  const binding = {
    requestId: "12345678-1234-4234-8234-123456789012",
    teamId: "22345678-1234-4234-8234-123456789012",
    agentId: "32345678-1234-4234-8234-123456789012",
    status: "accepted"
  };
  assert.deepEqual(
    teamAgentRequestBindingFromRuntime({ teamAgentRequestBinding: binding }),
    binding
  );
  assert.equal(
    teamAgentRequestBindingFromRuntime({ teamAgentRequestBinding: null }),
    null
  );
  assert.equal(teamAgentRequestBindingFromRuntime({}), undefined);
  assert.equal(
    teamAgentRequestBindingFromRuntime({
      teamAgentRequestBinding: { ...binding, teamId: "other" }
    }),
    undefined
  );
});

test("Team mention choices include active owned Agents and enabled colleague offers only", () => {
  const choices = buildTeamAgentMentions(
    "owner-a",
    [owned("own-agent"), owned("retired-agent", "retired")],
    [
      offer(),
      offer({ agentId: "disabled-agent", enabled: false }),
      offer({
        agentId: "own-agent",
        ownerId: "owner-a",
        agentName: "Updated owned name"
      })
    ]
  );
  assert.deepEqual(
    choices.map(({ id, kind, ownerName }) => ({ id, kind, ownerName })),
    [
      { id: "own-agent", kind: "owned", ownerName: "you" },
      { id: "colleague-agent", kind: "colleague", ownerName: "Bea" }
    ]
  );
  assert.equal(choices[1]?.teamRequestOnly, true);
});

test("direct-message Agent choices belong only to current conversation participants", () => {
  const choices = buildTeamAgentMentions(
    "owner-a",
    [owned("own-agent")],
    [offer(), offer({ agentId: "other-participant-agent", ownerId: "owner-c" })]
  );

  assert.deepEqual(
    teamAgentMentionsForParticipants(choices, [
      { id: "owner-a", membershipState: "enabled" },
      { id: "owner-b", membershipState: "enabled" },
      { id: "owner-c", membershipState: "disabled" }
    ]).map(({ id }) => id),
    ["own-agent", "colleague-agent"]
  );
  assert.deepEqual(
    teamAgentMentionsForParticipants(choices, [
      { id: "owner-b", membershipState: "disabled" }
    ]),
    []
  );
});

test("owner suffix stays in the display label while the canonical mention resolves by ID", () => {
  const choices = buildTeamAgentMentions("owner-a", [owned("own-agent")], []);
  const [agent] = choices;
  assert.ok(agent);
  assert.equal(agent.name.endsWith(" · you"), true);
  assert.doesNotMatch(agent.mentionToken ?? "", /[·\s]/u);
  assert.deepEqual(unresolvedAgentMentions(`@${agent.mentionToken}`, choices), [
    {
      name: agent.mentionToken,
      kind: "unselected",
      candidateIds: ["own-agent"]
    }
  ]);
});

test("owned-Agent handoff quotes only bounded visible context in an editable private draft", () => {
  const draft = buildOwnedAgentHandoffDraft({
    agentName: "Analyst",
    channelName: "planning",
    typedMessage: "@Analyst can you check this?",
    recentMessages: [
      { senderName: "Hidden", body: "not sent", delivery: "failed" },
      { senderName: "Maya", body: "The launch is next week.", delivery: "sent" }
    ]
  });
  assert.match(draft, /untrusted Team discussion/);
  assert.match(draft, /Maya: The launch is next week\./);
  assert.match(draft, /You in the Team channel: @Analyst can you check this\?/);
  assert.doesNotMatch(
    draft,
    /Discuss this request|Do not begin the assignment/
  );
  assert.doesNotMatch(draft, /Hidden: not sent/);
  assert.ok(draft.length <= 8_000);
});

test("private Agent handoff carries bounded editable context and only approved route identifiers", () => {
  const href = privateAgentHandoffHref({
    agentId: "agent-a",
    localProjectId: "lp_123",
    teamId: "team-a",
    requestId: "request-a",
    executionId: "execution-a",
    draft: "Please investigate the failing tests."
  });
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  assert.equal(params.get("chat"), "1");
  assert.equal(params.get("agent"), "agent-a");
  assert.equal(params.get("project"), "lp_123");
  assert.equal(params.get("draft"), "Please investigate the failing tests.");
  assert.equal(params.get("teamRequest"), "request-a");
  assert.equal(params.get("teamRequestTeam"), "team-a");
  assert.equal(params.get("execution"), "execution-a");
  assert.equal(params.has("privateGoal"), false);
  const bounded = new URLSearchParams(
    privateAgentHandoffHref({
      agentId: "a",
      localProjectId: "p",
      teamId: "t",
      draft: "x".repeat(9_000)
    }).split("?")[1]
  );
  assert.equal(bounded.get("draft")?.length, 8_000);
});

test("owned-Agent handoff retains model, reasoning, access and exact Client", () => {
  const selection = {
    agentId: "agent-a",
    provider: "codex",
    model: "model-b",
    effort: "high",
    permissionMode: "read" as const,
    instanceId: "client-a",
    hostedInstanceId: "hosted-a"
  };
  const href = privateAgentHandoffHref({
    agentId: selection.agentId,
    localProjectId: "lp_project",
    teamId: "team",
    draft: "retained",
    selection
  });
  const restored = privateAgentHandoffSelection(
    new URLSearchParams(href.split("?")[1])
  );
  assert.deepEqual(restored, {
    provider: "codex",
    model: "model-b",
    effort: "high",
    permissionMode: "read",
    instanceId: "client-a",
    hostedInstanceId: "hosted-a"
  });
});

test("fresh Team planning route is blank and retains owner, versions, project and exact launch settings", () => {
  const href = teamAgentFreshPlanningHref({
    agentId: "agent-a",
    projectId: "lp_project",
    teamId: "team-a",
    requestId: "request-a",
    requestVersion: 4,
    reviewVersion: 7,
    selection: {
      agentId: "agent-a",
      provider: "codex",
      model: "chosen-model",
      effort: "high",
      permissionMode: "ask",
      instanceId: "client-a",
      hostedInstanceId: "hosted-a"
    }
  });
  assert.ok(href);
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  assert.equal(params.get("chat"), "1");
  assert.equal(params.get("agent"), "agent-a");
  assert.equal(params.get("project"), "lp_project");
  assert.equal(params.get("provider"), "codex");
  assert.equal(params.get("model"), "chosen-model");
  assert.equal(params.get("effort"), "high");
  assert.equal(params.get("access"), "ask");
  assert.equal(params.get("client"), "client-a");
  assert.equal(params.get("hostedClient"), "hosted-a");
  assert.equal(params.get("teamRequest"), "request-a");
  assert.equal(params.get("teamRequestTeam"), "team-a");
  assert.equal(params.get("teamRequestVersion"), "4");
  assert.equal(params.get("teamReviewVersion"), "7");
  assert.equal(params.has("draft"), false);
  assert.equal(params.has("execution"), false);
});

test("fresh Team planning route rejects missing or stale binding versions and unsupported permission modes", () => {
  const base = {
    agentId: "agent-a",
    projectId: null,
    teamId: "team-a",
    requestId: "request-a",
    requestVersion: 4,
    reviewVersion: 7,
    selection: {
      agentId: "agent-a",
      provider: "codex",
      model: "chosen-model",
      effort: "high",
      permissionMode: "full" as const,
      instanceId: "client-a"
    }
  };
  assert.equal(
    teamAgentFreshPlanningHref({ ...base, requestVersion: Number.NaN }),
    null
  );
  assert.equal(teamAgentFreshPlanningHref({ ...base, reviewVersion: 0 }), null);
  assert.equal(
    teamAgentFreshPlanningHref({
      ...base,
      selection: { ...base.selection, permissionMode: "read" }
    }),
    null
  );
  assert.equal(
    teamAgentFreshPlanningHref({
      ...base,
      selection: { ...base.selection, agentId: "different-agent" }
    }),
    null
  );
});
test("handoff settings reject incomplete or malformed values", () => {
  assert.equal(privateAgentHandoffSelection(new URLSearchParams()), undefined);
  assert.equal(
    privateAgentHandoffSelection(
      new URLSearchParams({
        provider: "codex",
        model: "model",
        effort: "high",
        access: "invalid"
      })
    ),
    undefined
  );
  assert.equal(
    privateAgentHandoffSelection(
      new URLSearchParams({
        provider: "codex",
        model: "bad\nmodel",
        effort: "high",
        access: "read"
      })
    ),
    undefined
  );
});
