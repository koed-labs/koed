"use client";

import type {
  AgentIdentityEditorValues,
  AgentModelCapability
} from "./agentIdentityEditor";
import type { AgentAvatar } from "./collab";

const BASE_PATH = "/studio-api/personal-agents";
const HOSTED_BASE_PATH = "/v1/personal-agents";
const MAX_AVATAR_JSON_LENGTH = 2_048;

function isHostedStudio(): boolean {
  if (typeof window === "undefined") return false;
  const pathname = window.location.pathname;
  return pathname === "/studio" || pathname.startsWith("/studio/");
}

export type PersonalAgentLifecycle = "active" | "retired";

export type PersonalAgentProject = Readonly<{
  id: string;
  name: string;
  status?: string | null;
  focus?: string | null;
  model?: string | null;
  effort?: string | null;
  startedAt?: number | null;
}>;

export type PersonalAgentAttempt = Readonly<{
  id: string;
  attemptNumber: number;
  provider: string | null;
  model: string | null;
  effort: string | null;
  instanceId: string | null;
  status: string;
  outcome: string | null;
  startedAt: number;
  completedAt: number | null;
}>;

export type PersonalAgentJob = Readonly<{
  id: string;
  title: string;
  goal?: string | null;
  conversationId?: string | null;
  agentName?: string | null;
  agentVersion?: number | null;
  projectId?: string | null;
  projectName?: string | null;
  state: string;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  summary?: string | null;
  attempts: readonly PersonalAgentAttempt[];
}>;

export type PersonalAgentHighlight = Readonly<{
  id: string;
  title: string;
  projectName?: string | null;
  at: number;
  summary?: string | null;
}>;

export type PersonalAgentLiveJob = Readonly<{
  id: string;
  title: string;
  goal: string | null;
  conversationId: string | null;
  projectId: string | null;
  projectName: string | null;
  state: string;
  updatedAt: number;
}>;

export type PersonalAgentActivityProject = Readonly<{
  id: string;
  name: string;
  status: string | null;
  startedAt: number | null;
}>;

export type PersonalAgentProjectSummary = Readonly<{
  projects: readonly PersonalAgentActivityProject[];
  count: number | null;
  truncated: boolean;
}>;

export type PersonalAgentActivity = Readonly<{
  agentId: string;
  status: "running" | "idle" | "unknown";
  availability: "available" | "unavailable" | "unsupported";
  freshness: "fresh" | "stale" | "unknown";
  observedAt: number | null;
  runningAttempts: number | null;
  persistedRunningAttempts: number | null;
  activeJobs: readonly PersonalAgentLiveJob[];
  activeJobsCount: number | null;
  activeJobsTruncated: boolean;
  projectSummary?: PersonalAgentProjectSummary | null;
}>;

