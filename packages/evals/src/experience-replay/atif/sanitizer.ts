import { createHash } from "node:crypto";

export const ATIF_SCHEMA_VERSION = "ATIF-v1.7" as const;

interface Limits {
  rawBytes: number;
  nestingDepth: number;
  steps: number;
  nestedValues: number;
  stringBytes: number;
  allowedTextBytes: number;
  allowedTextTokens: number;
}

export const ATIF_SANITIZATION_LIMITS: Readonly<Limits> = {
  rawBytes: 256 * 1024 * 1024,
  nestingDepth: 32,
  steps: 100_000,
  nestedValues: 1_000_000,
  stringBytes: 16 * 1024 * 1024,
  allowedTextBytes: 128 * 1024 * 1024,
  allowedTextTokens: 8_000_000
};
type JsonObject = Record<string, unknown>;
type CredentialType =
  | "API_KEY"
  | "BEARER_TOKEN"
  | "PASSWORD"
  | "SESSION_COOKIE"
  | "PRIVATE_KEY"
  | "DSN";

export interface AtifCutoffAttestation {
  adapterName: "harbor-codex";
  adapterVersion: string;
  rawReasoningCaptureDisabled: true;
  agentPhaseEndedOrdinal: number;
  trajectoryMaterializedOrdinal: number;
  verificationStartedOrdinal: number;
  stepLastNativeEventOrdinals: readonly number[];
  agentPhaseEndedAt?: string;
}

export interface HarborFreezeManifest {
  schema_version: "koed-harbor-freeze-v1";
  adapter: {
    name: "harbor-codex";
    version: string;
    commit: string;
    raw_reasoning_capture_disabled: true;
  };
  source_attempt: { trial_id: string; task_name: string };
  lifecycle: readonly {
    ordinal: number;
    event:
      | "agent_started"
      | "agent_ended"
      | "trajectory_materialized"
      | "verification_started";
    timestamp: string;
  }[];
  cutoff: {
    agent_last_native_event_ordinal: number | null;
    step_identities: readonly {
      step_id: number;
      identity_sha256: string;
      last_native_event_ordinal: number | null;
    }[];
  };
  frozen_artifact: {
    relative_path: string;
    sha256: string;
    size_bytes: number;
    file_identity: {
      device: number;
      inode: number;
    };
  };
}

export interface AtifSanitizationOptions {
  taskDigest: string;
  sourceAttemptId: string;
  freezeManifest?: HarborFreezeManifest;
  /** @deprecated Rejected at runtime; cutoff evidence must come from freezeManifest. */
  cutoff?: AtifCutoffAttestation;
  countEmbeddingTokens: (text: string) => number;
  limits?: Partial<Limits>;
}

export interface SanitizedAtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: JsonObject;
}

export interface SanitizedAtifResult {
  source_call_id: string;
  content: string;
}

export interface SanitizedAtifStep {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  message: string;
  reasoning_content?: string;
  tool_calls?: SanitizedAtifToolCall[];
  observation?: { results: SanitizedAtifResult[] };
}

export interface SanitizedAtifTrajectory {
  schema_version: typeof ATIF_SCHEMA_VERSION;
  session_id?: string;
  trajectory_id?: string;
  agent: { name: "codex"; version: string };
  steps: SanitizedAtifStep[];
}

export type NormalizedTranscriptType =
  | "system_message"
  | "user_message"
  | "agent_message"
  | "reasoning_summary"
  | "tool_call"
  | "tool_result";

export interface NormalizedTranscriptItem {
  adapterName: "harbor-atif";
  adapterVersion: "1.0.0";
  sourceIdentity: string;
  atifIdentity: string;
  sequence: number;
  stepId: number;
  timestamp: string | null;
  type: NormalizedTranscriptType;
  content?: string;
  toolCall?: SanitizedAtifToolCall;
  sourceCallId?: string;
}

export interface AtifSanitizationManifest {
  inputSha256: string;
  outputSha256: string | null;
  schemaVersion: string | null;
  allowedFieldCounts: Record<string, number>;
  removedFieldCounts: Record<string, number>;
  redactionCounts: Partial<Record<CredentialType, number>>;
  limitUsage: {
    rawBytes: number;
    nestingDepth: number;
    steps: number;
    nestedValues: number;
    largestStringBytes: number;
    allowedTextBytes: number;
    allowedTextTokens: number;
  };
  cutoffAttested: boolean;
  rejectionReason: string | null;
}

export interface AtifSanitizationResult {
  trajectory: SanitizedAtifTrajectory;
  normalizedItems: NormalizedTranscriptItem[];
  manifest: AtifSanitizationManifest;
  canonicalJson: string;
}

export interface SanitizedAtifMaterializationOptions {
  taskDigest: string;
  sourceAttemptId: string;
  sourceManifest: AtifSanitizationManifest;
}

export class AtifSanitizationError extends Error {
  override readonly name = "AtifSanitizationError";

  constructor(
    readonly reason: string,
    readonly manifest: AtifSanitizationManifest
  ) {
    super(`ATIF sanitization rejected: ${reason}`);
  }
}

class Reject extends Error {}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value as JsonObject)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize((value as JsonObject)[key])}`
    )
    .join(",")}}`;
};

class StrictJsonParser {
  private position = 0;
  values = 0;
  maxDepth = 0;
  largestStringBytes = 0;

  constructor(
    private readonly text: string,
    private readonly limits: Limits
  ) {}

  parse(): unknown {
    const value = this.parseValue(0);
    this.space();
    if (this.position !== this.text.length) this.reject("INVALID_JSON");
    return value;
  }

  private reject(reason: string): never {
    throw new Reject(reason);
  }

  private space(): void {
    while (/\s/.test(this.text[this.position] ?? "")) this.position += 1;
  }

