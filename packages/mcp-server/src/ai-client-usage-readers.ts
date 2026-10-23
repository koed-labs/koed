import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AiClientUsageReading, AiClientUsageStatus } from "@koed/shared";

export const usageReadingPayload = (
  reading: AiClientUsageReading
): Omit<AiClientUsageReading, "instanceId" | "accountIdentityHash"> => ({
  source: reading.source,
  bucketId: reading.bucketId,
  bucketName: reading.bucketName,
  window: reading.window,
  windowDurationMins: reading.windowDurationMins,
  usedPercent: reading.usedPercent,
  status: reading.status,
  resetsAt: reading.resetsAt,
  planType: reading.planType,
  details: reading.details,
  observedAt: reading.observedAt
});

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableField = (
  source: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean
): boolean =>
  !Object.hasOwn(source, key) || source[key] === null || predicate(source[key]);
const integer = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value);
const validCodexCredits = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.hasCredits === "boolean" &&
    typeof value.unlimited === "boolean" &&
    nullableField(value, "balance", (item) => typeof item === "string")
  );
};
const validCodexIndividualLimit = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.limit === "string" &&
    typeof value.used === "string" &&
    integer(value.remainingPercent) &&
    integer(value.resetsAt)
  );
};
const validCodexResetCredit = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    integer(value.grantedAt) &&
    value.resetType === "codexRateLimits" &&
    ["available", "redeeming", "redeemed"].includes(
      typeof value.status === "string" ? value.status : ""
    ) &&
    nullableField(value, "title", (item) => typeof item === "string") &&
    nullableField(value, "description", (item) => typeof item === "string") &&
    nullableField(value, "expiresAt", integer)
  );
};
const validCodexResetCredits = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    integer(value.availableCount) &&
    (value.availableCount as number) >= 0 &&
    (!Object.hasOwn(value, "credits") ||
      value.credits === null ||
      (Array.isArray(value.credits) &&
        value.credits.every(validCodexResetCredit)))
  );
};
export const aiClientProfileScopeHash = (koedHome: string): string =>
  createHash("sha256").update(resolve(koedHome)).digest("hex");
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
const bool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const percent = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};
const epochSeconds = (value: unknown): string | null => {
  const n = number(value);
  return n !== null && n > 0 && n < 8_640_000_000_000
    ? new Date(n * 1000).toISOString()
    : null;
};
const pick = (
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  const source = record(value);
  return Object.fromEntries(keys.map((key) => [key, source[key] ?? null]));
};
const unknownKeys = (value: unknown, keys: readonly string[]): string[] =>
  Object.keys(record(value))
    .filter((key) => !keys.includes(key))
    .slice(0, 32);
const boundedJson = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= 8192
      ? JSON.parse(serialized)
      : "unknown";
  } catch {
    return "unknown";
  }
};
const codexBucketFields = [
  "credits",
  "individualLimit",
  "limitId",
  "limitName",
  "normalModelSlug",
  "planType",
  "primary",
  "rateLimitReachedType",
  "secondary",
  "spendControlReached"
];
const codexResponseFields = [
  "accountId",
  "ordinaryUsageAllowed",
  "rateLimitResetCredits",
  "rateLimitUpsell",
  "rateLimits",
  "rateLimitsByLimitId"
];
const codexWindowFields = ["usedPercent", "resetsAt", "windowDurationMins"];
const codexCreditsFields = ["hasCredits", "unlimited", "balance"];
const codexIndividualLimitFields = [
  "limit",
  "used",
  "remainingPercent",
  "resetsAt"
];
const codexPlanTypes = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "promax",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro"
]);
const codexReachedTypes = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);

/** Salt includes owner, backend, profile and instance; raw provider identity never persists. */
export const hashAiClientAccountIdentity = (
  namespace: {
    ownerId: string;
    backendId: string;
    profileId: string;
    instanceId: string;
    provider: string;
  },
  identity: string | null
): string | null =>
  identity
    ? createHash("sha256")
        .update(JSON.stringify([namespace, identity]))
        .digest("hex")
    : null;

export const codexAccountIdentity = (accountRead: unknown): string | null => {
  const account = record(record(accountRead).account);
  if (account.type !== "chatgpt") return null;
  return str(account.email)?.toLowerCase() ?? null;
};

export const claudeAccountIdentity = (accountInfo: unknown): string | null => {
  const account = record(accountInfo);
  const email = str(account.email)?.toLowerCase();
  if (!email) return null;
  return JSON.stringify([email, str(account.organization)]);
};

