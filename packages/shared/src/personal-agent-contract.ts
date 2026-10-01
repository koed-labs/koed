import { z } from "zod";

import {
  aiClientIdentifierPattern,
  aiClientPermissionModes
} from "./ai-client-contract.js";

/** Version of the shared Personal Agent domain contract. */
export const PERSONAL_AGENT_CONTRACT_VERSION = 1;

export const PERSONAL_AGENT_NAME_MAX_LENGTH = 80;
export const PERSONAL_AGENT_ROLE_MAX_LENGTH = 160;
export const PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH = 2_048;
export const PERSONAL_AGENT_SOUL_MAX_LENGTH = 65_536;
export const PERSONAL_AGENT_MODEL_MAX_LENGTH = 512;
export const PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH = 64;
export const PERSONAL_AGENT_MAX_PARTICIPANTS = 100;

const requiredText = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalText = (maximum: number) => z.string().trim().max(maximum);
const nonEmptyOrNullText = (maximum: number) =>
  requiredText(maximum).nullable();
const timestamp = z.string().datetime({ offset: true });
const provider = requiredText(96).regex(aiClientIdentifierPattern).nullable();
const aiClientInstance = requiredText(128).regex(aiClientIdentifierPattern);

export const personalAgentLifecycleSchema = z.enum(["active", "retired"]);
export type PersonalAgentLifecycle = z.infer<
  typeof personalAgentLifecycleSchema
>;

export const personalAgentIdentitySchema = z
  .object({
    contractVersion: z.literal(PERSONAL_AGENT_CONTRACT_VERSION),
    id: z.uuid(),
    ownerUserId: z.uuid(),
    name: requiredText(PERSONAL_AGENT_NAME_MAX_LENGTH),
    role: optionalText(PERSONAL_AGENT_ROLE_MAX_LENGTH),
    /** Opaque UI-owned avatar reference; it is not executable content. */
    avatarReference: optionalText(
      PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH
    ).nullable(),
    lifecycle: personalAgentLifecycleSchema,
    defaultProvider: provider,
    defaultModel: requiredText(PERSONAL_AGENT_MODEL_MAX_LENGTH).nullable(),
    /** null means that no reasoning effort was selected, not an inferred default. */
    defaultReasoningEffort: nonEmptyOrNullText(
      PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH
    ),
    currentVersion: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
    retiredAt: timestamp.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.defaultProvider === null) !== (value.defaultModel === null)) {
      context.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: "Default provider and model must both be set or both be null"
      });
    }
    if (
      value.defaultProvider === null &&
      value.defaultReasoningEffort !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultReasoningEffort"],
        message:
          "Default reasoning effort must be null when no provider and model are saved"
      });
    }
    if (value.lifecycle === "active" && value.retiredAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["retiredAt"],
        message: "Active agents cannot have a retirement timestamp"
      });
    }
    if (value.lifecycle === "retired" && value.retiredAt === null) {
      context.addIssue({
        code: "custom",
        path: ["retiredAt"],
        message: "Retired agents require a retirement timestamp"
      });
    }
  });

export type PersonalAgentIdentity = z.infer<typeof personalAgentIdentitySchema>;

export const personalAgentInstructionSourceSchema = z.enum([
  "generated",
  "custom"
]);
export type PersonalAgentInstructionSource = z.infer<
  typeof personalAgentInstructionSourceSchema
>;

export const personalAgentIdentityVersionSchema = z
  .object({
    contractVersion: z.literal(PERSONAL_AGENT_CONTRACT_VERSION),
    id: z.uuid(),
    agentId: z.uuid(),
    ownerUserId: z.uuid(),
    version: z.number().int().positive(),
    /** Presentation fields are snapshotted so renamed identities retain history. */
    name: requiredText(PERSONAL_AGENT_NAME_MAX_LENGTH),
    role: optionalText(PERSONAL_AGENT_ROLE_MAX_LENGTH),
    avatarReference: optionalText(
      PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH
    ).nullable(),
    defaultProvider: provider,
    defaultModel: requiredText(PERSONAL_AGENT_MODEL_MAX_LENGTH).nullable(),
    defaultReasoningEffort: nonEmptyOrNullText(
      PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH
    ),
    soulInstructions: requiredText(PERSONAL_AGENT_SOUL_MAX_LENGTH),
    instructionSource: personalAgentInstructionSourceSchema,
    sourceTemplateId: z
      .string()
      .max(96)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .nullable()
      .default(null),
    sourceTemplateVersion: z
      .number()
      .int()
      .positive()
      .safe()
      .nullable()
      .default(null),
    createdByUserId: z.uuid(),
    createdAt: timestamp
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.defaultProvider === null) !== (value.defaultModel === null)) {
      context.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: "Default provider and model must both be set or both be null"
      });
    }
    if (
      value.defaultProvider === null &&
      value.defaultReasoningEffort !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultReasoningEffort"],
        message:
          "Default reasoning effort must be null when no provider and model are saved"
      });
    }
    if (
      (value.sourceTemplateId === null) !==
      (value.sourceTemplateVersion === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceTemplateVersion"],
        message:
          "Template source ID and version must both be set or both be null"
      });
    }
  });