  private count(depth: number): void {
    this.values += 1;
    this.maxDepth = Math.max(this.maxDepth, depth);
    if (this.values > this.limits.nestedValues)
      this.reject("NESTED_VALUE_LIMIT");
    if (depth > this.limits.nestingDepth) this.reject("NESTING_DEPTH_LIMIT");
  }

  private parseValue(depth: number): unknown {
    this.space();
    this.count(depth);
    const char = this.text[this.position];
    if (char === "{") return this.parseObject(depth + 1);
    if (char === "[") return this.parseArray(depth + 1);
    if (char === '"') return this.parseString();
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null]
    ] as const) {
      if (this.text.startsWith(literal, this.position)) {
        this.position += literal.length;
        return value;
      }
    }
    const start = this.position;
    if (this.text.charCodeAt(this.position) === 0x2d) this.position += 1;
    if (this.text.charCodeAt(this.position) === 0x30) {
      this.position += 1;
      if (this.isDigit(this.text.charCodeAt(this.position)))
        this.reject("INVALID_JSON");
    } else {
      if (!this.isNonZeroDigit(this.text.charCodeAt(this.position)))
        this.reject("INVALID_JSON");
      while (this.isDigit(this.text.charCodeAt(this.position)))
        this.position += 1;
    }
    if (this.text.charCodeAt(this.position) === 0x2e) {
      this.position += 1;
      if (!this.isDigit(this.text.charCodeAt(this.position)))
        this.reject("INVALID_JSON");
      while (this.isDigit(this.text.charCodeAt(this.position)))
        this.position += 1;
    }
    const exponent = this.text.charCodeAt(this.position);
    if (exponent === 0x65 || exponent === 0x45) {
      this.position += 1;
      const sign = this.text.charCodeAt(this.position);
      if (sign === 0x2b || sign === 0x2d) this.position += 1;
      if (!this.isDigit(this.text.charCodeAt(this.position)))
        this.reject("INVALID_JSON");
      while (this.isDigit(this.text.charCodeAt(this.position)))
        this.position += 1;
    }
    const number = Number(this.text.substring(start, this.position));
    if (!Number.isFinite(number)) this.reject("NON_FINITE_NUMBER");
    return number;
  }

  private isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
  }

  private isNonZeroDigit(code: number): boolean {
    return code >= 0x31 && code <= 0x39;
  }

  private parseString(): string {
    const start = this.position;
    this.position += 1;
    let escaped = false;
    while (this.position < this.text.length) {
      const code = this.text.charCodeAt(this.position);
      if (!escaped && code === 0x22) {
        this.position += 1;
        let value: string;
        try {
          value = JSON.parse(this.text.slice(start, this.position)) as string;
        } catch {
          this.reject("INVALID_JSON_STRING");
        }
        if (/\p{Surrogate}/u.test(value)) this.reject("INVALID_UNICODE_SCALAR");
        const bytes = utf8Bytes(value);
        this.largestStringBytes = Math.max(this.largestStringBytes, bytes);
        if (bytes > this.limits.stringBytes) this.reject("STRING_LIMIT");
        return value;
      }
      if (!escaped && code < 0x20) this.reject("INVALID_JSON_STRING");
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.position += 1;
    }
    return this.reject("UNTERMINATED_JSON_STRING");
  }

  private parseObject(depth: number): JsonObject {
    this.position += 1;
    this.space();
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();
    if (this.text[this.position] === "}") {
      this.position += 1;
      return {};
    }
    while (true) {
      this.space();
      if (this.text[this.position] !== '"') this.reject("INVALID_OBJECT_KEY");
      const key = this.parseString();
      if (keys.has(key)) this.reject("DUPLICATE_OBJECT_KEY");
      keys.add(key);
      this.space();
      if (this.text[this.position] !== ":") this.reject("INVALID_JSON");
      this.position += 1;
      entries.push([key, this.parseValue(depth)]);
      this.space();
      const char = this.text[this.position];
      this.position += 1;
      if (char === "}") return Object.fromEntries(entries);
      if (char !== ",") this.reject("INVALID_JSON");
    }
  }

  private parseArray(depth: number): unknown[] {
    this.position += 1;
    this.space();
    const values: unknown[] = [];
    if (this.text[this.position] === "]") {
      this.position += 1;
      return values;
    }
    while (true) {
      values.push(this.parseValue(depth));
      this.space();
      const char = this.text[this.position];
      this.position += 1;
      if (char === "]") return values;
      if (char !== ",") this.reject("INVALID_JSON");
    }
  }
}

const exactKeys = (
  object: JsonObject,
  allowed: readonly string[],
  where: string
) => {
  const set = new Set(allowed);
  for (const key of Object.keys(object)) {
    // Never place an attacker-controlled key (which may itself be a secret) in
    // the rejection reason or manifest.
    if (!set.has(key)) throw new Reject(`UNKNOWN_FIELD:${where}`);
  }
};

const requireString = (value: unknown, reason: string): string => {
  if (typeof value !== "string") throw new Reject(reason);
  return value;
};

const requireNonEmpty = (value: unknown, reason: string): string => {
  const string = requireString(value, reason);
  if (string.length === 0) throw new Reject(reason);
  return string;
};

const isJsonInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const validateOptionalNumericFields = (
  object: JsonObject,
  integerFields: readonly string[],
  numberFields: readonly string[],
  arrayFields: Readonly<Record<string, "integer" | "number">>,
  reason: string
): void => {
  for (const field of integerFields) {
    const value = object[field];
    if (value !== undefined && value !== null && !isJsonInteger(value)) {
      throw new Reject(reason);
    }
  }
  for (const field of numberFields) {
    const value = object[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Reject(reason);
    }
  }
  for (const [field, kind] of Object.entries(arrayFields)) {
    const value = object[field];
    if (value === undefined || value === null) continue;
    if (
      !Array.isArray(value) ||
      value.some((item) =>
        kind === "integer"
          ? !isJsonInteger(item)
          : typeof item !== "number" || !Number.isFinite(item)
      )
    ) {
      throw new Reject(reason);
    }
  }
};