export type PersonalAgentJobPage = Readonly<{
  jobs: readonly PersonalAgentJob[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type PersonalAgent = Readonly<{
  id: string;
  ownerId: string;
  name: string;
  role: string;
  soul: string;
  avatar?: AgentAvatar;
  lifecycle: PersonalAgentLifecycle;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
  projects: readonly PersonalAgentProject[];
  runningNow: readonly PersonalAgentJob[];
  /** False when the service omitted verified live job details and the parser fell back to history. */
  runningJobsVerified?: boolean;
  jobs: readonly PersonalAgentJob[];
  highlights: readonly PersonalAgentHighlight[];
  stats: Readonly<{
    projects: number | null;
    runningNow: number | null;
    jobsLogged: number | null;
  }> | null;
  jobsHasMore: boolean;
  jobsNextCursor: string | null;
  /** Cached older pages may sit beyond an unqueried gap after a fresh head. */
  jobsHistoryGapAfterId?: string | null;
  activityLoaded: boolean;
  activitySummary?: PersonalAgentActivity;
  sourceTemplateId: string | null;
  sourceTemplateVersion: number | null;
}>;

export type PersonalAgentsApi = Readonly<{
  list: (signal?: AbortSignal) => Promise<PersonalAgent[]>;
  get: (id: string, signal?: AbortSignal) => Promise<PersonalAgent>;
  activity: (
    ids: readonly string[],
    signal?: AbortSignal
  ) => Promise<PersonalAgentActivity[]>;
  getJobs: (
    id: string,
    before: string,
    signal?: AbortSignal
  ) => Promise<PersonalAgentJobPage>;
  capabilities: (signal?: AbortSignal) => Promise<AgentModelCapability[]>;
  create: (
    values: AgentIdentityEditorValues,
    options?: PersonalAgentWriteOptions
  ) => Promise<PersonalAgent>;
  update: (
    id: string,
    expectedVersion: number,
    values: AgentIdentityEditorValues,
    options?: PersonalAgentWriteOptions
  ) => Promise<PersonalAgent>;
  retire: (
    id: string,
    expectedVersion: number,
    options?: PersonalAgentWriteOptions
  ) => Promise<PersonalAgent>;
  restore: (
    id: string,
    expectedVersion: number,
    options?: PersonalAgentWriteOptions
  ) => Promise<PersonalAgent>;
  draftScope?: (signal?: AbortSignal) => Promise<PersonalAgentDraftScope>;
}>;

export type PersonalAgentDraftScope = Readonly<{
  ownerId: string;
  backendId: string;
}>;

export function personalAgentDraftKey(
  scope: PersonalAgentDraftScope | null,
  target: string
): string | null {
  if (!scope?.ownerId.trim() || !scope.backendId.trim()) return null;
  const part = (value: string) => encodeURIComponent(value.trim());
  return `koed.studio.personal-agent-draft.v1:${part(scope.backendId)}:${part(scope.ownerId)}:${part(target)}`;
}

export type PersonalAgentWriteOptions = Readonly<{
  signal?: AbortSignal;
  requestId?: string;
}>;

export class PersonalAgentsHttpError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "PersonalAgentsHttpError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`The agent service returned no ${label}.`);
  return result;
}

function timestamp(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`The agent service returned an invalid ${label}.`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return timestamp(value, "timestamp");
}

export function parseAvatar(value: unknown): AgentAvatar | undefined {
  if (
    isRecord(value) &&
    typeof value.seed === "number" &&
    isRecord(value.spec)
  ) {
    return {
      seed: value.seed,
      spec: value.spec,
      image: typeof value.image === "string" ? value.image : ""
    };
  }
  if (typeof value !== "string" || value.length > MAX_AVATAR_JSON_LENGTH)
    return undefined;
  try {
    return parseAvatar(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function serializeAvatar(avatar: AgentAvatar | undefined): string | null {
  if (!avatar) return null;
  // The PNG is a display cache. Persist the redrawable Pixelkin spec so the
  // bounded avatar reference remains useful after a restart.
  const serialized = JSON.stringify({ seed: avatar.seed, spec: avatar.spec });
  if (serialized.length > MAX_AVATAR_JSON_LENGTH) {
    throw new Error("The avatar is too large to save.");
  }
  return serialized;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function parseProject(value: unknown): PersonalAgentProject {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid project.");
  return {
    id: requiredText(value.id ?? value.projectId, "project id"),
    name: requiredText(value.name ?? value.projectName, "project name"),
    status: text(value.status),
    focus: text(value.focus),
    model: text(value.model),
    effort: text(value.effort),
    startedAt: nullableTimestamp(value.startedAt)
  };
}

function parseAttempt(value: unknown): PersonalAgentAttempt {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid attempt.");
  const attemptNumber = value.attemptNumber;
  if (typeof attemptNumber !== "number" || !Number.isInteger(attemptNumber)) {
    throw new Error("The agent service returned an invalid attempt number.");
  }
  return {
    id: requiredText(value.id, "attempt id"),
    attemptNumber,
    provider: text(value.provider),
    model: text(value.model),
    effort: text(value.reasoningEffort ?? value.effort),
    instanceId: text(value.aiClientInstanceId ?? value.instanceId),
    status: requiredText(value.status ?? value.state, "attempt status"),
    outcome: text(value.outcome),
    startedAt: timestamp(value.startedAt, "attempt startedAt"),
    completedAt: nullableTimestamp(value.completedAt)
  };
}

function parseJob(value: unknown): PersonalAgentJob {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid job.");
  const attribution = isRecord(value.attribution) ? value.attribution : {};
  const attemptsValue = arrayValue(value.attempts);
  const attempts = attemptsValue ? attemptsValue.map(parseAttempt) : [];
  const latestAttemptValue = isRecord(value.latestAttempt)
    ? value.latestAttempt
    : attempts[0];
  const latestAttempt = latestAttemptValue
    ? isRecord(latestAttemptValue)
      ? parseAttempt(latestAttemptValue)
      : latestAttemptValue
    : null;
  return {
    id: requiredText(value.id, "job id"),
    title: text(value.title ?? value.objective) ?? "Untitled job",
    goal: text(value.goal),
    conversationId: text(value.conversationId),
    agentName: text(value.agentName ?? attribution.agentName),
    agentVersion:
      typeof attribution.agentVersion === "number"
        ? attribution.agentVersion
        : typeof value.agentVersion === "number"
          ? value.agentVersion
          : null,
    projectId: text(value.projectId),
    projectName: text(value.projectName),
    state: requiredText(value.state ?? value.status, "job state"),
    provider: text(
      value.provider ?? value.actualProvider ?? latestAttempt?.provider
    ),
    model: text(value.model ?? value.actualModel ?? latestAttempt?.model),
    effort: text(
      value.effort ?? value.reasoningEffort ?? latestAttempt?.effort
    ),
    createdAt: timestamp(value.createdAt, "job createdAt"),
    startedAt: nullableTimestamp(value.startedAt),
    completedAt: nullableTimestamp(value.completedAt),
    summary: text(value.summary ?? value.outcome),
    attempts
  };
}

function parseHighlight(value: unknown): PersonalAgentHighlight {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid highlight.");
  return {
    id: requiredText(value.id, "highlight id"),
    title: requiredText(value.title, "highlight title"),
    projectName: text(value.projectName),
    at: timestamp(value.at ?? value.completedAt, "highlight timestamp"),
    summary: text(value.summary ?? value.outcome)
  };
}

function nullableCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`The agent service returned an invalid ${label}.`);
  }
  return value;
}

function parseLiveJob(value: unknown): PersonalAgentLiveJob {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid live job.");
  return {
    id: requiredText(value.id, "live job id"),
    title: requiredText(value.title, "live job title"),
    goal: text(value.goal),
    conversationId: text(value.conversationId),
    projectId: text(value.projectId),
    projectName: text(value.projectName),
    state: requiredText(value.state, "live job state"),
    updatedAt: timestamp(value.updatedAt, "live job updatedAt")
  };
}

function parseActivityProject(value: unknown): PersonalAgentActivityProject {
  if (!isRecord(value)) {
    throw new Error("The agent service returned an invalid project summary.");
  }
  return {
    id: requiredText(value.id, "activity project id"),
    name: requiredText(value.name, "activity project name"),
    status: text(value.status),
    startedAt: nullableTimestamp(value.startedAt)
  };
}

function parseProjectSummary(value: unknown): PersonalAgentProjectSummary {
  if (!isRecord(value) || !Array.isArray(value.projects)) {
    throw new Error("The agent service returned an invalid project summary.");
  }
  if (value.projects.length > 5 || typeof value.truncated !== "boolean") {
    throw new Error("The agent service returned invalid project coverage.");
  }
  return {
    projects: value.projects.map(parseActivityProject),
    count: nullableCount(value.count, "project count"),
    truncated: value.truncated
  };
}

function parseActivity(value: unknown): PersonalAgentActivity {
  if (!isRecord(value))
    throw new Error("The agent service returned invalid activity.");
  const status = value.status;
  const availability = value.availability;
  const freshness = value.freshness;
  if (status !== "running" && status !== "idle" && status !== "unknown") {
    throw new Error("The agent service returned invalid activity status.");
  }
  if (
    availability !== "available" &&
    availability !== "unavailable" &&
    availability !== "unsupported"
  ) {
    throw new Error(
      "The agent service returned invalid activity availability."
    );
  }
  if (
    freshness !== "fresh" &&
    freshness !== "stale" &&
    freshness !== "unknown"
  ) {
    throw new Error("The agent service returned invalid activity freshness.");
  }
  const activeJobsValue = arrayValue(value.activeJobs);
  if (!activeJobsValue) {
    throw new Error("The agent service returned invalid live jobs.");
  }
  if (typeof value.activeJobsTruncated !== "boolean") {
    throw new Error("The agent service returned invalid live job coverage.");
  }
  const projectSummary =
    value.projectSummary === undefined
      ? undefined
      : value.projectSummary === null
        ? null
        : parseProjectSummary(value.projectSummary);
  return {
    agentId: requiredText(value.agentId, "activity agent id"),
    status,
    availability,
    freshness,
    observedAt: nullableTimestamp(value.observedAt),
    runningAttempts: nullableCount(
      value.runningAttempts,
      "running attempt count"
    ),
    persistedRunningAttempts: nullableCount(
      value.persistedRunningAttempts,
      "persisted running attempt count"
    ),
    activeJobs: activeJobsValue.map(parseLiveJob),
    activeJobsCount: nullableCount(value.activeJobsCount, "live job count"),
    activeJobsTruncated: value.activeJobsTruncated,
    ...(projectSummary === undefined ? {} : { projectSummary })
  };
}

function parseJobPage(value: unknown): PersonalAgentJobPage {
  if (
    !isRecord(value) ||
    value.contractVersion !== 1 ||
    !Array.isArray(value.jobs)
  ) {
    throw new Error("The agent service returned invalid job history.");
  }
  if (typeof value.hasMore !== "boolean") {
    throw new Error("The agent service returned invalid job history paging.");
  }
  if (value.hasMore && !text(value.nextCursor)) {
    throw new Error("The agent service returned invalid job history paging.");
  }
  return {
    jobs: value.jobs.map(parseJob),
    hasMore: value.hasMore,
    nextCursor: text(value.nextCursor)
  };
}

function parseAgent(
  value: unknown,
  activity: Record<string, unknown> = {}
): PersonalAgent {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid agent.");
  const soul =
    text(
      value.soulInstructions ??
        value.soul ??
        value.identity ??
        activity.soulInstructions
    ) ?? "";
  const projectsValue = arrayValue(activity.projects ?? value.projects);
  const jobsValue = arrayValue(activity.jobs ?? value.jobs ?? value.jobHistory);
  const runningValue =
    arrayValue(activity.runningNow ?? value.runningNow) ??
    (jobsValue
      ? jobsValue.filter(
          (job) =>
            isRecord(job) &&
            (job.state === "running" || job.status === "running")
        )
      : undefined);
  const highlightsValue = arrayValue(activity.highlights ?? value.highlights);
  const rawStats = activity.stats ?? value.stats;
  const statsValue: Record<string, unknown> | null = isRecord(rawStats)
    ? rawStats
    : null;
  const projectsAvailable = statsValue?.projectsAvailable;
  const projects =
    projectsAvailable === false
      ? null
      : typeof statsValue?.projects === "number"
        ? statsValue.projects
        : null;
  const runningNow =
    statsValue?.runningAttemptsMayBeStale === true
      ? null
      : typeof statsValue?.runningNow === "number"
        ? statsValue.runningNow
        : null;
  const jobsLogged =
    typeof statsValue?.totalJobs === "number"
      ? statsValue.totalJobs
      : typeof statsValue?.jobsLogged === "number"
        ? statsValue.jobsLogged
        : null;
  return {
    id: requiredText(value.id, "agent id"),
    // Public API responses are owner-scoped and intentionally omit the owner
    // identifier; the UI never uses it to authorize or address an agent.
    ownerId: text(value.ownerUserId ?? value.ownerId) ?? "",
    name: requiredText(value.name, "agent name"),
    role: text(value.role) ?? "",
    soul,
    avatar: parseAvatar(value.avatar ?? value.avatarReference),
    lifecycle: value.lifecycle === "retired" ? "retired" : "active",
    defaultProvider: text(value.defaultProvider ?? value.provider),
    defaultModel: text(value.defaultModel ?? value.preferredModel),
    defaultReasoningEffort: text(
      value.defaultReasoningEffort ?? value.preferredEffort
    ),
    sourceTemplateId: text(activity.sourceTemplateId),
    sourceTemplateVersion:
      typeof activity.sourceTemplateVersion === "number"
        ? activity.sourceTemplateVersion
        : null,
    currentVersion:
      typeof value.currentVersion === "number" ? value.currentVersion : 0,
    createdAt: timestamp(value.createdAt, "agent createdAt"),
    updatedAt: timestamp(value.updatedAt ?? value.createdAt, "agent updatedAt"),
    retiredAt: nullableTimestamp(value.retiredAt),
    projects: projectsValue ? projectsValue.map(parseProject) : [],
    runningNow: runningValue ? runningValue.map(parseJob) : [],
    runningJobsVerified:
      Array.isArray(activity.runningNow) || Array.isArray(value.runningNow),
    jobs: jobsValue ? jobsValue.map(parseJob) : [],
    highlights: highlightsValue ? highlightsValue.map(parseHighlight) : [],
    stats: statsValue
      ? {
          projects,
          runningNow,
          jobsLogged
        }
      : null,
    jobsHasMore:
      value.jobsHasMore === true ||
      value.jobsHasMore === 1 ||
      activity.jobsHasMore === true ||
      activity.jobsHasMore === 1 ||
      statsValue?.jobsHasMore === true ||
      statsValue?.jobsHasMore === 1,
    jobsNextCursor: text(value.jobsNextCursor ?? activity.jobsNextCursor),
    activityLoaded: Boolean(
      projectsValue ||
      runningValue ||
      jobsValue ||
      highlightsValue ||
      statsValue
    )
  };
}

function unwrapAgentPayload(value: unknown): {
  agent: unknown;
  activity: Record<string, unknown>;
} {
  if (!isRecord(value))
    throw new Error("The agent service returned an invalid response.");
  if (isRecord(value.agent)) return { agent: value.agent, activity: value };
  return { agent: value, activity: value };
}

function parseAgentList(value: unknown): PersonalAgent[] {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    throw new Error("The agent service returned an invalid agent list.");
  }
  return value.agents.map((agent) => parseAgent(agent));
}

function parseCapabilities(value: unknown): AgentModelCapability[] {
  if (!isRecord(value)) {
    throw new Error("The agent service returned invalid model capabilities.");
  }
  const entries = value.models ?? value.capabilities;
  if (!Array.isArray(entries)) {
    throw new Error("The agent service returned invalid model capabilities.");
  }
  return entries.map((item) => {
    if (!isRecord(item))
      throw new Error("The agent service returned invalid model capabilities.");
    const provider = requiredText(item.provider, "model provider");
    const id = requiredText(item.id ?? item.model, "model id");
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter(
          (effort): effort is string =>
            typeof effort === "string" && Boolean(effort.trim())
        )
      : [];
    return {
      provider,
      id,
      supportedReasoningEfforts: efforts,
      ...(text(item.displayName)
        ? { displayName: text(item.displayName) ?? undefined }
        : {}),
      ...(text(item.instanceId)
        ? { instanceId: text(item.instanceId) ?? undefined }
        : {})
    };
  });
}

function splitModelOption(value: string | null): {
  provider: string | null;
  model: string | null;
} {
  if (!value) return { provider: null, model: null };
  const separator = value?.indexOf(":") ?? -1;
  if (!value || separator <= 0 || separator === value.length - 1) {
    throw new Error("Choose a supported model before saving the agent.");
  }
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1)
  };
}

