import type { FastifyReply } from "fastify";
import {
  COLLABORATION_CHANNEL_CREATION_MAX_PER_HOUR,
  COLLABORATION_CONNECTION_ATTEMPT_MAX_PER_MINUTE,
  COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE,
  COLLABORATION_INVITE_CREATION_MAX_PER_HOUR,
  COLLABORATION_MESSAGE_BURST_MAX_COUNT,
  COLLABORATION_MESSAGE_BURST_WINDOW_MS,
  COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT,
  COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
  COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE
} from "@koed/shared";

import type { RateLimitStore } from "../infra/rate-limit.js";

export const collaborationAdmissionPolicies = {
  messageBurst: {
    windowMs: COLLABORATION_MESSAGE_BURST_WINDOW_MS,
    max: COLLABORATION_MESSAGE_BURST_MAX_COUNT
  },
  messageSustained: {
    windowMs: COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
    max: COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT
  },
  teamMessage: {
    windowMs: COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
    max: COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE
  },
  deploymentMessage: {
    windowMs: COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
    max: COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE
  },
  inviteCreate: {
    windowMs: 60 * COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
    max: COLLABORATION_INVITE_CREATION_MAX_PER_HOUR
  },
  channelCreate: {
    windowMs: 60 * COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
    max: COLLABORATION_CHANNEL_CREATION_MAX_PER_HOUR
  },
  connectionFailure: {
    windowMs: COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
    max: COLLABORATION_CONNECTION_ATTEMPT_MAX_PER_MINUTE
  }
} as const;

export type CollaborationAdmissionPolicyName =
  keyof typeof collaborationAdmissionPolicies;

export type CollaborationAdmissionDecision = {
  policy: CollaborationAdmissionPolicyName;
  limit: number;
  remaining: number;
  resetAt: number;
};

export class CollaborationRateLimitError extends Error {
  readonly statusCode = 429;

  constructor(readonly decision: CollaborationAdmissionDecision) {
    super("Rate limit exceeded");
    this.name = "CollaborationRateLimitError";
  }
}

export interface CollaborationAdmissionController {
  admitMessage(input: {
    userId: string;
    teamId?: string;
  }): Promise<CollaborationAdmissionDecision[]>;
  admitChannelCreation(input: {
    userId: string;
    teamId?: string;
  }): Promise<CollaborationAdmissionDecision[]>;
  admitInviteCreation(input: {
    userId: string;
    teamId: string;
  }): Promise<CollaborationAdmissionDecision[]>;
  admitConnectionFailure(input: {
    deviceId: string;
    origin: string;
  }): Promise<CollaborationAdmissionDecision[]>;
}

type AdmissionCheck = {
  policy: CollaborationAdmissionPolicyName;
  scope: string;
};

export const createCollaborationAdmissionController = (
  store: RateLimitStore,
  hashKey: (value: string) => string
): CollaborationAdmissionController => {
  const consume = async (
    checks: AdmissionCheck[]
  ): Promise<CollaborationAdmissionDecision[]> => {
    const decisions = await Promise.all(
      checks.map(async ({ policy, scope }) => {
        const limits = collaborationAdmissionPolicies[policy];
        const bucket = await store.increment(
          `collaboration:${policy}:${hashKey(scope)}`,
          limits.windowMs
        );
        return {
          policy,
          limit: limits.max,
          remaining: Math.max(0, limits.max - bucket.count),
          resetAt: bucket.resetAt,
          exceeded: bucket.count > limits.max
        };
      })
    );
    const exceeded = decisions.find((decision) => decision.exceeded);
    if (exceeded) {
      throw new CollaborationRateLimitError(exceeded);
    }
    return decisions.map((decision) => ({
      policy: decision.policy,
      limit: decision.limit,
      remaining: decision.remaining,
      resetAt: decision.resetAt
    }));
  };

  return {
    admitMessage: ({ userId, teamId }) =>
      consume([
        { policy: "messageBurst", scope: `user:${userId}` },
        { policy: "messageSustained", scope: `user:${userId}` },
        ...(teamId
          ? [{ policy: "teamMessage" as const, scope: `team:${teamId}` }]
          : []),
        { policy: "deploymentMessage", scope: "deployment" }
      ]),
    admitChannelCreation: ({ userId, teamId }) =>
      consume([
        {
          policy: "channelCreate",
          scope: `user:${userId}:team:${teamId ?? "personal"}`
        }
      ]),
    admitInviteCreation: ({ userId, teamId }) =>
      consume([
        {
          policy: "inviteCreate",
          scope: `user:${userId}:team:${teamId}`
        }
      ]),
    admitConnectionFailure: ({ deviceId, origin }) =>
      consume([
        {
          policy: "connectionFailure",
          scope: `device:${deviceId}:origin:${origin}`
        }
      ])
  };
};

const applyDecisionHeaders = (
  reply: FastifyReply,
  decision: CollaborationAdmissionDecision
): void => {
  reply.header("x-ratelimit-policy", decision.policy);
  reply.header("x-ratelimit-limit", String(decision.limit));
  reply.header("x-ratelimit-remaining", String(decision.remaining));
  reply.header("x-ratelimit-reset", String(Math.ceil(decision.resetAt / 1000)));
};

export const enforceCollaborationAdmission = async (
  reply: FastifyReply,
  admission: Promise<CollaborationAdmissionDecision[]>
): Promise<void> => {
  try {
    const decisions = await admission;
    const primary = decisions[0];
    if (primary) applyDecisionHeaders(reply, primary);
  } catch (cause) {
    if (cause instanceof CollaborationRateLimitError) {
      applyDecisionHeaders(reply, cause.decision);
      reply.header(
        "retry-after",
        String(
          Math.max(1, Math.ceil((cause.decision.resetAt - Date.now()) / 1000))
        )
      );
    }
    throw cause;
  }
};