const validateMetrics = (value: JsonObject): void => {
  exactKeys(
    value,
    [
      "prompt_tokens",
      "completion_tokens",
      "cached_tokens",
      "cost_usd",
      "prompt_token_ids",
      "completion_token_ids",
      "logprobs",
      "extra"
    ],
    "metrics"
  );
  validateOptionalNumericFields(
    value,
    ["prompt_tokens", "completion_tokens", "cached_tokens"],
    ["cost_usd"],
    {
      prompt_token_ids: "integer",
      completion_token_ids: "integer",
      logprobs: "number"
    },
    "INVALID_METRICS"
  );
  if (
    value.extra !== undefined &&
    value.extra !== null &&
    !isObject(value.extra)
  ) {
    throw new Reject("INVALID_METRICS");
  }
};

const validateFinalMetrics = (value: JsonObject): void => {
  exactKeys(
    value,
    [
      "total_prompt_tokens",
      "total_completion_tokens",
      "total_cached_tokens",
      "total_cost_usd",
      "total_steps",
      "extra"
    ],
    "final_metrics"
  );
  validateOptionalNumericFields(
    value,
    [
      "total_prompt_tokens",
      "total_completion_tokens",
      "total_cached_tokens",
      "total_steps"
    ],
    ["total_cost_usd"],
    {},
    "INVALID_FINAL_METRICS"
  );
  if (
    (typeof value.total_steps === "number" && value.total_steps < 0) ||
    (value.extra !== undefined &&
      value.extra !== null &&
      !isObject(value.extra))
  ) {
    throw new Reject("INVALID_FINAL_METRICS");
  }
};

const parseIso = (value: string, reason: string): number => {
  // Date.parse accepts non-ISO forms, so first require the complete ISO shape.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  ) {
    throw new Reject(reason);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Reject(reason);
  return epoch;
};

const credentialKeyType = (key: string): CredentialType | null => {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (
    /^(?:authorization|proxy_authorization|bearer_token|access_token|auth_token)$/.test(
      normalized
    )
  ) {
    return "BEARER_TOKEN";
  }
  if (
    /^(?:cookie|cookies|set_cookie|session_cookie|sessionid|session_id)$/.test(
      normalized
    )
  ) {
    return "SESSION_COOKIE";
  }
  if (
    /^(?:password|passwd|passphrase|client_secret|proxy_password|aws_secret_access_key|secret)$/.test(
      normalized
    )
  ) {
    return "PASSWORD";
  }
  if (
    /^(?:api_key|apikey|x_api_key|openai_api_key|aws_access_key_id|npm_token|npm_auth_token|slack_token|github_token|gh_token|koed_api_token|koed_token)$/.test(
      normalized
    )
  ) {
    return "API_KEY";
  }
  if (/^(?:private_key|ssh_private_key|signing_key)$/.test(normalized))
    return "PRIVATE_KEY";
  if (/^(?:dsn|database_url|connection_string)$/.test(normalized)) return "DSN";
  return null;
};

const isJwt = (value: string): boolean => {
  const segments = value.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => !/^[A-Za-z0-9_-]{8,8192}$/u.test(segment))
  ) {
    return false;
  }
  try {
    const header = JSON.parse(
      Buffer.from(segments[0]!, "base64url").toString("utf8")
    ) as unknown;
    return (
      typeof header === "object" &&
      header !== null &&
      !Array.isArray(header) &&
      (typeof (header as Record<string, unknown>).alg === "string" ||
        (header as Record<string, unknown>).typ === "JWT")
    );
  } catch {
    return false;
  }
};

const containsJwt = (value: string): boolean =>
  (
    value.match(
      /[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,8192}/gu
    ) ?? []
  ).some(isJwt);

const exactCredentialType = (value: string): CredentialType | null => {
  if (/^Bearer\s+\S{8,}$/i.test(value)) return "BEARER_TOKEN";
  if (
    /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----$/.test(
      value
    )
  )
    return "PRIVATE_KEY";
  if (isJwt(value)) {
    return "BEARER_TOKEN";
  }
  if (
    /^(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{16}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|koed_(?:live_)?[A-Za-z0-9][A-Za-z0-9_-]{7,})$/.test(
      value
    )
  ) {
    return "API_KEY";
  }
  return null;
};