const codexWindow = (
  bucketId: string,
  bucketName: string | null,
  window: "primary" | "secondary",
  rawWindow: unknown,
  bucket: Record<string, unknown>,
  response: Record<string, unknown>,
  accountIdentityHash: string,
  instanceId: string,
  observedAt: string,
  knownBucket: boolean
): AiClientUsageReading | null => {
  if (rawWindow === null || rawWindow === undefined) return null;
  const source = record(rawWindow);
  const usedPercent = percent(source.usedPercent);
  const reached = bucket.rateLimitReachedType;
  const spendReached = bool(bucket.spendControlReached);
  const ordinaryAllowed = bool(response.ordinaryUsageAllowed);
  const knownReached =
    reached === null ||
    reached === undefined ||
    (typeof reached === "string" && codexReachedTypes.has(reached));
  const planType = str(bucket.planType);
  const duration = number(source.windowDurationMins);
  const validDuration =
    duration !== null && Number.isSafeInteger(duration) && duration > 0;
  const unknown =
    !knownBucket ||
    !knownReached ||
    !nullableField(
      bucket,
      "planType",
      (value) => typeof value === "string" && codexPlanTypes.has(value)
    ) ||
    !["limitId", "limitName", "normalModelSlug"].every((key) =>
      nullableField(bucket, key, (value) => typeof value === "string")
    ) ||
    !validCodexCredits(bucket.credits) ||
    !validCodexIndividualLimit(bucket.individualLimit) ||
    !nullableField(
      response,
      "accountId",
      (value) => typeof value === "string"
    ) ||
    !nullableField(response, "rateLimitsByLimitId", isRecord) ||
    !nullableField(response, "rateLimits", isRecord) ||
    !nullableField(response, "rateLimitResetCredits", validCodexResetCredits) ||
    unknownKeys(bucket, codexBucketFields).length > 0 ||
    unknownKeys(response, codexResponseFields).length > 0 ||
    unknownKeys(source, codexWindowFields).length > 0 ||
    unknownKeys(bucket.credits, codexCreditsFields).length > 0 ||
    unknownKeys(bucket.individualLimit, codexIndividualLimitFields).length >
      0 ||
    (Object.hasOwn(source, "usedPercent") && usedPercent === null) ||
    (Object.hasOwn(source, "resetsAt") &&
      source.resetsAt !== null &&
      (!integer(source.resetsAt) || epochSeconds(source.resetsAt) === null)) ||
    (Object.hasOwn(source, "windowDurationMins") &&
      source.windowDurationMins !== null &&
      !validDuration);
  const restriction =
    ordinaryAllowed === false ||
    spendReached === true ||
    (typeof reached === "string" && reached.length > 0);
  const complete =
    !unknown &&
    ordinaryAllowed !== null &&
    spendReached !== null &&
    usedPercent !== null;
  const status: AiClientUsageStatus = unknown
    ? "unknown"
    : restriction
      ? "limited"
      : complete
        ? usedPercent >= 90
          ? "near_limit"
          : "ok"
        : "unknown";
  return {
    instanceId,
    accountIdentityHash,
    source: "codex_app_server",
    bucketId,
    bucketName,
    window,
    windowDurationMins: validDuration ? duration : null,
    usedPercent,
    status,
    resetsAt: epochSeconds(source.resetsAt),
    planType: planType && codexPlanTypes.has(planType) ? planType : "unknown",
    details: {
      ordinaryUsageAllowed: ordinaryAllowed,
      rateLimitResetCredits: boundedJson(
        response.rateLimitResetCredits ?? null
      ),
      rateLimitUpsell: boundedJson(response.rateLimitUpsell ?? null),
      limitId: str(bucket.limitId),
      limitName: bucketName,
      normalModelSlug: str(bucket.normalModelSlug),
      rateLimitReachedType: knownReached ? (reached ?? null) : "unknown",
      spendControlReached: spendReached,
      credits: pick(bucket.credits, codexCreditsFields),
      individualLimit: pick(bucket.individualLimit, codexIndividualLimitFields),
      unknownFields: {
        bucket: unknownKeys(bucket, codexBucketFields),
        response: unknownKeys(response, codexResponseFields),
        window: unknownKeys(source, codexWindowFields),
        credits: unknownKeys(bucket.credits, codexCreditsFields),
        individualLimit: unknownKeys(
          bucket.individualLimit,
          codexIndividualLimitFields
        )
      }
    },
    observedAt
  };
};

