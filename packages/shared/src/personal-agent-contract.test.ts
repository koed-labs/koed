import { describe, expect, it } from "vitest";

import {
  PERSONAL_AGENT_CONTRACT_VERSION,
  addPersonalAgentParticipant,
  assertPersonalAgentAttemptRuntimeIdentity,
  assertPersonalAgentAttributionBelongsTo,
  assertPersonalAgentVersionBelongsTo,
  nextPersonalAgentVersion,
  parsePersonalAgentConversation,
  parsePersonalAgentExecutionAttempt,
  parsePersonalAgentExecutionJob,
  parsePersonalAgentIdentity,
  parsePersonalAgentIdentityVersion,
  personalAgentRunningAttemptCount,
  personalAgentTerminalAttemptCount,
  personalAgentExecutionContextSchema,
  retirePersonalAgent,
  setPersonalAgentActiveRespondent
} from "./personal-agent-contract.js";

const ids = {
  owner: "00000000-0000-4000-8000-000000000001",
  otherOwner: "00000000-0000-4000-8000-000000000002",
  agent: "00000000-0000-4000-8000-000000000003",
  secondAgent: "00000000-0000-4000-8000-000000000004",
  version: "00000000-0000-4000-8000-000000000005",
  conversation: "00000000-0000-4000-8000-000000000006",
  job: "00000000-0000-4000-8000-000000000007",
  attempt: "00000000-0000-4000-8000-000000000008",
  secondAttempt: "00000000-0000-4000-8000-000000000009",
  execution: "00000000-0000-4000-8000-000000000010"
} as const;

const timestamps = {
  created: "2026-09-22T10:00:00.000Z",
  updated: "2026-09-22T10:01:00.000Z",
  retired: "2026-09-22T10:02:00.000Z",
  completed: "2026-09-22T10:03:00.000Z"
} as const;

const identity = () =>
  parsePersonalAgentIdentity({
    contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
    id: ids.agent,
    ownerUserId: ids.owner,
    name: "Planner",
    role: "Planning assistant",
    avatarReference: "preset:planner",
    lifecycle: "active",
    defaultProvider: "codex",
    defaultModel: "gpt-test",
    defaultReasoningEffort: null,
    currentVersion: 1,
    createdAt: timestamps.created,
    updatedAt: timestamps.updated,
    retiredAt: null
  });

const conversation = () =>
  parsePersonalAgentConversation({
    contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
    id: ids.conversation,
    ownerUserId: ids.owner,
    participants: [],
    activeAgentId: null,
    modelOverride: null,
    reasoningEffortOverride: null,
    createdAt: timestamps.created,
    updatedAt: timestamps.created
  });

const job = () =>
  parsePersonalAgentExecutionJob({
    contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
    id: ids.job,
    ownerUserId: ids.owner,
    conversationId: ids.conversation,
    attribution: { kind: "agent", agentId: ids.agent, agentVersion: 1 },
    state: "running",
    counters: {
      attemptsStarted: 1,
      attemptsSucceeded: 0,
      attemptsFailed: 0,
      attemptsCanceled: 0,
      attemptsInterrupted: 0
    },
    lastAttemptId: null,
    createdAt: timestamps.created,
    updatedAt: timestamps.updated
  });

const attempt = () =>
  parsePersonalAgentExecutionAttempt({
    contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
    id: ids.attempt,
    ownerUserId: ids.owner,
    jobId: ids.job,
    attemptNumber: 1,
    attribution: { kind: "agent", agentId: ids.agent, agentVersion: 1 },
    provider: "codex",
    model: "gpt-actual",
    aiClientInstanceId: "codex.default",
    reasoningEffort: "high",
    permissionMode: "supervised",
    managedExecutionId: ids.execution,
    managedExecutionGeneration: 2,
    status: "running",
    outcome: null,
    startedAt: timestamps.updated,
    completedAt: null
  });