const containsCredential = (value: string): boolean =>
  /(?:Bearer\s+\S{8,}|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|(?<![A-Za-z0-9])(?:(?:sk-(?:proj-)?|github_pat_|gh[pousr]_|AKIA|npm_|xox[baprs]-)[A-Za-z0-9_-]{8,}|koed_(?:live_)?[A-Za-z0-9][A-Za-z0-9_-]{7,}))/i.test(
    value
  ) ||
  containsJwt(value) ||
  /(?:https?|socks5?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i.test(
    value
  ) ||
  /(?:^|[\s;])(?:x-api-key|proxy-authorization|aws[_-]secret[_-]access[_-]key|npm[_-](?:auth[_-])?token|slack[_-]token|github[_-]token|koed[_-](?:api[_-])?token|set-cookie)\s*[:=]\s*(?:(?:Basic|Bearer)\s+)?\S{8,}/i.test(
    value
  ) ||
  /(?:^|[;\s])(?:session(?:id)?|auth|token|jwt)=[^;\s]{8,}(?:;|$)/i.test(value);

const containsProhibitedPath = (value: string): boolean => {
  // Require path syntax before matching sensitive components. Ordinary prose
  // such as "run the hidden tests" is intentionally not classified as a path.
  const paths = value.match(
    /(?:file:\/\/|(?:^|[\s"'=(]))(?:\.{0,2}\/|\/[A-Za-z0-9_.-]|[A-Za-z]:\\)[^\s"'<>)]*/g
  );
  if (paths === null) return false;
  return paths.some((candidate) => {
    const normalized = candidate
      .replace(/^.*?(?=file:\/\/|\.{0,2}\/|\/|[A-Za-z]:\\)/, "")
      .replace(/^file:\/\//i, "")
      .replace(/\\/g, "/");
    const components = normalized.split("/").filter(Boolean);
    return components.some((component, index) => {
      const lower = component.toLowerCase();
      return (
        /^(?:\.?hidden[-_]?tests?|private[-_]?tests?|held[-_]?out[-_]?tests?)$/.test(
          lower
        ) ||
        /^(?:reference[-_]?)?solutions?$/.test(lower) ||
        lower === "gold.patch" ||
        (lower === "verifier" &&
          components[index - 1]?.toLowerCase() === "logs") ||
        lower === "tests"
      );
    });
  });
};

class SanitizationContext {
  readonly redactionCounts: Partial<Record<CredentialType, number>> = {};
  readonly allowedFieldCounts: Record<string, number> = {};
  readonly removedFieldCounts: Record<string, number> = {};
  allowedTextBytes = 0;
  allowedTextTokens = 0;

  constructor(
    private readonly limits: Limits,
    private readonly countEmbeddingTokens: (text: string) => number
  ) {}

  allowed(field: string): void {
    this.allowedFieldCounts[field] = (this.allowedFieldCounts[field] ?? 0) + 1;
  }

  removed(field: string, object: JsonObject): void {
    const sourceField = field.slice(field.lastIndexOf(".") + 1);
    if (Object.hasOwn(object, sourceField)) {
      this.removedFieldCounts[field] =
        (this.removedFieldCounts[field] ?? 0) + 1;
    }
  }

  text(value: string): string {
    if (containsCredential(value))
      throw new Reject("UNSAFE_EMBEDDED_CREDENTIAL");
    if (containsProhibitedPath(value)) throw new Reject("PROHIBITED_PATH");
    this.allowedTextBytes += utf8Bytes(value);
    const tokens = this.countEmbeddingTokens(value);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Reject("INVALID_TOKENIZER_COUNT");
    }
    this.allowedTextTokens += tokens;
    if (this.allowedTextBytes > this.limits.allowedTextBytes) {
      throw new Reject("ALLOWED_TEXT_LIMIT");
    }
    if (this.allowedTextTokens > this.limits.allowedTextTokens) {
      throw new Reject("ALLOWED_TOKEN_LIMIT");
    }
    return value;
  }

  redact(type: CredentialType): string {
    const ordinal = (this.redactionCounts[type] ?? 0) + 1;
    this.redactionCounts[type] = ordinal;
    return this.text(`[REDACTED_${type}_${ordinal}]`);
  }

  contentText(value: string): string {
    const exactType = exactCredentialType(value);
    return exactType === null ? this.text(value) : this.redact(exactType);
  }

  sanitizeJson(value: unknown, key?: string): unknown {
    const keyedType = key === undefined ? null : credentialKeyType(key);
    if (keyedType !== null) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Reject("UNSAFE_CREDENTIAL_VALUE");
      }
      return this.redact(keyedType);
    }
    if (typeof value === "string") {
      const exactType = exactCredentialType(value);
      return exactType === null ? this.text(value) : this.redact(exactType);
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeJson(item));
    }
    if (!isObject(value)) throw new Reject("NON_JSON_ARGUMENT");
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => {
        if (containsCredential(entryKey) || containsProhibitedPath(entryKey)) {
          throw new Reject("UNSAFE_JSON_PROPERTY_NAME");
        }
        return [entryKey, this.sanitizeJson(entryValue, entryKey)];
      })
    );
  }
}

const resolvedLimits = (overrides: Partial<Limits> | undefined): Limits =>
  Object.fromEntries(
    Object.entries(ATIF_SANITIZATION_LIMITS).map(([key, maximum]) => {
      const override = overrides?.[key as keyof Limits];
      if (
        override !== undefined &&
        (!Number.isSafeInteger(override) || override <= 0)
      ) {
        throw new Reject("INVALID_LIMIT_OVERRIDE");
      }
      return [key, Math.min(maximum, override ?? maximum)];
    })
  ) as unknown as Limits;