export function personalAgentRequestId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function safeMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const message = text(value.error ?? value.message);
  return message ? message.replace(/[\r\n]+/g, " ").slice(0, 280) : fallback;
}

async function assertOk(
  response: Response,
  fallback: string
): Promise<unknown> {
  const payload = await readJson(response);
  if (!response.ok) {
    throw new PersonalAgentsHttpError(
      safeMessage(payload, fallback),
      response.status,
      isRecord(payload) ? (text(payload.code) ?? undefined) : undefined
    );
  }
  return payload;
}

async function csrfToken(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/studio-api/github/session", {
    credentials: "include",
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal
  });
  const payload = await assertOk(response, "Studio session is unavailable.");
  if (!isRecord(payload) || typeof payload.csrfToken !== "string") {
    throw new Error("Studio session is unavailable. Refresh and try again.");
  }
  return payload.csrfToken;
}

async function call(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<unknown> {
  const hosted = isHostedStudio();
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    if (!hosted) headers.set("x-studio-csrf", await csrfToken(signal));
  }
  const route =
    path.startsWith("/studio-api/") || path.startsWith("/v1/")
      ? path
      : `${hosted ? HOSTED_BASE_PATH : BASE_PATH}${path}`;
  const response = await fetch(route, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "include",
    redirect: "error",
    signal
  });
  return assertOk(response, "The agent service is unavailable.");
}

