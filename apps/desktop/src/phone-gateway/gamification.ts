/**
 * Gamification for the phone, first round: ranks, milestones and limited
 * editions, computed on this Mac from what Koed already records. No new
 * service and nothing leaves the Mac.
 *
 *   Jobs finished   Scheduled Job runs that finished ("ok"), by the job's
 *                   Agent; for the Chief of Staff also the replies it
 *                   finished in the phone's conversation.
 *   Days together   since the Agent was created.
 *   Ranks           jobs AND days must both hold (the Koed Mobile rule).
 *   Milestones      first job, ten jobs, one month together.
 *   Editions        Pixelkin looks earned by the person (a team of five,
 *                   ten unblocks from the phone, fifteen questions asked of
 *                   Koed's memory, …) and given to one Agent to wear.
 *
 * What the phone itself observed (replies, unblocks, questions asked) and the
 * dates things were earned are kept in the Desktop's encrypted secret store.
 */
import { z } from "zod";
import type { PdsDesktopSecretStore } from "../pds-secure-provider.js";
import type {
  PhoneCollection,
  PhoneEdition,
  PhoneMilestone,
  PhoneRank,
  PhoneStanding
} from "./contract.js";

export const PHONE_GAMIFICATION_SECRET_REFERENCE = "koed-phone-gamification.v1";

const DAY_MS = 86_400_000;
const RANKS: PhoneRank[] = [
  "New recruit",
  "Getting acquainted",
  "Trusted hand",
  "Old hand"
];
/** Jobs and days together must both hold. */
const RANK_RULES: Array<{ rank: PhoneRank; jobs: number; days: number }> = [
  { rank: "Getting acquainted", jobs: 1, days: 0 },
  { rank: "Trusted hand", jobs: 5, days: 14 },
  { rank: "Old hand", jobs: 20, days: 60 }
];

type Overlay = {
  top?: "antenna" | "sprout" | "ears";
  palette: { base: string; grayscale?: boolean };
  face?: { expression: string };
};

type Metric = "jobs" | "team" | "scheduled" | "unblocks" | "asks";

const EDITIONS: ReadonlyArray<{
  id: string;
  name: string;
  rule: string;
  metric: Metric;
  target: number;
  memory?: boolean;
  overlay: Overlay;
}> = [
  {
    id: "graphite",
    name: "Graphite",
    rule: "Finish a first job together",
    metric: "jobs",
    target: 1,
    overlay: { palette: { base: "#8b9099", grayscale: true } }
  },
  {
    id: "lumen",
    name: "Lumen",
    rule: "Give your agents 3 scheduled jobs",
    metric: "scheduled",
    target: 3,
    overlay: {
      top: "sprout",
      palette: { base: "#f0cf3c" },
      face: { expression: "happy" }
    }
  },
  {
    id: "goldie",
    name: "Goldie",
    rule: "Build a team of 5 agents",
    metric: "team",
    target: 5,
    overlay: {
      top: "antenna",
      palette: { base: "#e0a526" },
      face: { expression: "joy" }
    }
  },
  {
    id: "glass",
    name: "Glass",
    rule: "Unblock an agent from your phone 10 times",
    metric: "unblocks",
    target: 10,
    overlay: { palette: { base: "#68c4e2" }, face: { expression: "curious" } }
  },
  {
    id: "prism",
    name: "Prism",
    rule: "Ask Koed's memory 15 questions",
    metric: "asks",
    target: 15,
    memory: true,
    overlay: {
      top: "ears",
      palette: { base: "#d44c9c" },
      face: { expression: "wink" }
    }
  },
  {
    id: "nightshift",
    name: "Nightshift",
    rule: "Finish 25 jobs together",
    metric: "jobs",
    target: 25,
    overlay: { palette: { base: "#5a3fd4" }, face: { expression: "sleepy" } }
  }
];

export const EDITION_IDS = EDITIONS.map((edition) => edition.id);