const validateFreezeManifest = (
  manifest: HarborFreezeManifest | undefined,
  inputSha256: string,
  inputBytes: number,
  steps: readonly JsonObject[]
): void => {
  if (manifest === undefined) throw new Reject("MISSING_FREEZE_MANIFEST");
  if (!isObject(manifest)) throw new Reject("INVALID_FREEZE_MANIFEST");
  exactKeys(
    manifest,
    [
      "schema_version",
      "adapter",
      "source_attempt",
      "lifecycle",
      "cutoff",
      "frozen_artifact"
    ],
    "freeze_manifest"
  );
  if (manifest.schema_version !== "koed-harbor-freeze-v1")
    throw new Reject("INVALID_FREEZE_MANIFEST");
  if (!isObject(manifest.adapter)) throw new Reject("INVALID_ADAPTER_IDENTITY");
  exactKeys(
    manifest.adapter,
    ["name", "version", "commit", "raw_reasoning_capture_disabled"],
    "freeze_adapter"
  );
  if (
    manifest.adapter.name !== "harbor-codex" ||
    typeof manifest.adapter.version !== "string" ||
    manifest.adapter.version.length === 0 ||
    !/^[a-f0-9]{40}$/.test(manifest.adapter.commit) ||
    manifest.adapter.raw_reasoning_capture_disabled !== true
  ) {
    throw new Reject("INVALID_ADAPTER_IDENTITY");
  }
  if (!isObject(manifest.source_attempt))
    throw new Reject("INVALID_SOURCE_ATTEMPT_IDENTITY");
  exactKeys(
    manifest.source_attempt,
    ["trial_id", "task_name"],
    "freeze_source_attempt"
  );
  if (
    typeof manifest.source_attempt.trial_id !== "string" ||
    manifest.source_attempt.trial_id.length === 0 ||
    typeof manifest.source_attempt.task_name !== "string" ||
    !manifest.source_attempt.task_name.startsWith("terminal-bench/")
  ) {
    throw new Reject("INVALID_SOURCE_ATTEMPT_IDENTITY");
  }
  if (!isObject(manifest.frozen_artifact))
    throw new Reject("INVALID_FROZEN_ARTIFACT");
  exactKeys(
    manifest.frozen_artifact,
    ["relative_path", "sha256", "size_bytes", "file_identity"],
    "frozen_artifact"
  );
  if (
    typeof manifest.frozen_artifact.relative_path !== "string" ||
    manifest.frozen_artifact.relative_path.length === 0 ||
    manifest.frozen_artifact.relative_path.startsWith("/") ||
    manifest.frozen_artifact.relative_path.split(/[\\/]/).includes("..") ||
    manifest.frozen_artifact.sha256 !== `sha256:${inputSha256}` ||
    manifest.frozen_artifact.size_bytes !== inputBytes ||
    !isObject(manifest.frozen_artifact.file_identity)
  ) {
    throw new Reject("FROZEN_ARTIFACT_MISMATCH");
  }
  exactKeys(
    manifest.frozen_artifact.file_identity,
    ["device", "inode"],
    "frozen_file_identity"
  );
  if (
    !isJsonInteger(manifest.frozen_artifact.file_identity.device) ||
    manifest.frozen_artifact.file_identity.device < 0 ||
    !isJsonInteger(manifest.frozen_artifact.file_identity.inode) ||
    manifest.frozen_artifact.file_identity.inode < 1
  ) {
    throw new Reject("INVALID_FILE_IDENTITY");
  }

  if (!Array.isArray(manifest.lifecycle) || manifest.lifecycle.length !== 4)
    throw new Reject("INVALID_LIFECYCLE_ORDER");
  const lifecycle: unknown[] = manifest.lifecycle;
  const expectedEvents = [
    "agent_started",
    "agent_ended",
    "trajectory_materialized",
    "verification_started"
  ] as const;
  let previousTime = -Infinity;
  const lifecycleTimes: number[] = [];
  for (let index = 0; index < expectedEvents.length; index += 1) {
    const event = lifecycle[index];
    if (!isObject(event)) throw new Reject("INVALID_LIFECYCLE_ORDER");
    exactKeys(event, ["ordinal", "event", "timestamp"], "lifecycle_event");
    if (event.ordinal !== index + 1 || event.event !== expectedEvents[index])
      throw new Reject("INVALID_LIFECYCLE_ORDER");
    const timestamp = parseIso(
      requireString(event.timestamp, "INVALID_LIFECYCLE_ORDER"),
      "INVALID_LIFECYCLE_ORDER"
    );
    if (timestamp < previousTime) throw new Reject("INVALID_LIFECYCLE_ORDER");
    previousTime = timestamp;
    lifecycleTimes.push(timestamp);
  }

  if (!isObject(manifest.cutoff)) throw new Reject("INVALID_CUTOFF_PROOF");
  exactKeys(
    manifest.cutoff,
    ["agent_last_native_event_ordinal", "step_identities"],
    "freeze_cutoff"
  );
  const agentNative = manifest.cutoff.agent_last_native_event_ordinal;
  if (
    agentNative !== null &&
    (!isJsonInteger(agentNative) || agentNative < 1)
  ) {
    throw new Reject("INVALID_CUTOFF_PROOF");
  }
  if (
    !Array.isArray(manifest.cutoff.step_identities) ||
    manifest.cutoff.step_identities.length !== steps.length
  ) {
    throw new Reject("INCOMPLETE_CUTOFF_ATTESTATION");
  }
  const stepIdentities: unknown[] = manifest.cutoff.step_identities;
  let previousNative = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const identity = stepIdentities[index];
    if (!isObject(identity)) throw new Reject("INVALID_CUTOFF_PROOF");
    exactKeys(
      identity,
      ["step_id", "identity_sha256", "last_native_event_ordinal"],
      "step_identity"
    );
    const native = identity.last_native_event_ordinal;
    if (native !== null && !isJsonInteger(native)) {
      throw new Reject("POST_AGENT_NATIVE_EVENT");
    }
    if (
      identity.step_id !== index + 1 ||
      identity.identity_sha256 !==
        `sha256:${sha256(`${index + 1}:${native === null ? "none" : native}`)}`
    ) {
      throw new Reject("INVALID_STEP_IDENTITY");
    }
    if (
      native !== null &&
      (native <= previousNative || agentNative === null || native > agentNative)
    ) {
      throw new Reject("POST_AGENT_NATIVE_EVENT");
    }
    if (native !== null) previousNative = native;
  }
  const endedAt = lifecycleTimes[1]!;
  for (const step of steps) {
    if (
      typeof step.timestamp === "string" &&
      parseIso(step.timestamp, "INVALID_STEP_TIMESTAMP") > endedAt
    ) {
      throw new Reject("POST_AGENT_STEP_TIMESTAMP");
    }
  }
};