export const codexUsageReadings = (
  raw: unknown,
  input: { accountIdentityHash: string; instanceId: string; observedAt: string }
): AiClientUsageReading[] => {
  const response = record(raw);
  const byLimitId = record(response.rateLimitsByLimitId);
  const candidates = Object.entries(byLimitId);
  if (response.rateLimits) {
    const defaultId = str(record(response.rateLimits).limitId) ?? "unknown";
    if (!Object.hasOwn(byLimitId, defaultId)) {
      candidates.push([defaultId, response.rateLimits]);
    }
  }
  if (candidates.length === 0 && response.ordinaryUsageAllowed === false) {
    candidates.push(["codex", { limitId: "codex" }]);
  }
  return candidates.flatMap(([key, value]) => {
    const bucket = record(value);
    const reportedId = str(bucket.limitId);
    const knownBucket = Boolean(
      reportedId && reportedId === key && key === "codex"
    );
    const id = str(key) ?? "unknown";
    const windows = (["primary", "secondary"] as const).flatMap((window) => {
      const reading = codexWindow(
        id,
        str(bucket.limitName),
        window,
        bucket[window],
        bucket,
        response,
        input.accountIdentityHash,
        input.instanceId,
        input.observedAt,
        knownBucket
      );
      return reading ? [reading] : [];
    });
    if (windows.length > 0) return windows;
    // A restriction without a window is still evidence; never lose the bucket.
    return [
      codexWindow(
        id,
        str(bucket.limitName),
        "primary",
        {},
        bucket,
        response,
        input.accountIdentityHash,
        input.instanceId,
        input.observedAt,
        knownBucket
      )!
    ].map((reading) => ({
      ...reading,
      window: "unknown",
      status:
        reading.status === "limited"
          ? ("limited" as const)
          : ("unknown" as const)
    }));
  });
};

const claudeLimitTypes = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage"
]);
const claudeStatuses = new Set(["allowed", "allowed_warning", "rejected"]);
const claudeDisabledReasons = new Set([
  "overage_not_provisioned",
  "org_level_disabled",
  "org_level_disabled_until",
  "out_of_credits",
  "seat_tier_level_disabled",
  "member_level_disabled",
  "seat_tier_zero_credit_limit",
  "group_zero_credit_limit",
  "member_zero_credit_limit",
  "org_service_level_disabled",
  "no_limits_configured",
  "fetch_error",
  "unknown"
]);
const claudeFields = [
  "status",
  "resetsAt",
  "rateLimitType",
  "utilization",
  "overageStatus",
  "overageResetsAt",
  "overageDisabledReason",
  "isUsingOverage",
  "overageInUse",
  "surpassedThreshold",
  "errorCode",
  "canUserPurchaseCredits",
  "hasChargeableSavedPaymentMethod"
] as const;

export const claudeUsageReading = (
  raw: unknown,
  input: { accountIdentityHash: string; instanceId: string; observedAt: string }
): AiClientUsageReading => {
  const info = record(raw);
  const type = str(info.rateLimitType);
  const status = str(info.status);
  const overageStatus = str(info.overageStatus);
  const disabledReason = str(info.overageDisabledReason);
  const errorCode = str(info.errorCode);
  const utilization = number(info.utilization);
  const invalidOptional =
    (Object.hasOwn(info, "utilization") &&
      (utilization === null || utilization < 0 || utilization > 1)) ||
    (Object.hasOwn(info, "resetsAt") && epochSeconds(info.resetsAt) === null) ||
    (Object.hasOwn(info, "overageResetsAt") &&
      epochSeconds(info.overageResetsAt) === null) ||
    (overageStatus !== null && !claudeStatuses.has(overageStatus)) ||
    (disabledReason !== null && !claudeDisabledReasons.has(disabledReason)) ||
    (errorCode !== null && errorCode !== "credits_required") ||
    unknownKeys(info, claudeFields).length > 0;
  const known = Boolean(
    type &&
    claudeLimitTypes.has(type) &&
    status &&
    claudeStatuses.has(status) &&
    !invalidOptional
  );
  const restricted =
    overageStatus === "rejected" ||
    disabledReason !== null ||
    errorCode !== null;
  const normalized: AiClientUsageStatus = !known
    ? "unknown"
    : restricted || status === "rejected"
      ? "limited"
      : status === "allowed_warning" || overageStatus === "allowed_warning"
        ? "near_limit"
        : "ok";
  return {
    ...input,
    source: "claude_agent_sdk",
    bucketId: "claude",
    bucketName: "Claude",
    window: type && claudeLimitTypes.has(type) ? type : "unknown",
    windowDurationMins: null,
    // SDK utilization is a fraction of the limit, unlike Codex's percentage.
    usedPercent: utilization === null ? null : percent(utilization * 100),
    status: normalized,
    resetsAt: epochSeconds(info.resetsAt),
    planType: null,
    details: {
      ...pick(info, claudeFields),
      status: status && claudeStatuses.has(status) ? status : "unknown",
      rateLimitType: type && claudeLimitTypes.has(type) ? type : "unknown",
      overageStatus:
        overageStatus === null
          ? null
          : claudeStatuses.has(overageStatus)
            ? overageStatus
            : "unknown",
      overageDisabledReason:
        disabledReason === null
          ? null
          : claudeDisabledReasons.has(disabledReason)
            ? disabledReason
            : "unknown",
      overageResetsAt: epochSeconds(info.overageResetsAt),
      unknownFields: unknownKeys(info, claudeFields)
    },
    observedAt: input.observedAt
  };
};