const stateSchema = z
  .object({
    version: z.literal(1),
    /** False until the first evaluation: what was already true then is recorded quietly. */
    initialized: z.boolean(),
    counters: z
      .object({
        unblocks: z.number().int().nonnegative(),
        asks: z.number().int().nonnegative(),
        /** When each Chief of Staff reply finished (newest last, capped). */
        chiefReplies: z.array(z.string()).max(400),
        chiefRepliesTotal: z.number().int().nonnegative()
      })
      .strict(),
    agents: z.record(
      z.string(),
      z
        .object({
          rank: z.enum(RANKS as [PhoneRank, ...PhoneRank[]]),
          milestones: z.record(z.string(), z.string())
        })
        .strict()
    ),
    editions: z.record(
      z.string(),
      z.object({ earnedAt: z.string(), seen: z.boolean() }).strict()
    ),
    /** editionId → agentId */
    worn: z.record(z.string(), z.string())
  })
  .strict();

export type GamificationState = z.infer<typeof stateSchema>;

const emptyState = (): GamificationState => ({
  version: 1,
  initialized: false,
  counters: { unblocks: 0, asks: 0, chiefReplies: [], chiefRepliesTotal: 0 },
  agents: {},
  editions: {},
  worn: {}
});

/** What Koed knows right now, gathered by the service. */
export type GamificationFacts = {
  now: Date;
  agents: ReadonlyArray<{
    id: string;
    name: string;
    isChiefOfStaff: boolean;
    createdAt: string;
  }>;
  /** When each finished Scheduled Job run finished, by Agent. */
  finishedRuns: ReadonlyMap<string, readonly string[]>;
  /** How many Scheduled Jobs exist. */
  scheduledJobs: number;
  /** Events Koed's memory holds across your Chats. */
  remembered: number | null;
};

export type GamificationEvent =
  | { kind: "milestone"; agentId: string; agentName: string; title: string }
  | {
      kind: "rank";
      agentId: string;
      agentName: string;
      rank: PhoneRank;
      jobs: number;
    }
  | { kind: "edition"; editionId: string; name: string };