const sanitizeTrajectory = (
  root: JsonObject,
  options: AtifSanitizationOptions,
  context: SanitizationContext,
  limits: Limits,
  inputSha256: string,
  inputBytes: number
): SanitizedAtifTrajectory => {
  exactKeys(
    root,
    [
      "schema_version",
      "session_id",
      "trajectory_id",
      "agent",
      "steps",
      "notes",
      "final_metrics",
      "continued_trajectory_ref",
      "extra",
      "subagent_trajectories"
    ],
    "root"
  );
  if (root.schema_version !== ATIF_SCHEMA_VERSION)
    throw new Reject("UNSUPPORTED_SCHEMA");
  if (Object.hasOwn(root, "continued_trajectory_ref"))
    throw new Reject("CONTINUATION_TRAJECTORY");
  if (Object.hasOwn(root, "subagent_trajectories"))
    throw new Reject("EMBEDDED_SUBAGENT_TRAJECTORY");
  context.allowed("root.schema_version");
  context.allowed("root.agent");
  context.allowed("root.steps");
  for (const field of ["notes", "final_metrics", "extra"] as const)
    context.removed(`root.${field}`, root);

  if (!isObject(root.agent)) throw new Reject("INVALID_AGENT");
  exactKeys(
    root.agent,
    ["name", "version", "model_name", "tool_definitions", "extra"],
    "agent"
  );
  if (root.agent.name !== "codex") throw new Reject("UNSUPPORTED_AGENT");
  const agentVersion = context.text(
    requireNonEmpty(root.agent.version, "INVALID_AGENT_VERSION")
  );
  if (
    (root.agent.model_name !== undefined &&
      root.agent.model_name !== null &&
      typeof root.agent.model_name !== "string") ||
    (root.agent.tool_definitions !== undefined &&
      root.agent.tool_definitions !== null &&
      !Array.isArray(root.agent.tool_definitions)) ||
    (root.agent.extra !== undefined &&
      root.agent.extra !== null &&
      !isObject(root.agent.extra))
  ) {
    throw new Reject("INVALID_AGENT_METADATA");
  }
  context.allowed("agent.name");
  context.allowed("agent.version");
  for (const field of ["model_name", "tool_definitions", "extra"] as const)
    context.removed(`agent.${field}`, root.agent);

  if (!Array.isArray(root.steps) || root.steps.length === 0)
    throw new Reject("INVALID_STEPS");
  if (root.steps.length > limits.steps) throw new Reject("STEP_LIMIT");
  const rawSteps = root.steps.map((step) => {
    if (!isObject(step)) throw new Reject("INVALID_STEP");
    return step;
  });
  validateFreezeManifest(
    options.freezeManifest,
    inputSha256,
    inputBytes,
    rawSteps
  );

  if (
    (root.notes !== undefined &&
      root.notes !== null &&
      typeof root.notes !== "string") ||
    (root.final_metrics !== undefined &&
      root.final_metrics !== null &&
      !isObject(root.final_metrics)) ||
    (root.extra !== undefined && root.extra !== null && !isObject(root.extra))
  ) {
    throw new Reject("INVALID_REMOVED_ROOT_FIELD");
  }
  if (isObject(root.final_metrics)) validateFinalMetrics(root.final_metrics);

  const seenCalls = new Map<string, number>();
  let previousTimestamp = -Infinity;
  const steps: SanitizedAtifStep[] = rawSteps.map((step, index) => {
    exactKeys(
      step,
      [
        "step_id",
        "timestamp",
        "source",
        "model_name",
        "reasoning_effort",
        "message",
        "reasoning_content",
        "tool_calls",
        "observation",
        "metrics",
        "is_copied_context",
        "llm_call_count",
        "extra"
      ],
      `steps[${index}]`
    );
    if (step.step_id !== index + 1) throw new Reject("NON_SEQUENTIAL_STEP_ID");
    if (
      step.source !== "system" &&
      step.source !== "user" &&
      step.source !== "agent"
    ) {
      throw new Reject("UNKNOWN_STEP_SOURCE");
    }
    if (typeof step.message !== "string")
      throw new Reject("MULTIMODAL_MESSAGE");
    context.allowed("step.step_id");
    context.allowed("step.source");
    context.allowed("step.message");
    for (const field of [
      "model_name",
      "reasoning_effort",
      "metrics",
      "is_copied_context",
      "llm_call_count",
      "extra"
    ] as const) {
      context.removed(`step.${field}`, step);
    }

    const sanitized: SanitizedAtifStep = {
      step_id: index + 1,
      source: step.source,
      message: context.contentText(step.message)
    };
    if (step.timestamp !== undefined && step.timestamp !== null) {
      const timestamp = requireString(step.timestamp, "INVALID_STEP_TIMESTAMP");
      const epoch = parseIso(timestamp, "INVALID_STEP_TIMESTAMP");
      if (epoch < previousTimestamp)
        throw new Reject("NON_MONOTONIC_TIMESTAMP");
      previousTimestamp = epoch;
      sanitized.timestamp = context.text(timestamp);
      context.allowed("step.timestamp");
    }

    const agentOnlyPresent = [
      "reasoning_content",
      "tool_calls",
      "observation"
    ].some((field) => Object.hasOwn(step, field) && step[field] !== null);
    if (step.source !== "agent" && agentOnlyPresent)
      throw new Reject("AGENT_FIELD_ON_NON_AGENT_STEP");
    const modelFieldsPresent = [
      "model_name",
      "reasoning_effort",
      "metrics"
    ].some((field) => Object.hasOwn(step, field) && step[field] !== null);
    if (step.source !== "agent" && modelFieldsPresent) {
      throw new Reject("AGENT_FIELD_ON_NON_AGENT_STEP");
    }
    if (
      (step.model_name !== undefined &&
        step.model_name !== null &&
        typeof step.model_name !== "string") ||
      (step.reasoning_effort !== undefined &&
        step.reasoning_effort !== null &&
        typeof step.reasoning_effort !== "string" &&
        typeof step.reasoning_effort !== "number") ||
      (step.metrics !== undefined &&
        step.metrics !== null &&
        !isObject(step.metrics)) ||
      (step.extra !== undefined &&
        step.extra !== null &&
        !isObject(step.extra)) ||
      (step.is_copied_context !== undefined &&
        step.is_copied_context !== null &&
        typeof step.is_copied_context !== "boolean") ||
      (step.llm_call_count !== undefined &&
        step.llm_call_count !== null &&
        (typeof step.llm_call_count !== "number" ||
          !Number.isSafeInteger(step.llm_call_count) ||
          step.llm_call_count < 0))
    ) {
      throw new Reject("INVALID_STEP_METADATA");
    }
    if (isObject(step.metrics)) validateMetrics(step.metrics);
    if (
      step.source === "agent" &&
      step.llm_call_count === 0 &&
      (step.reasoning_content !== undefined || step.metrics !== undefined)
    ) {
      throw new Reject("INVALID_DETERMINISTIC_AGENT_STEP");
    }
    if (step.source === "agent" && typeof step.reasoning_content === "string") {
      sanitized.reasoning_content = context.contentText(step.reasoning_content);
      context.allowed("step.reasoning_content");
    } else if (
      step.reasoning_content !== undefined &&
      step.reasoning_content !== null
    ) {
      throw new Reject("INVALID_REASONING_CONTENT");
    }

    const calls: SanitizedAtifToolCall[] = [];
    if (step.tool_calls !== undefined && step.tool_calls !== null) {
      if (!Array.isArray(step.tool_calls))
        throw new Reject("INVALID_TOOL_CALLS");
      const rawCalls = step.tool_calls as unknown[];
      context.allowed("step.tool_calls");
      for (let callIndex = 0; callIndex < rawCalls.length; callIndex += 1) {
        const call = rawCalls[callIndex];
        if (!isObject(call)) throw new Reject("INVALID_TOOL_CALL");
        exactKeys(
          call,
          ["tool_call_id", "function_name", "arguments", "extra"],
          `tool_call`
        );
        const id = context.text(
          requireNonEmpty(call.tool_call_id, "INVALID_TOOL_CALL_ID")
        );
        if (seenCalls.has(id)) throw new Reject("DUPLICATE_TOOL_CALL_ID");
        seenCalls.set(id, index + 1);
        const name = context.text(
          requireNonEmpty(call.function_name, "INVALID_TOOL_NAME")
        );
        if (!isObject(call.arguments))
          throw new Reject("INVALID_TOOL_ARGUMENTS");
        if (
          call.extra !== undefined &&
          call.extra !== null &&
          !isObject(call.extra)
        ) {
          throw new Reject("INVALID_TOOL_CALL_EXTRA");
        }
        calls.push({
          tool_call_id: id,
          function_name: name,
          arguments: context.sanitizeJson(call.arguments) as JsonObject
        });
        context.allowed("tool_call.tool_call_id");
        context.allowed("tool_call.function_name");
        context.allowed("tool_call.arguments");
        context.removed("tool_call.extra", call);
      }
      sanitized.tool_calls = calls;
    }

    if (step.observation !== undefined && step.observation !== null) {
      if (!isObject(step.observation)) throw new Reject("INVALID_OBSERVATION");
      exactKeys(step.observation, ["results"], "observation");
      if (!Array.isArray(step.observation.results))
        throw new Reject("INVALID_RESULTS");
      const rawResults = step.observation.results as unknown[];
      context.allowed("step.observation");
      context.allowed("observation.results");
      const resultIds = new Set<string>();
      const results: SanitizedAtifResult[] = rawResults.map((result) => {
        if (!isObject(result)) throw new Reject("INVALID_TOOL_RESULT");
        exactKeys(
          result,
          ["source_call_id", "content", "subagent_trajectory_ref", "extra"],
          "result"
        );
        if (Object.hasOwn(result, "subagent_trajectory_ref"))
          throw new Reject("SUBAGENT_TRAJECTORY_REFERENCE");
        if (
          result.extra !== undefined &&
          result.extra !== null &&
          !isObject(result.extra)
        ) {
          throw new Reject("INVALID_TOOL_RESULT_EXTRA");
        }
        const id = context.text(
          requireNonEmpty(result.source_call_id, "UNLINKED_TOOL_RESULT")
        );
        if (seenCalls.get(id) !== index + 1)
          throw new Reject("UNRESOLVED_OR_CROSS_STEP_CALL_ID");
        if (resultIds.has(id)) throw new Reject("DUPLICATE_TOOL_RESULT_ID");
        resultIds.add(id);
        if (typeof result.content !== "string")
          throw new Reject("MULTIMODAL_TOOL_RESULT");
        context.allowed("result.source_call_id");
        context.allowed("result.content");
        context.removed("result.extra", result);
        return {
          source_call_id: id,
          content: context.contentText(result.content)
        };
      });
      if (calls.some((call) => !resultIds.has(call.tool_call_id))) {
        throw new Reject("MISSING_TOOL_RESULT");
      }
      sanitized.observation = { results };
    } else if (calls.length > 0) {
      throw new Reject("MISSING_TOOL_RESULT");
    }
    return sanitized;
  });

  const output: SanitizedAtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: "codex", version: agentVersion },
    steps
  };
  for (const field of ["session_id", "trajectory_id"] as const) {
    const value = root[field];
    if (value !== undefined && value !== null) {
      output[field] = context.text(
        requireNonEmpty(value, `INVALID_${field.toUpperCase()}`)
      );
      context.allowed(`root.${field}`);
    }
  }
  return output;
};