export type PersonalAgentIdentityVersion = z.infer<
  typeof personalAgentIdentityVersionSchema
>;

export const personalAgentExecutionContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: z
      .object({
        agentId: z.uuid(),
        version: z.number().int().positive(),
        identityVersionId: z.uuid(),
        name: requiredText(PERSONAL_AGENT_NAME_MAX_LENGTH),
        role: optionalText(PERSONAL_AGENT_ROLE_MAX_LENGTH),
        soulInstructions: requiredText(PERSONAL_AGENT_SOUL_MAX_LENGTH)
      })
      .strict(),
    project: z
      .object({
        projectId: z.string().trim().min(1).max(2_048).nullable(),
        name: optionalText(256).nullable()
      })
      .strict(),
    activeJob: z
      .object({
        jobId: z.uuid(),
        state: z.enum(["queued", "running", "waiting"]),
        goal: requiredText(1_000)
      })
      .strict()
      .nullable()
      .default(null),
    /** Server-derived binding for an owner-private pending Team request. */
    pendingTeamRequestId: z.uuid().nullable().default(null),
    memory: z
      .object({
        searchDomain: z.enum(["project", "global"]),
        evidence: z
          .array(
            z
              .object({
                nodeId: z.string().trim().min(1).max(512),
                sourceType: z
                  .enum([
                    "memory_node",
                    "memory_event",
                    "message",
                    "curated_memory"
                  ])
                  .optional(),
                sourceId: z.string().trim().min(1).max(512).optional(),
                summaryText: z.string().max(8_000),
                visibility: z.enum(["personal", "team"]).default("personal"),
                teamWorkspaceId: z.uuid().optional(),
                citation: z.record(z.string(), z.unknown()),
                sourceTime: z.string().max(64).optional()
              })
              .strict()
          )
          .max(5)
      })
      .strict()
  })
  .strict()
  .superRefine((context, issueContext) => {
    for (const [index, evidence] of context.memory.evidence.entries()) {
      if (
        evidence.visibility === "team" &&
        evidence.teamWorkspaceId === undefined
      ) {
        issueContext.addIssue({
          code: "custom",
          path: ["memory", "evidence", index, "teamWorkspaceId"],
          message: "Team evidence requires its authorized Workspace"
        });
      }
    }
  });

export type PersonalAgentExecutionContext = z.infer<
  typeof personalAgentExecutionContextSchema
>;

/**
 * Provider-native signal emitted only when an Agent turn explicitly accepts
 * or continues an assignment. The user prompt itself never carries this
 * authority-bearing value.
 */
export const personalAgentIntentSignalSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("assign"),
        goal: requiredText(1_000)
      })
      .strict(),
    z.object({ kind: z.literal("continue") }).strict(),
    z
      .object({
        kind: z.literal("new_job"),
        goal: requiredText(1_000)
      })
      .strict()
  ])
  .describe(
    "A bounded Agent intent signal. Emit assign only for explicit user work requests, continue only for explicit follow-up on an active Job, and new_job only for explicit additional work after completion. Do not emit for planning, questions, discussion, or ambiguity."
  );

export type PersonalAgentIntentSignal = z.infer<
  typeof personalAgentIntentSignalSchema
>;

export const personalAgentIntentSignalJsonSchema = z.toJSONSchema(
  personalAgentIntentSignalSchema
);

/** State asserted by the Agent's actual turn, never inferred from its prose. */
export const personalAgentTurnStatusSchema = z.enum([
  "complete",
  "awaiting_owner"
]);
export type PersonalAgentTurnStatus = z.infer<
  typeof personalAgentTurnStatusSchema