const rankFor = (jobs: number, days: number): PhoneRank => {
  let rank: PhoneRank = "New recruit";
  for (const rule of RANK_RULES)
    if (jobs >= rule.jobs && days >= rule.days) rank = rule.rank;
  return rank;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const overlayLook = (
  look: Record<string, unknown>,
  overlay: Overlay
): Record<string, unknown> => {
  const apply = (value: Record<string, unknown>) => ({
    ...value,
    ...(overlay.top ? { top: overlay.top } : {}),
    palette: { ...overlay.palette },
    ...(overlay.face
      ? { face: { ...(recordOf(value.face) ?? {}), ...overlay.face } }
      : {})
  });
  const nested = recordOf(look.pixelkin);
  return nested ? { ...look, pixelkin: apply(nested) } : apply(look);
};

/** The look an Agent shows: its own, or its own body wearing an edition's colours. */
export const wornLook = (
  look: Record<string, unknown>,
  editionId: string | null
): Record<string, unknown> => {
  const edition = EDITIONS.find((candidate) => candidate.id === editionId);
  return edition ? overlayLook(look, edition.overlay) : look;
};

type Computed = {
  standing: Map<string, PhoneStanding>;
  metrics: Record<Metric, number>;
  /** When each Agent finished each job, oldest first. */
  dates: Map<string, string[]>;
};

const compute = (
  facts: GamificationFacts,
  state: GamificationState
): Computed => {
  const now = facts.now.getTime();
  const dates = new Map<string, string[]>();
  let totalJobs = 0;
  for (const agent of facts.agents) {
    const finished = [...(facts.finishedRuns.get(agent.id) ?? [])];
    if (agent.isChiefOfStaff) finished.push(...state.counters.chiefReplies);
    finished.sort();
    // Replies counted before the capped list began still count.
    const extra = agent.isChiefOfStaff
      ? Math.max(
          0,
          state.counters.chiefRepliesTotal - state.counters.chiefReplies.length
        )
      : 0;
    dates.set(agent.id, finished);
    totalJobs += finished.length + extra;
  }
  const standing = new Map<string, PhoneStanding>();
  for (const agent of facts.agents) {
    const finished = dates.get(agent.id) ?? [];
    const extra = agent.isChiefOfStaff
      ? Math.max(
          0,
          state.counters.chiefRepliesTotal - state.counters.chiefReplies.length
        )
      : 0;
    const jobs = finished.length + extra;
    const created = Date.parse(agent.createdAt);
    const days = Number.isFinite(created)
      ? Math.max(0, Math.floor((now - created) / DAY_MS))
      : 0;
    const computedRank = rankFor(jobs, days);
    const stored = state.agents[agent.id]?.rank;
    // A rank once reached is kept.
    const rank =
      stored && RANKS.indexOf(stored) > RANKS.indexOf(computedRank)
        ? stored
        : computedRank;
    const next = RANK_RULES[RANKS.indexOf(rank)] ?? null;
    const moreJobs = next ? Math.max(0, next.jobs - jobs) : 0;
    const moreDays = next ? Math.max(0, next.days - days) : 0;
    const toNext = !next
      ? "Top rank"
      : jobs === 0
        ? "Give it a first job"
        : moreJobs > 0
          ? `${plural(moreJobs, "more job")} to ${next.rank}`
          : `${plural(moreDays, "more day")} together to ${next.rank}`;
    const progress = !next
      ? 1
      : next.days === 0
        ? Math.min(1, jobs / next.jobs)
        : Math.min(
            1,
            (Math.min(1, jobs / next.jobs) + Math.min(1, days / next.days)) / 2
          );
    const earned = state.agents[agent.id]?.milestones ?? {};
    // The date of the n-th finished job (replies older than the kept list have no date).
    const atJob = (n: number) =>
      jobs < n
        ? null
        : n > extra
          ? (finished[n - extra - 1] ?? facts.now.toISOString())
          : (finished[0] ?? facts.now.toISOString());
    const monthAt = Number.isFinite(created)
      ? new Date(created + 30 * DAY_MS).toISOString()
      : null;
    const milestones: PhoneMilestone[] = [
      {
        id: "first-job",
        title: "First job shipped",
        earnedAt: earned["first-job"] ?? (jobs >= 1 ? atJob(1) : null),
        remaining: null
      },
      {
        id: "ten-jobs",
        title: "10 jobs shipped",
        earnedAt: earned["ten-jobs"] ?? (jobs >= 10 ? atJob(10) : null),
        remaining: jobs < 10 ? `${10 - jobs} to go` : null
      },
      {
        id: "one-month",
        title: "One month together",
        earnedAt: earned["one-month"] ?? (days >= 30 ? monthAt : null),
        remaining:
          days < 30 ? `in ${30 - days} day${30 - days === 1 ? "" : "s"}` : null
      }
    ];
    const editionId =
      Object.entries(state.worn).find(
        ([, wearer]) => wearer === agent.id
      )?.[0] ?? null;
    standing.set(agent.id, {
      rank,
      nextRank: next?.rank ?? null,
      toNext,
      progress,
      jobsFinished: jobs,
      jobsThisWeek: finished.filter((at) => now - Date.parse(at) < 7 * DAY_MS)
        .length,
      daysTogether: days,
      milestones,
      editionId,
      ownLook: null
    });
  }
  return {
    standing,
    dates,
    metrics: {
      jobs: totalJobs,
      team: facts.agents.length,
      scheduled: facts.scheduledJobs,
      unblocks: state.counters.unblocks,
      asks: state.counters.asks
    }
  };
};

/** Compare what is true now with what was recorded: what's newly earned, and the state to keep. */
export const evaluateGamification = (
  facts: GamificationFacts,
  current: GamificationState
): { state: GamificationState; events: GamificationEvent[] } => {
  const state = structuredClone(current);
  const { standing, metrics } = compute(facts, state);
  const events: GamificationEvent[] = [];
  const quiet = !state.initialized;
  const nowIso = facts.now.toISOString();
  for (const agent of facts.agents) {
    const now = standing.get(agent.id)!;
    const record = (state.agents[agent.id] ??= {
      rank: "New recruit",
      milestones: {}
    });
    for (const milestone of now.milestones) {
      if (!milestone.earnedAt || record.milestones[milestone.id]) continue;
      record.milestones[milestone.id] = quiet ? milestone.earnedAt : nowIso;
      if (!quiet)
        events.push({
          kind: "milestone",
          agentId: agent.id,
          agentName: agent.name,
          title: milestone.title
        });
    }
    if (RANKS.indexOf(now.rank) > RANKS.indexOf(record.rank)) {
      record.rank = now.rank;
      if (!quiet)
        events.push({
          kind: "rank",
          agentId: agent.id,
          agentName: agent.name,
          rank: now.rank,
          jobs: now.jobsFinished
        });
    } else if (quiet) record.rank = now.rank;
  }
  for (const edition of EDITIONS) {
    if (state.editions[edition.id]) continue;
    if (metrics[edition.metric] < edition.target) continue;
    state.editions[edition.id] = { earnedAt: nowIso, seen: false };
    if (!quiet)
      events.push({
        kind: "edition",
        editionId: edition.id,
        name: edition.name
      });
  }
  // An Agent that no longer exists gives its edition back.
  const known = new Set(facts.agents.map((agent) => agent.id));
  for (const [editionId, agentId] of Object.entries(state.worn))
    if (!known.has(agentId)) delete state.worn[editionId];
  state.initialized = true;
  return { state, events };
};

/** Standings for every Agent, with the looks they show. */
export const standings = (
  facts: GamificationFacts,
  state: GamificationState
): Map<string, PhoneStanding> => compute(facts, state).standing;

export const collectionView = (
  facts: GamificationFacts,
  state: GamificationState
): PhoneCollection => {
  const { standing, metrics } = compute(facts, state);
  const editions: PhoneEdition[] = EDITIONS.map((edition) => {
    const earned = state.editions[edition.id];
    return {
      id: edition.id,
      name: edition.name,
      look: overlayLook(
        { seed: `koed-edition-${edition.id}` },
        edition.overlay
      ),
      rule: edition.rule,
      earned: Boolean(earned),
      earnedAt: earned?.earnedAt ?? null,
      isNew: Boolean(earned && !earned.seen),
      wornByAgentId: state.worn[edition.id] ?? null,
      progress:
        edition.target > 1
          ? {
              current: Math.min(edition.target, metrics[edition.metric]),
              target: edition.target
            }
          : null,
      memory: edition.memory === true
    };
  });
  const ordered = [...facts.agents].sort(
    (left, right) =>
      Number(right.isChiefOfStaff) - Number(left.isChiefOfStaff) ||
      left.createdAt.localeCompare(right.createdAt)
  );
  return {
    editions,
    agents: ordered.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      ...standing.get(agent.id)!
    })),
    remembered: facts.remembered
  };
};