const normalizedItems = (
  trajectory: SanitizedAtifTrajectory,
  taskDigest: string,
  sourceAttemptId: string
): NormalizedTranscriptItem[] => {
  const items: NormalizedTranscriptItem[] = [];
  const append = (
    step: SanitizedAtifStep,
    atifIdentity: string,
    type: NormalizedTranscriptType,
    fields: Pick<
      NormalizedTranscriptItem,
      "content" | "toolCall" | "sourceCallId"
    >
  ) => {
    const sequence = items.length;
    const identityInput = canonicalize({
      taskDigest,
      sourceAttemptId,
      atifIdentity,
      sequence
    });
    items.push({
      adapterName: "harbor-atif",
      adapterVersion: "1.0.0",
      sourceIdentity: `harbor-atif:1.0.0:${sha256(identityInput)}`,
      atifIdentity,
      sequence,
      stepId: step.step_id,
      timestamp: step.timestamp ?? null,
      type,
      ...fields
    });
  };

  for (const step of trajectory.steps) {
    if (step.message.length > 0) {
      append(
        step,
        `step:${step.step_id}:message`,
        step.source === "system"
          ? "system_message"
          : step.source === "user"
            ? "user_message"
            : "agent_message",
        { content: step.message }
      );
    }
    if (
      step.reasoning_content !== undefined &&
      step.reasoning_content.length > 0
    ) {
      append(step, `step:${step.step_id}:reasoning`, "reasoning_summary", {
        content: step.reasoning_content
      });
    }
    for (let index = 0; index < (step.tool_calls?.length ?? 0); index += 1) {
      const call = step.tool_calls![index]!;
      append(
        step,
        `step:${step.step_id}:tool_call:${index}:${call.tool_call_id}`,
        "tool_call",
        {
          toolCall: call,
          sourceCallId: call.tool_call_id
        }
      );
    }
    for (
      let index = 0;
      index < (step.observation?.results.length ?? 0);
      index += 1
    ) {
      const result = step.observation!.results[index]!;
      append(
        step,
        `step:${step.step_id}:tool_result:${index}:${result.source_call_id}`,
        "tool_result",
        {
          content: result.content,
          sourceCallId: result.source_call_id
        }
      );
    }
  }
  return items;
};