>;
export const personalAgentTurnStatusJsonSchema = z.toJSONSchema(
  z.object({ status: personalAgentTurnStatusSchema }).strict()
);

/** Explicit in-turn work phase; this is separate from Job outcome/status. */
export const personalAgentPhaseSchema = z.enum(["working", "checking"]);
export type PersonalAgentPhase = z.infer<typeof personalAgentPhaseSchema>;
export const personalAgentPhaseJsonSchema = z.toJSONSchema(
  z.object({ phase: personalAgentPhaseSchema }).strict()
);

export const personalAgentParticipantSchema = z
  .object({
    conversationId: z.uuid(),
    ownerUserId: z.uuid(),
    agentId: z.uuid(),
    ordinal: z.number().int().nonnegative(),
    addedAt: timestamp
  })
  .strict();

export type PersonalAgentParticipant = z.infer<
  typeof personalAgentParticipantSchema
>;

export const personalAgentConversationSchema = z
  .object({
    contractVersion: z.literal(PERSONAL_AGENT_CONTRACT_VERSION),
    id: z.uuid(),
    ownerUserId: z.uuid(),
    participants: z
      .array(personalAgentParticipantSchema)
      .max(PERSONAL_AGENT_MAX_PARTICIPANTS),
    activeAgentId: z.uuid().nullable(),
    /** Null means that the reusable identity default remains in effect. */
    modelOverride: requiredText(PERSONAL_AGENT_MODEL_MAX_LENGTH).nullable(),
    /** Null means that the reusable identity default remains in effect. */
    reasoningEffortOverride: nonEmptyOrNullText(
      PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH
    ),
    version: z.number().int().positive().default(1),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(
      value.participants.map((participant) => participant.agentId)
    );
    value.participants.forEach((participant, index) => {
      if (participant.conversationId !== value.id) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "conversationId"],
          message: "Participant belongs to another conversation"
        });
      }
      if (participant.ownerUserId !== value.ownerUserId) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "ownerUserId"],
          message: "Participant belongs to another owner"
        });
      }
    });
    if (ids.size !== value.participants.length) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "A conversation cannot contain duplicate agent participants"
      });
    }
    if (value.activeAgentId !== null && !ids.has(value.activeAgentId)) {
      context.addIssue({
        code: "custom",
        path: ["activeAgentId"],
        message: "The active respondent must be a participant"
      });
    }
  });

export type PersonalAgentConversation = z.infer<
  typeof personalAgentConversationSchema
>;

/** Explicitly preserves history that predates Personal Agent attribution. */
export const personalAgentAttributionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    agentId: z.uuid(),
    agentVersion: z.number().int().positive()
  }),
  z.object({
    kind: z.literal("legacy"),
    agentId: z.null(),
    agentVersion: z.null()
  })
]);

export type PersonalAgentAttribution = z.infer<
  typeof personalAgentAttributionSchema
>;

export const personalAgentJobStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled"
]);
export type PersonalAgentJobState = z.infer<typeof personalAgentJobStateSchema>;

export const personalAgentAttemptOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "canceled",
  "interrupted"
]);
export type PersonalAgentAttemptOutcome = z.infer<
  typeof personalAgentAttemptOutcomeSchema
>;

export const personalAgentAttemptCountersSchema = z
  .object({
    /** Number of attempt records created for this logical job. */
    attemptsStarted: z.number().int().nonnegative(),
    attemptsSucceeded: z.number().int().nonnegative(),
    attemptsFailed: z.number().int().nonnegative(),
    attemptsCanceled: z.number().int().nonnegative(),
    attemptsInterrupted: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = personalAgentTerminalAttemptCount(value);
    if (terminal > value.attemptsStarted) {
      context.addIssue({
        code: "custom",
        path: ["attemptsStarted"],
        message: "Terminal attempt counters cannot exceed attemptsStarted"
      });
    }
  });

export type PersonalAgentAttemptCounters = z.infer<
  typeof personalAgentAttemptCountersSchema
>;