describe("Personal Agent domain contract", () => {
  it("requires Workspace attribution for Team evidence in Agent context", () => {
    const context = {
      schemaVersion: 1,
      identity: {
        agentId: ids.agent,
        version: 1,
        identityVersionId: ids.version,
        name: "Planner",
        role: "Planning assistant",
        soulInstructions: "Be precise."
      },
      project: { projectId: null, name: null },
      memory: {
        searchDomain: "global",
        evidence: [
          {
            nodeId: "team-item",
            summaryText: "A Team-shared fact.",
            visibility: "team",
            citation: { nodeId: "team-item", visibility: "team" }
          }
        ]
      }
    };

    expect(personalAgentExecutionContextSchema.safeParse(context).success).toBe(
      false
    );
    expect(
      personalAgentExecutionContextSchema.safeParse({
        ...context,
        memory: {
          ...context.memory,
          evidence: [
            {
              ...context.memory.evidence[0],
              teamWorkspaceId: ids.execution
            }
          ]
        }
      }).success
    ).toBe(true);
  });

  it("allows an unset paired provider and model without inventing defaults", () => {
    expect(
      parsePersonalAgentIdentity({
        ...identity(),
        defaultProvider: null,
        defaultModel: null
      })
    ).toMatchObject({ defaultProvider: null, defaultModel: null });
    expect(() =>
      parsePersonalAgentIdentity({
        ...identity(),
        defaultProvider: null,
        defaultModel: "gpt-test"
      })
    ).toThrow(/both be set or both be null/);
  });

  it("keeps editable identity versions owner-scoped and retirement explicit", () => {
    const current = identity();
    const version = parsePersonalAgentIdentityVersion({
      contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
      id: ids.version,
      agentId: ids.agent,
      ownerUserId: ids.owner,
      version: 1,
      name: "Planner",
      role: "Planning assistant",
      avatarReference: "preset:planner",
      defaultProvider: "codex",
      defaultModel: "gpt-5.6",
      defaultReasoningEffort: "high",
      soulInstructions: "Plan carefully and state uncertainty.",
      instructionSource: "custom",
      createdByUserId: ids.owner,
      createdAt: timestamps.created
    });

    expect(nextPersonalAgentVersion([version])).toBe(2);
    expect(() =>
      assertPersonalAgentAttributionBelongsTo(current, version, {
        kind: "agent",
        agentId: ids.agent,
        agentVersion: version.version
      })
    ).not.toThrow();
    expect(() =>
      assertPersonalAgentAttributionBelongsTo(current, version, {
        kind: "agent",
        agentId: ids.agent,
        agentVersion: 2
      })
    ).toThrow(/does not match/);
    expect(retirePersonalAgent(current, timestamps.retired)).toMatchObject({
      lifecycle: "retired",
      retiredAt: timestamps.retired,
      currentVersion: 1
    });
    expect(() =>
      parsePersonalAgentIdentity({ ...current, lifecycle: "retired" })
    ).toThrow();
    expect(() =>
      assertPersonalAgentVersionBelongsTo(
        current,
        parsePersonalAgentIdentityVersion({
          ...version,
          ownerUserId: ids.otherOwner
        })
      )
    ).toThrow(/another owner/);
  });

  it("adds multiple participants without replacing the first and controls the active respondent", () => {
    const first = identity();
    const second = parsePersonalAgentIdentity({
      ...first,
      id: ids.secondAgent,
      name: "Reviewer"
    });
    const withFirst = addPersonalAgentParticipant(conversation(), first, {
      addedAt: timestamps.updated,
      updatedAt: timestamps.updated
    });
    const withBoth = addPersonalAgentParticipant(withFirst, second, {
      addedAt: timestamps.completed,
      updatedAt: timestamps.completed
    });

    expect(withBoth.participants.map((entry) => entry.agentId)).toEqual([
      ids.agent,
      ids.secondAgent
    ]);
    expect(withBoth).toMatchObject({
      modelOverride: null,
      reasoningEffortOverride: null
    });
    expect(
      setPersonalAgentActiveRespondent(withBoth, second, timestamps.completed)
        .activeAgentId
    ).toBe(ids.secondAgent);
    expect(() =>
      addPersonalAgentParticipant(withBoth, first, {
        addedAt: timestamps.completed,
        updatedAt: timestamps.completed
      })
    ).toThrow(/already a conversation participant/);
    expect(() =>
      setPersonalAgentActiveRespondent(
        withBoth,
        { ...second, lifecycle: "retired", retiredAt: timestamps.retired },
        timestamps.completed
      )
    ).toThrow(/Retired/);
  });

  it("retains explicit legacy attribution instead of fabricating an agent", () => {
    const legacy = parsePersonalAgentExecutionJob({
      ...job(),
      attribution: { kind: "legacy", agentId: null, agentVersion: null },
      counters: {
        attemptsStarted: 0,
        attemptsSucceeded: 0,
        attemptsFailed: 0,
        attemptsCanceled: 0,
        attemptsInterrupted: 0
      }
    });
    expect(legacy.attribution).toEqual({
      kind: "legacy",
      agentId: null,
      agentVersion: null
    });
  });

  it("validates actual attempt settings and explicit counter semantics", () => {
    const actualAttempt = attempt();
    expect(actualAttempt).toMatchObject({
      provider: "codex",
      model: "gpt-actual",
      aiClientInstanceId: "codex.default",
      reasoningEffort: "high",
      permissionMode: "supervised",
      managedExecutionGeneration: 2
    });
    expect(() =>
      assertPersonalAgentAttemptRuntimeIdentity(actualAttempt)
    ).not.toThrow();
    const counters = {
      attemptsStarted: 1,
      attemptsSucceeded: 1,
      attemptsFailed: 0,
      attemptsCanceled: 0,
      attemptsInterrupted: 0
    };
    expect(personalAgentTerminalAttemptCount(counters)).toBe(1);
    expect(personalAgentRunningAttemptCount(counters)).toBe(0);
  });

  it("rejects terminal counters that exceed persisted attempts", () => {
    expect(() =>
      parsePersonalAgentExecutionJob({
        ...job(),
        counters: {
          attemptsStarted: 0,
          attemptsSucceeded: 1,
          attemptsFailed: 0,
          attemptsCanceled: 0,
          attemptsInterrupted: 0
        }
      })
    ).toThrow();
    expect(() =>
      parsePersonalAgentExecutionAttempt({
        ...attempt(),
        status: "running",
        outcome: "succeeded"
      })
    ).toThrow();
  });

  it("accepts null effort but rejects empty effort values", () => {
    expect(
      parsePersonalAgentIdentity({
        ...identity(),
        defaultReasoningEffort: null
      }).defaultReasoningEffort
    ).toBeNull();
    expect(() =>
      parsePersonalAgentExecutionAttempt({
        ...attempt(),
        reasoningEffort: " "
      })
    ).toThrow();
  });

  it("requires null effort when a Personal Agent has no saved provider/model", () => {
    expect(() =>
      parsePersonalAgentIdentity({
        ...identity(),
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: "high"
      })
    ).toThrow(/reasoning effort must be null/);
    expect(() =>
      parsePersonalAgentIdentityVersion({
        contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
        id: ids.version,
        agentId: ids.agent,
        ownerUserId: ids.owner,
        version: 1,
        name: "Planner",
        role: "Planning assistant",
        avatarReference: "preset:planner",
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: "high",
        soulInstructions: "Plan carefully and state uncertainty.",
        instructionSource: "custom",
        createdByUserId: ids.owner,
        createdAt: timestamps.created
      })
    ).toThrow(/reasoning effort must be null/);
  });

  it("keeps unknown legacy runtime attribution nullable", () => {
    const legacyAttempt = parsePersonalAgentExecutionAttempt({
      ...attempt(),
      attribution: { kind: "legacy", agentId: null, agentVersion: null },
      provider: null,
      model: null,
      aiClientInstanceId: null,
      permissionMode: null,
      managedExecutionId: null,
      managedExecutionGeneration: null
    });
    expect(legacyAttempt.model).toBeNull();
    expect(() =>
      assertPersonalAgentAttemptRuntimeIdentity(legacyAttempt)
    ).not.toThrow();
    expect(() =>
      assertPersonalAgentAttemptRuntimeIdentity({
        ...attempt(),
        model: null
      })
    ).toThrow(/actual provider/);
  });
});