function editorPayload(
  values: AgentIdentityEditorValues,
  expectedVersion?: number,
  writeRequestId?: string
) {
  const model = splitModelOption(values.preferredModel);
  return {
    name: values.name,
    role: values.role,
    soulInstructions: values.soul,
    avatarReference: serializeAvatar(values.avatar),
    defaultProvider: model.provider,
    defaultModel: model.model,
    defaultReasoningEffort: values.preferredEffort,
    ...(values.sourceTemplateId !== null &&
    values.sourceTemplateVersion !== null
      ? {
          sourceTemplateId: values.sourceTemplateId,
          sourceTemplateVersion: values.sourceTemplateVersion
        }
      : {}),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    requestId: writeRequestId ?? personalAgentRequestId()
  };
}

export const personalAgentsHttpAdapter: PersonalAgentsApi = Object.freeze({
  async list(signal) {
    return parseAgentList(await call("", {}, signal));
  },
  async get(id, signal) {
    const parsed = unwrapAgentPayload(
      await call(`/${encodeURIComponent(id)}`, {}, signal)
    );
    return parseAgent(parsed.agent, parsed.activity);
  },
  async activity(ids, signal) {
    if (ids.length < 1 || ids.length > 100) {
      throw new Error("Request activity for between 1 and 100 agents.");
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("Agent activity requests cannot contain duplicate IDs.");
    }
    const query = new URLSearchParams();
    for (const id of ids) query.append("agentId", id);
    const path = isHostedStudio()
      ? `/v1/personal-agents/activity?${query.toString()}`
      : `/studio-api/personal-agents/activity?${query.toString()}`;
    const payload = await call(path, {}, signal);
    if (
      !isRecord(payload) ||
      payload.contractVersion !== 1 ||
      !Array.isArray(payload.activity)
    ) {
      throw new Error("The agent service returned invalid activity.");
    }
    const activity = payload.activity.map(parseActivity);
    const requested = new Set(ids);
    if (activity.some((item) => !requested.has(item.agentId))) {
      throw new Error("The agent service returned out-of-scope activity.");
    }
    if (
      new Set(activity.map((item) => item.agentId)).size !== activity.length
    ) {
      throw new Error("The agent service returned duplicate activity.");
    }
    return activity;
  },
  async getJobs(id, before, signal) {
    const query = new URLSearchParams({ limit: "20", before });
    return parseJobPage(
      await call(
        `/${encodeURIComponent(id)}/jobs?${query.toString()}`,
        {},
        signal
      )
    );
  },
  async capabilities(signal) {
    return parseCapabilities(await call("/capabilities", {}, signal));
  },
  async draftScope(signal) {
    const value = await call(
      isHostedStudio()
        ? "/v1/managed-conversations/access"
        : "/studio-api/managed-conversations/access",
      {},
      signal
    );
    if (
      !isRecord(value) ||
      !isRecord(value.user) ||
      typeof value.user.id !== "string" ||
      typeof value.backendId !== "string"
    ) {
      throw new Error("The signed-in agent draft scope is unavailable.");
    }
    return {
      ownerId: requiredText(value.user.id, "owner id"),
      backendId: requiredText(value.backendId, "backend id")
    };
  },
  async create(values, options) {
    const parsed = unwrapAgentPayload(
      await call(
        "",
        {
          method: "POST",
          body: JSON.stringify(
            editorPayload(values, undefined, options?.requestId)
          )
        },
        options?.signal
      )
    );
    return parseAgent(parsed.agent, parsed.activity);
  },
  async update(id, expectedVersion, values, options) {
    const parsed = unwrapAgentPayload(
      await call(
        `/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            editorPayload(values, expectedVersion, options?.requestId)
          )
        },
        options?.signal
      )
    );
    return parseAgent(parsed.agent, parsed.activity);
  },
  async retire(id, expectedVersion, options) {
    const parsed = unwrapAgentPayload(
      await call(
        `/${encodeURIComponent(id)}/retire`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion,
            requestId: options?.requestId ?? personalAgentRequestId()
          })
        },
        options?.signal
      )
    );
    return parseAgent(parsed.agent, parsed.activity);
  },
  async restore(id, expectedVersion, options) {
    const parsed = unwrapAgentPayload(
      await call(
        `/${encodeURIComponent(id)}/restore`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion,
            requestId: options?.requestId ?? personalAgentRequestId()
          })
        },
        options?.signal
      )
    );
    return parseAgent(parsed.agent, parsed.activity);
  }
});

export function agentEditorInitialValues(agent: PersonalAgent): {
  name: string;
  role: string;
  soul: string;
  avatar?: AgentAvatar;
  preferredModel: string | null;
  preferredEffort: string | null;
  sourceTemplateId: string | null;
  sourceTemplateVersion: number | null;
} {
  return {
    name: agent.name,
    role: agent.role,
    soul: agent.soul,
    avatar: agent.avatar,
    preferredModel:
      agent.defaultProvider && agent.defaultModel
        ? `${agent.defaultProvider}:${agent.defaultModel}`
        : null,
    preferredEffort: agent.defaultReasoningEffort,
    sourceTemplateId: agent.sourceTemplateId,
    sourceTemplateVersion: agent.sourceTemplateVersion
  };
}

export function uniqueAgentCloneName(
  sourceName: string,
  existingNames: readonly string[]
): string {
  const base = `${sourceName.trim() || "Agent"} copy`;
  const normalizedNames = new Set(
    existingNames.map((name) => name.trim().toLocaleLowerCase())
  );
  if (!normalizedNames.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!normalizedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

// Shared Studio requests keep the existing session and native CSRF authority.
export { call as studioAuthenticatedRequest };