export const personalAgentExecutionJobSchema = z
  .object({
    contractVersion: z.literal(PERSONAL_AGENT_CONTRACT_VERSION),
    id: z.uuid(),
    ownerUserId: z.uuid(),
    conversationId: z.uuid(),
    commandId: z.uuid().nullable().default(null),
    title: requiredText(512).default("Agent task"),
    projectId: optionalText(256).nullable().default(null),
    attribution: personalAgentAttributionSchema,
    state: personalAgentJobStateSchema,
    counters: personalAgentAttemptCountersSchema,
    lastAttemptId: z.uuid().nullable(),
    outputReference: z
      .object({
        runtimeItemIds: z.array(requiredText(256)).max(128),
        attemptOutputs: z
          .array(
            z
              .object({
                attemptId: z.uuid(),
                runtimeItemIds: z.array(requiredText(256)).min(1).max(128)
              })
              .strict()
          )
          .max(100)
          .optional(),
        legacyRuntimeItemIds: z.array(requiredText(256)).max(128).optional()
      })
      .strict()
      .nullable()
      .default(null),
    version: z.number().int().positive().default(1),
    lastObservedAt: timestamp.nullable().default(null),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict();

export type PersonalAgentExecutionJob = z.infer<
  typeof personalAgentExecutionJobSchema
>;

export const personalAgentExecutionAttemptSchema = z
  .object({
    contractVersion: z.literal(PERSONAL_AGENT_CONTRACT_VERSION),
    id: z.uuid(),
    ownerUserId: z.uuid(),
    jobId: z.uuid(),
    commandId: z.uuid().nullable().default(null),
    attemptNumber: z.number().int().positive(),
    attribution: personalAgentAttributionSchema,
    /** Actual settings used for this attempt, not job defaults. */
    provider: provider.nullable(),
    model: requiredText(PERSONAL_AGENT_MODEL_MAX_LENGTH).nullable(),
    aiClientInstanceId: aiClientInstance.nullable(),
    reasoningEffort: nonEmptyOrNullText(
      PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH
    ),
    permissionMode: z.enum(aiClientPermissionModes).nullable(),
    /** Null is allowed before a managed runtime is attached; never infer one. */
    managedExecutionId: z.uuid().nullable(),
    /** Null is allowed when no managed runtime generation was observed. */
    managedExecutionGeneration: z.number().int().positive().nullable(),
    status: z.enum([
      "running",
      "succeeded",
      "failed",
      "canceled",
      "interrupted"
    ]),
    outcome: personalAgentAttemptOutcomeSchema.nullable(),
    startedAt: timestamp,
    phase: personalAgentPhaseSchema.default("working"),
    phaseObservedAt: timestamp.nullable().default(null),
    completedAt: timestamp.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = value.status !== "running";
    if (terminal !== (value.outcome !== null)) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Running attempts have no outcome; terminal attempts do"
      });
    }
    if (terminal !== (value.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completed time must match terminal attempt state"
      });
    }
    if (value.outcome !== null && value.outcome !== value.status) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Attempt outcome must match terminal status"
      });
    }
    if (
      (value.managedExecutionId === null) !==
      (value.managedExecutionGeneration === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["managedExecutionGeneration"],
        message:
          "Managed execution generation must be present with its execution id"
      });
    }
  });

export type PersonalAgentExecutionAttempt = z.infer<
  typeof personalAgentExecutionAttemptSchema
>;

export const parsePersonalAgentIdentity = (
  value: unknown
): PersonalAgentIdentity => personalAgentIdentitySchema.parse(value);

export const parsePersonalAgentIdentityVersion = (
  value: unknown
): PersonalAgentIdentityVersion =>
  personalAgentIdentityVersionSchema.parse(value);

export const parsePersonalAgentConversation = (
  value: unknown
): PersonalAgentConversation => personalAgentConversationSchema.parse(value);

export const parsePersonalAgentExecutionJob = (
  value: unknown
): PersonalAgentExecutionJob => personalAgentExecutionJobSchema.parse(value);

export const parsePersonalAgentExecutionAttempt = (
  value: unknown
): PersonalAgentExecutionAttempt =>
  personalAgentExecutionAttemptSchema.parse(value);

export const assertPersonalAgentOwner = (
  ownerUserId: string,
  record: { ownerUserId: string }
): void => {
  if (ownerUserId !== record.ownerUserId) {
    throw new TypeError("Personal Agent record belongs to another owner");
  }
};

export const assertPersonalAgentVersionBelongsTo = (
  agent: PersonalAgentIdentity,
  version: PersonalAgentIdentityVersion
): void => {
  assertPersonalAgentOwner(agent.ownerUserId, version);
  if (version.agentId !== agent.id) {
    throw new TypeError("Personal Agent version belongs to another identity");
  }
};