/**
 * Re-materializes an already sanitized trajectory after a structural
 * projection. This deliberately does not inspect or redact content: callers
 * may only supply the sanitizer's allowlisted trajectory type.
 */
export const materializeSanitizedAtifTrajectory = (
  trajectory: SanitizedAtifTrajectory,
  options: SanitizedAtifMaterializationOptions
): AtifSanitizationResult => {
  const canonicalJson = canonicalize(trajectory);
  const manifest: AtifSanitizationManifest = {
    ...options.sourceManifest,
    allowedFieldCounts: { ...options.sourceManifest.allowedFieldCounts },
    removedFieldCounts: { ...options.sourceManifest.removedFieldCounts },
    redactionCounts: { ...options.sourceManifest.redactionCounts },
    limitUsage: {
      ...options.sourceManifest.limitUsage,
      steps: trajectory.steps.length
    },
    outputSha256: sha256(canonicalJson)
  };
  return {
    trajectory,
    normalizedItems: normalizedItems(
      trajectory,
      requireNonEmpty(options.taskDigest, "INVALID_TASK_DIGEST"),
      requireNonEmpty(options.sourceAttemptId, "INVALID_SOURCE_ATTEMPT_ID")
    ),
    manifest,
    canonicalJson
  };
};

export const sanitizeAtifTrajectory = (
  input: string | Buffer,
  options: AtifSanitizationOptions
): AtifSanitizationResult => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  const inputSha256 = sha256(bytes);
  let parser: StrictJsonParser | undefined;
  let context: SanitizationContext | undefined;
  let schemaVersion: string | null = null;
  const baseManifest = (): AtifSanitizationManifest => ({
    inputSha256,
    outputSha256: null,
    schemaVersion,
    allowedFieldCounts: context?.allowedFieldCounts ?? {},
    removedFieldCounts: context?.removedFieldCounts ?? {},
    redactionCounts: context?.redactionCounts ?? {},
    limitUsage: {
      rawBytes: bytes.byteLength,
      nestingDepth: parser?.maxDepth ?? 0,
      steps: 0,
      nestedValues: parser?.values ?? 0,
      largestStringBytes: parser?.largestStringBytes ?? 0,
      allowedTextBytes: context?.allowedTextBytes ?? 0,
      allowedTextTokens: context?.allowedTextTokens ?? 0
    },
    cutoffAttested: false,
    rejectionReason: null
  });

  try {
    const limits = resolvedLimits(options.limits);
    if (bytes.byteLength > limits.rawBytes) throw new Reject("RAW_JSON_LIMIT");
    // Fatal decoding rejects malformed UTF-8 instead of replacing bytes before hashing/parsing.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parser = new StrictJsonParser(text, limits);
    const parsed = parser.parse();
    if (!isObject(parsed)) throw new Reject("ROOT_NOT_OBJECT");
    schemaVersion =
      typeof parsed.schema_version === "string" ? parsed.schema_version : null;
    context = new SanitizationContext(limits, options.countEmbeddingTokens);
    const trajectory = sanitizeTrajectory(
      parsed,
      options,
      context,
      limits,
      inputSha256,
      bytes.byteLength
    );
    const manifest = baseManifest();
    manifest.schemaVersion = ATIF_SCHEMA_VERSION;
    manifest.limitUsage.steps = trajectory.steps.length;
    manifest.cutoffAttested = true;
    return materializeSanitizedAtifTrajectory(trajectory, {
      taskDigest: options.taskDigest,
      sourceAttemptId: options.sourceAttemptId,
      sourceManifest: manifest
    });
  } catch (error) {
    const reason =
      error instanceof Reject
        ? error.message
        : error instanceof TypeError && error.message.includes("encoded data")
          ? "INVALID_UTF8"
          : "SANITIZER_INTERNAL_FAILURE";
    const manifest = baseManifest();
    manifest.rejectionReason = reason;
    throw new AtifSanitizationError(reason, manifest);
  }
};