export interface GamificationStore {
  read(): Promise<GamificationState>;
  update(
    change: (state: GamificationState) => GamificationState
  ): Promise<GamificationState>;
}

export const createGamificationStore = (
  secrets: PdsDesktopSecretStore,
  reference = PHONE_GAMIFICATION_SECRET_REFERENCE
): GamificationStore => {
  let cached: GamificationState | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const load = async () => {
    if (cached) return cached;
    const raw = await secrets.get(reference).catch(() => null);
    try {
      cached = raw ? stateSchema.parse(JSON.parse(raw)) : emptyState();
    } catch {
      // A damaged record only loses badges, never access.
      cached = emptyState();
    }
    return cached;
  };
  return {
    read: () => load().then((state) => structuredClone(state)),
    update(change) {
      const next = queue.then(async () => {
        const candidate = stateSchema.parse(
          change(structuredClone(await load()))
        );
        await secrets.put(reference, JSON.stringify(candidate));
        cached = candidate;
        return structuredClone(candidate);
      });
      queue = next.catch(() => undefined);
      return next;
    }
  };
};

/** Things the phone did that count towards editions. */
export const countPhoneAction = (
  state: GamificationState,
  action: "unblock" | "ask" | "chief_reply",
  at: Date
): GamificationState => {
  const next = structuredClone(state);
  if (action === "unblock") next.counters.unblocks++;
  else if (action === "ask") next.counters.asks++;
  else {
    next.counters.chiefReplies = [
      ...next.counters.chiefReplies,
      at.toISOString()
    ].slice(-400);
    next.counters.chiefRepliesTotal++;
  }
  return next;
};

/** Give an earned edition to one Agent (it leaves whoever wore it), or take it back. */
export const assignEdition = (
  state: GamificationState,
  editionId: string,
  agentId: string | null
): GamificationState => {
  if (!state.editions[editionId])
    throw new Error("That edition isn't earned yet.");
  const next = structuredClone(state);
  delete next.worn[editionId];
  if (agentId) {
    // One edition per Agent: what it wore before goes back to the collection.
    for (const [other, wearer] of Object.entries(next.worn))
      if (wearer === agentId) delete next.worn[other];
    next.worn[editionId] = agentId;
  }
  next.editions[editionId]!.seen = true;
  return next;
};

export const markEditionSeen = (
  state: GamificationState,
  editionId: string
): GamificationState => {
  const next = structuredClone(state);
  if (next.editions[editionId]) next.editions[editionId]!.seen = true;
  return next;
};