/**
 * Shape validation cannot authorize a relation between rows. Call this when a
 * run or attempt is attributed to an identity/version owned by the actor.
 */
export const assertPersonalAgentAttributionBelongsTo = (
  agent: PersonalAgentIdentity,
  version: PersonalAgentIdentityVersion,
  attribution: PersonalAgentAttribution
): void => {
  assertPersonalAgentVersionBelongsTo(agent, version);
  if (attribution.kind !== "agent") {
    throw new TypeError(
      "Legacy attribution cannot be validated against a Personal Agent identity"
    );
  }
  if (
    attribution.agentId !== agent.id ||
    attribution.agentVersion !== version.version
  ) {
    throw new TypeError(
      "Personal Agent attribution does not match its identity version"
    );
  }
};

export const assertPersonalAgentIsActive = (
  agent: PersonalAgentIdentity
): void => {
  if (agent.lifecycle !== "active") {
    throw new TypeError("Retired Personal Agents cannot be used for new work");
  }
};

export const nextPersonalAgentVersion = (
  versions: readonly PersonalAgentIdentityVersion[]
): number =>
  versions.reduce((highest, version) => Math.max(highest, version.version), 0) +
  1;

export const retirePersonalAgent = (
  agent: PersonalAgentIdentity,
  retiredAt: string
): PersonalAgentIdentity => {
  if (agent.lifecycle === "retired") {
    throw new TypeError("Personal Agent is already retired");
  }
  const parsedRetiredAt = timestamp.parse(retiredAt);
  return {
    ...agent,
    lifecycle: "retired",
    retiredAt: parsedRetiredAt,
    updatedAt: parsedRetiredAt
  };
};

export const addPersonalAgentParticipant = (
  conversation: PersonalAgentConversation,
  agent: PersonalAgentIdentity,
  input: { addedAt: string; updatedAt: string }
): PersonalAgentConversation => {
  assertPersonalAgentOwner(conversation.ownerUserId, agent);
  assertPersonalAgentIsActive(agent);
  if (conversation.participants.some((entry) => entry.agentId === agent.id)) {
    throw new TypeError("Personal Agent is already a conversation participant");
  }
  const participant: PersonalAgentParticipant = {
    conversationId: conversation.id,
    ownerUserId: conversation.ownerUserId,
    agentId: agent.id,
    ordinal:
      conversation.participants.reduce(
        (highest, entry) => Math.max(highest, entry.ordinal),
        -1
      ) + 1,
    addedAt: timestamp.parse(input.addedAt)
  };
  return personalAgentConversationSchema.parse({
    ...conversation,
    participants: [...conversation.participants, participant],
    updatedAt: timestamp.parse(input.updatedAt)
  });
};

export const setPersonalAgentActiveRespondent = (
  conversation: PersonalAgentConversation,
  agent: PersonalAgentIdentity | null,
  updatedAt: string
): PersonalAgentConversation => {
  if (agent !== null) {
    assertPersonalAgentOwner(conversation.ownerUserId, agent);
    assertPersonalAgentIsActive(agent);
    if (
      !conversation.participants.some((entry) => entry.agentId === agent.id)
    ) {
      throw new TypeError("Active respondent must already be a participant");
    }
  }
  return personalAgentConversationSchema.parse({
    ...conversation,
    activeAgentId: agent?.id ?? null,
    updatedAt: timestamp.parse(updatedAt)
  });
};

export const personalAgentTerminalAttemptCount = (
  counters: PersonalAgentAttemptCounters
): number =>
  counters.attemptsSucceeded +
  counters.attemptsFailed +
  counters.attemptsCanceled +
  counters.attemptsInterrupted;

export const personalAgentRunningAttemptCount = (
  counters: PersonalAgentAttemptCounters
): number =>
  counters.attemptsStarted - personalAgentTerminalAttemptCount(counters);

/** Agent-attributed attempts must have actual runtime identity, not defaults. */
export const assertPersonalAgentAttemptRuntimeIdentity = (
  attempt: PersonalAgentExecutionAttempt
): void => {
  if (
    attempt.attribution.kind === "agent" &&
    (attempt.provider === null ||
      attempt.model === null ||
      attempt.aiClientInstanceId === null ||
      attempt.permissionMode === null)
  ) {
    throw new TypeError(
      "Agent-attributed attempts require actual provider, instance, model, and permission"
    );
  }
};
