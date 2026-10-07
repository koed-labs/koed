import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("codex_rollout_rewrite_unproven");
  return value as Row;
};
const withoutOrdinal = (value: Row): Row => {
  const copy = { ...value };
  delete copy.ordinal;
  return copy;
};
const completionTypes = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "exec_command_end",
  "mcp_tool_call_end",
  "dynamic_tool_call_response",
  "patch_apply_end",
  "web_search_end",
  "image_generation_end",
  "context_compacted",
  "entered_review_mode",
  "exited_review_mode",
  "sub_agent_activity"
]);
const optionalFields = (source: Row, keys: string[]): Row =>
  Object.fromEntries(
    keys.filter((key) => source[key] != null).map((key) => [key, source[key]])
  );
const normalizeLegacyMigrationRecord = (record: Row): Row | null => {
  const payload = row(record.payload);
  if (
    (record.type === "event_msg" &&
      ["guardian_assessment", "thread_name_updated", "undo_completed"].includes(
        String(payload.type)
      )) ||
    (record.type === "response_item" && payload.type === "ghost_snapshot")
  )
    return null;
  const normalized = { ...payload };
  if (
    record.type === "event_msg" &&
    ["exec_command_begin", "exec_command_end"].includes(String(payload.type))
  ) {
    const cwd = payload.cwd;
    if (
      typeof cwd !== "string" ||
      [...cwd].some((character) => character.charCodeAt(0) < 32) ||
      /[\uD800-\uDFFF]/u.test(cwd)
    )
      throw new Error("codex_rollout_rewrite_path_normalization_unsupported");
    if (cwd.startsWith("file:")) {
      const url = new URL(cwd);
      if (
        url.protocol !== "file:" ||
        url.search ||
        url.hash ||
        /^\/%00\/bad\/path\//i.test(url.pathname)
      )
        throw new Error("codex_rollout_rewrite_path_normalization_unsupported");
      url.pathname = url.pathname.replace(
        /^\/([a-z]):/i,
        (_, drive: string) => `/${drive.toUpperCase()}:`
      );
      normalized.cwd = url.href;
    } else if (/^[A-Za-z]:[\\/]/.test(cwd)) {
      normalized.cwd = pathToFileURL(cwd[0]!.toUpperCase() + cwd.slice(1), {
        windows: true
      }).href;
    } else if (
      cwd.startsWith("/") &&
      !cwd.startsWith("//") &&
      !/^\/[A-Za-z]:/.test(cwd)
    ) {
      normalized.cwd = pathToFileURL(cwd, { windows: false }).href;
    } else
      throw new Error("codex_rollout_rewrite_path_normalization_unsupported");
  }
  if (
    record.type === "event_msg" &&
    payload.type === "entered_review_mode" &&
    payload.target === undefined &&
    typeof payload.prompt === "string"
  ) {
    normalized.target = { type: "custom", instructions: payload.prompt };
    delete normalized.prompt;
  }
  if (record.type === "turn_context") {
    const mode = payload.collaboration_mode;
    if (mode !== null && typeof mode === "object" && !Array.isArray(mode)) {
      const oldMode = row(mode);
      const settings = Object.hasOwn(oldMode, "settings")
        ? row(oldMode.settings)
        : oldMode;
      if (typeof settings.model !== "string")
        throw new Error(
          "codex_rollout_rewrite_context_normalization_unsupported"
        );
      normalized.collaboration_mode = {
        mode: oldMode.mode,
        settings: {
          model: settings.model,
          reasoning_effort: settings.reasoning_effort ?? null,
          developer_instructions: settings.developer_instructions ?? null
        }
      };
    }
    const sandbox = row(payload.sandbox_policy);
    const type = sandbox.type ?? sandbox.mode;
    if (["read-only", "workspace-write"].includes(String(type))) {
      for (const key of [
        "network_access",
        "exclude_tmpdir_env_var",
        "exclude_slash_tmp"
      ])
        if (sandbox[key] !== undefined && typeof sandbox[key] !== "boolean")
          throw new Error(
            "codex_rollout_rewrite_context_normalization_unsupported"
          );
      if (
        type === "workspace-write" &&
        sandbox.writable_roots !== undefined &&
        (!Array.isArray(sandbox.writable_roots) ||
          sandbox.writable_roots.some(
            (path) => typeof path !== "string" || !path.startsWith("/")
          ))
      )
        throw new Error(
          "codex_rollout_rewrite_context_normalization_unsupported"
        );
    }
    if (
      type === "external-sandbox" &&
      sandbox.network_access !== undefined &&
      sandbox.network_access !== "restricted" &&
      sandbox.network_access !== "enabled"
    )
      throw new Error(
        "codex_rollout_rewrite_context_normalization_unsupported"
      );
    if (type === "danger-full-access") normalized.sandbox_policy = { type };
    else if (type === "read-only")
      normalized.sandbox_policy = {
        type,
        ...(sandbox.network_access === true ? { network_access: true } : {})
      };
    else if (type === "external-sandbox")
      normalized.sandbox_policy = {
        type,
        network_access: sandbox.network_access ?? "restricted"
      };
    else if (type === "workspace-write")
      normalized.sandbox_policy = {
        type,
        ...(Array.isArray(sandbox.writable_roots) &&
        sandbox.writable_roots.length
          ? { writable_roots: sandbox.writable_roots }
          : {}),
        network_access: sandbox.network_access ?? false,
        exclude_tmpdir_env_var: sandbox.exclude_tmpdir_env_var ?? false,
        exclude_slash_tmp: sandbox.exclude_slash_tmp ?? false
      };
    else
      throw new Error(
        "codex_rollout_rewrite_context_normalization_unsupported"
      );
    if (normalized.personality === null) delete normalized.personality;
    for (const key of [
      "turn_id",
      "root_turn_id",
      "disabled_plugin_ids",
      "approvals_reviewer",
      "permission_profile",
      "active_permission_profile",
      "file_system_sandbox_policy",
      "comp_hash",
      "collaboration_mode",
      "multi_agent_version",
      "realtime_active",
      "cyber_access_program",
      "effort",
      "summary"
    ])
      if (normalized[key] == null) delete normalized[key];
  }
  if (record.type === "event_msg" && payload.type === "token_count") {
    normalized.info ??= null;
    normalized.rate_limits ??= null;
    if (normalized.rate_limits !== null) {
      const limits = { ...row(normalized.rate_limits) };
      for (const key of [
        "limit_id",
        "limit_name",
        "primary",
        "secondary",
        "credits",
        "individual_limit",
        "spend_control_reached",
        "plan_type",
        "rate_limit_reached_type"
      ])
        limits[key] ??= null;
      if (limits.normal_model_slug == null) delete limits.normal_model_slug;
      for (const key of ["primary", "secondary"]) {
        if (limits[key] === null) continue;
        const window = { ...row(limits[key]) };
        window.window_minutes ??= null;
        window.resets_at ??= null;
        if (typeof window.resets_at === "string") {
          const value = window.resets_at;
          const match =
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
              value
            );
          const year = Number(match?.[1]);
          const month = Number(match?.[2]);
          const day = Number(match?.[3]);
          const days = [
            31,
            year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31
          ];
          const parsed = Date.parse(value);
          if (
            !match ||
            month < 1 ||
            month > 12 ||
            day < 1 ||
            day > days[month - 1]! ||
            Number(match[4]) > 23 ||
            Number(match[5]) > 59 ||
            Number(match[6]) > 59 ||
            Number(match[7] ?? 0) > 23 ||
            Number(match[8] ?? 0) > 59 ||
            !Number.isFinite(parsed)
          )
            throw new Error(
              "codex_rollout_rewrite_rate_limit_normalization_unsupported"
            );
          window.resets_at = Math.floor(parsed / 1000);
        }
        for (const field of ["resets_at", "window_minutes"])
          if (
            window[field] !== null &&
            (typeof window[field] !== "number" ||
              !Number.isSafeInteger(window[field]))
          )
            throw new Error(
              "codex_rollout_rewrite_rate_limit_normalization_unsupported"
            );
        limits[key] = window;
      }
      if (limits.credits !== null) {
        const credits = { ...row(limits.credits) };
        credits.balance ??= null;
        limits.credits = credits;
      }
      normalized.rate_limits = limits;
    }
  }
  return { ...record, payload: normalized };
};
const legacyUserContent = (payload: Row): Row[] => {
  if (typeof payload.message !== "string")
    throw new Error("codex_rollout_rewrite_unproven");
  const array = (key: string): unknown[] => {
    const value = payload[key];
    if (value == null) return [];
    if (!Array.isArray(value))
      throw new Error("codex_rollout_rewrite_unproven");
    return value;
  };
  const content: Row[] = payload.message.trim()
    ? [
        {
          type: "text",
          text: payload.message,
          text_elements: array("text_elements")
        }
      ]
    : [];
  const images = array("images");
  const files = array("file_ids");
  const imageOrder = array("image_order");
  if (imageOrder.some((kind) => kind !== "inline" && kind !== "file"))
    throw new Error("codex_rollout_rewrite_unproven");
  const ordered =
    imageOrder.length > 0 &&
    imageOrder.filter((kind) => kind === "inline").length === images.length &&
    imageOrder.filter((kind) => kind === "file").length === files.length;
  let imageIndex = 0;
  let fileIndex = 0;
  const appendImage = (kind: "inline" | "file") => {
    const index = kind === "inline" ? imageIndex++ : fileIndex++;
    const reference = (kind === "inline" ? images : files)[index];
    if (typeof reference !== "string")
      throw new Error("codex_rollout_rewrite_unproven");
    const detail = array(
      kind === "inline" ? "image_details" : "file_id_details"
    )[index];
    content.push({
      type: "image",
      [kind === "inline" ? "image_url" : "file_id"]: reference,
      ...(detail == null ? {} : { detail })
    });
  };
  if (ordered) {
    for (const kind of imageOrder) appendImage(kind as "inline" | "file");
  } else {
    for (let index = 0; index < images.length; index++) appendImage("inline");
    for (let index = 0; index < files.length; index++) appendImage("file");
  }
  for (const [index, localPath] of array("local_images").entries()) {
    if (typeof localPath !== "string")
      throw new Error("codex_rollout_rewrite_unproven");
    const detail = array("local_image_details")[index];
    content.push({
      type: "local_image",
      path: localPath,
      ...(detail == null ? {} : { detail })
    });
  }
  for (const [key, type, field] of [
    ["audio", "audio", "audio_url"],
    ["local_audio", "local_audio", "path"]
  ] as const) {
    for (const value of array(key)) {
      if (typeof value !== "string")
        throw new Error("codex_rollout_rewrite_unproven");
      content.push({ type, [field]: value });
    }
  }
  return content;
};
const legacyToolCompletion = (payload: Row, generatedId: string): Row => {
  if (payload.type === "entered_review_mode")
    return {
      type: "EnteredReviewMode",
      id: payload.item_id ?? generatedId,
      target: payload.target,
      user_facing_hint: payload.user_facing_hint ?? "Review requested."
    };
  if (payload.type === "exited_review_mode")
    return {
      type: "ExitedReviewMode",
      id: payload.item_id ?? generatedId,
      review_output: payload.review_output ?? null
    };
  if (payload.type === "sub_agent_activity") {
    if (typeof payload.event_id !== "string" || !payload.event_id.length)
      throw new Error("codex_rollout_rewrite_unproven");
    return {
      type: "SubAgentActivity",
      id: payload.event_id,
      model: payload.model ?? null,
      reasoning_effort: payload.reasoning_effort ?? null,
      kind: payload.kind,
      agent_thread_id: payload.agent_thread_id,
      agent_path: payload.agent_path
    };
  }
  const id = payload.call_id;
  if (
    payload.type !== "context_compacted" &&
    (typeof id !== "string" || !id.length)
  )
    throw new Error("codex_rollout_rewrite_unproven");
  if (payload.type === "exec_command_end")
    return {
      type: "CommandExecution",
      id,
      command: payload.command,
      cwd: payload.cwd,
      parsed_cmd: payload.parsed_cmd,
      source: payload.source,
      status: payload.status,
      exit_code: payload.exit_code,
      duration: payload.duration,
      ...optionalFields(payload, ["plugin_id", "script_path", "process_id"]),
      ...(typeof payload.aggregated_output === "string" &&
      payload.aggregated_output.length
        ? { aggregated_output: payload.aggregated_output }
        : {})
    };
  if (payload.type === "dynamic_tool_call_response")
    return {
      type: "DynamicToolCall",
      id,
      tool: payload.tool,
      arguments: payload.arguments,
      status: payload.success ? "completed" : "failed",
      content_items: payload.content_items,
      success: payload.success,
      duration: payload.duration,
      ...optionalFields(payload, ["namespace", "error"])
    };
  if (payload.type === "patch_apply_end")
    return {
      type: "FileChange",
      id,
      changes: payload.changes,
      status: payload.status,
      ...Object.fromEntries(
        ["stdout", "stderr"]
          .filter(
            (key) => typeof payload[key] === "string" && payload[key].length
          )
          .map((key) => [key, payload[key]])
      )
    };
  if (payload.type === "web_search_end")
    return {
      type: "WebSearch",
      id,
      query: payload.query,
      action: payload.action,
      ...optionalFields(payload, ["results"])
    };
  if (payload.type === "image_generation_end")
    return {
      type: "Extension",
      kind: "image_gen.generation",
      id,
      status: payload.status,
      revisedPrompt: payload.revised_prompt ?? null,
      result: payload.result,
      transparentBackground: payload.transparent_background ?? null,
      failure: payload.failure ?? null,
      ...(payload.saved_path == null ? {} : { savedPath: payload.saved_path })
    };
  if (payload.type === "context_compacted")
    return { type: "ContextCompaction", id: generatedId };
  const invocation = row(payload.invocation);
  const result = row(payload.result);
  const success =
    Object.hasOwn(result, "Ok") && row(result.Ok).isError !== true;
  if (!Object.hasOwn(result, "Ok") && typeof result.Err !== "string")
    throw new Error("codex_rollout_rewrite_unproven");
  return {
    type: "McpToolCall",
    id,
    server: invocation.server,
    tool: invocation.tool,
    arguments: invocation.arguments ?? null,
    status: success ? "completed" : "failed",
    duration: payload.duration,
    ...(Object.hasOwn(result, "Ok")
      ? { result: result.Ok }
      : { error: { message: result.Err } }),
    ...optionalFields(payload, [
      "connector_id",
      "mcp_app_resource_uri",
      "mcp_app_ui",
      "link_id",
      "app_name",
      "action_name",
      "plugin_id",
      "read_only_hint"
    ])
  };
};
const lines = (bytes: Uint8Array): { records: Row[]; ends: number[] } => {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes.at(-1) !== 10)
    throw new Error("codex_rollout_rewrite_input_limit");
  const records: Row[] = [];
  const ends: number[] = [];
  let start = 0;
  const buffer = Buffer.from(bytes);
  for (
    let end = buffer.indexOf(10);
    end >= 0;
    end = buffer.indexOf(10, start)
  ) {
    records.push(
      row(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(start, end)
          )
        )
      )
    );
    ends.push(end + 1);
    start = end + 1;
  }
  return { records, ends };
};

export const codexRolloutIdFromLabel = (label: string): string | undefined =>
  /^rollout-.*(?:-|_)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i
    .exec(label)?.[1]
    ?.toLowerCase();

export interface CodexTranscriptContinuationEvidence {
  bytes: Uint8Array;
  startOffset: number;
  sourceLabel: string;
  sourceGenerationId: string;
  logicalThreadId: string;
  priorGenerationClosure?: {
    sourceGenerationId: string;
    contentDigest: string;
  } | null;
  closureHash?: string | null;
  logicalAncestors?: CodexTranscriptContinuationEvidence[];
}

const continuationParent = (metadata: Row, cutoff: number): string => {
  const fork = metadata.forked_from_id;
  const parent = metadata.parent_thread_id;
  const id = fork ?? parent;
  const boundary =
    fork != null
      ? metadata.forked_from_ordinal_exclusive
      : metadata.subagent_history_start_ordinal;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id
    ) ||
    id === metadata.id ||
    typeof boundary !== "number" ||
    !Number.isSafeInteger(boundary) ||
    boundary < 0 ||
    cutoff > boundary
  )
    throw new Error("codex_rollout_continuation_ancestor_unproven");
  return id;
};

// Resolve only lineage already present in admitted predecessor headers. New
// metadata may select a cutoff, but cannot authorize discovery of an ancestor.
export const collectCodexTranscriptContinuationAncestors = async <
  T extends CodexTranscriptContinuationEvidence
>(input: {
  previous: T;
  rewrittenBytes: Uint8Array;
  loadGeneration: (generationId: string, from: T) => Promise<T | null>;
  loadThread: (threadId: string, from: T) => Promise<T | null>;
}): Promise<T[]> => {
  const replacement = row(lines(input.rewrittenBytes).records[0]?.payload);
  const target = row(replacement.history_base).thread_id;
  if (
    typeof target !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      target
    )
  )
    throw new Error("codex_rollout_continuation_identity_mismatch");
  const admitted = new Map([
    [input.previous.sourceGenerationId, input.previous]
  ]);
  let totalBytes =
    input.previous.bytes.byteLength + input.rewrittenBytes.byteLength;
  if (totalBytes > 64 * 1024 * 1024)
    throw new Error("codex_rollout_continuation_ancestry_limit");
  const admit = (evidence: T): T => {
    const cached = admitted.get(evidence.sourceGenerationId);
    if (cached) return cached;
    admitted.set(evidence.sourceGenerationId, evidence);
    totalBytes += evidence.bytes.byteLength;
    if (admitted.size > 32 || totalBytes > 64 * 1024 * 1024)
      throw new Error("codex_rollout_continuation_ancestry_limit");
    return evidence;
  };
  const findPhysical = async (
    first: T,
    physicalId: string
  ): Promise<T | null> => {
    let candidate = first;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(candidate.sourceGenerationId))
        throw new Error("codex_rollout_continuation_cycle");
      seen.add(candidate.sourceGenerationId);
      if (codexRolloutIdFromLabel(candidate.sourceLabel) === physicalId)
        return candidate;
      const closure = candidate.priorGenerationClosure;
      if (!closure) return null;
      const prior = await input.loadGeneration(
        closure.sourceGenerationId,
        candidate
      );
      if (!prior)
        throw new Error("codex_rollout_continuation_ancestor_pending");
      if (
        prior.sourceGenerationId !== closure.sourceGenerationId ||
        prior.closureHash !== closure.contentDigest ||
        prior.logicalThreadId !== candidate.logicalThreadId
      )
        throw new Error(
          "codex_rollout_continuation_ancestor_identity_mismatch"
        );
      candidate = admit(prior);
    }
  };
  const metadataOf = (source: T) => {
    const first = lines(source.bytes).records[0];
    if (source.startOffset !== 0 || first?.type !== "session_meta")
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    const metadata = row(first.payload);
    if (
      metadata.id !== source.logicalThreadId ||
      metadata.history_mode !== "paginated"
    )
      throw new Error("codex_rollout_continuation_ancestor_identity_mismatch");
    return metadata;
  };
  const resolveBase = async (current: T, active: Set<string>): Promise<T> => {
    const metadata = metadataOf(current);
    const base = row(metadata.history_base);
    if (
      typeof base.thread_id !== "string" ||
      typeof base.end_ordinal_exclusive !== "number" ||
      !Number.isSafeInteger(base.end_ordinal_exclusive) ||
      base.end_ordinal_exclusive < 0
    )
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    let ancestor = await findPhysical(current, base.thread_id);
    if (!ancestor) {
      const parent = continuationParent(metadata, base.end_ordinal_exclusive);
      const forkSource = await input.loadThread(parent, current);
      if (!forkSource)
        throw new Error("codex_rollout_continuation_ancestor_pending");
      if (forkSource.logicalThreadId !== parent)
        throw new Error(
          "codex_rollout_continuation_ancestor_identity_mismatch"
        );
      const route = await resolvePath(
        admit(forkSource),
        base.thread_id,
        active
      );
      ancestor = route.at(-1)!;
      if (route.length > 1) ancestor = { ...ancestor, logicalAncestors: route };
    }
    if (!ancestor)
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    return ancestor;
  };
  const resolvePath = async (
    first: T,
    physicalId: string,
    active: Set<string>
  ): Promise<T[]> => {
    const direct = await findPhysical(first, physicalId);
    if (direct) {
      if (active.has(direct.sourceGenerationId))
        throw new Error("codex_rollout_continuation_cycle");
      return [direct];
    }
    if (active.has(first.sourceGenerationId))
      throw new Error("codex_rollout_continuation_cycle");
    const nextActive = new Set(active).add(first.sourceGenerationId);
    const next = await resolveBase(first, nextActive);
    return [first, ...(await resolvePath(next, physicalId, nextActive))];
  };
  // The first physical edge belongs to the old admitted header. Subsequent
  // parent routes are separate proofs, not bytes newly admitted to the child.
  const ancestors: T[] = [];
  let current = input.previous;
  const active = new Set<string>();
  while (codexRolloutIdFromLabel(current.sourceLabel) !== target) {
    if (active.has(current.sourceGenerationId))
      throw new Error("codex_rollout_continuation_cycle");
    active.add(current.sourceGenerationId);
    const ancestor = await resolveBase(current, active);
    ancestors.push(ancestor);
    current = ancestor;
  }
  return ancestors;
};

export const verifyCodexTranscriptContinuation = (input: {
  previousBytes: Uint8Array;
  previousStartOffset: number;
  previousSourceLabel: string;
  rewrittenBytes: Uint8Array;
  rewrittenSourceLabel: string;
  externalSessionId: string;
  previousHistory?: { subagentHistoryStartOrdinal: number | null };
  ancestors?: Array<
    Pick<
      CodexTranscriptContinuationEvidence,
      "bytes" | "startOffset" | "sourceLabel" | "logicalAncestors"
    >
  >;
}): {
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  prefixDigest: string;
} => {
  const proofEntries: NonNullable<typeof input.ancestors>[number][] = [];
  const activeProof = new Set<object>();
  const countProof = (
    evidence: NonNullable<typeof input.ancestors>[number],
    depth: number
  ) => {
    if (depth > 32 || activeProof.has(evidence))
      throw new Error("codex_rollout_continuation_cycle");
    activeProof.add(evidence);
    proofEntries.push(evidence);
    if (proofEntries.length > 128)
      throw new Error("codex_rollout_continuation_ancestry_limit");
    for (const parent of evidence.logicalAncestors ?? [])
      countProof(parent, depth + 1);
    activeProof.delete(evidence);
  };
  for (const ancestor of input.ancestors ?? []) countProof(ancestor, 0);
  if (
    (input.ancestors?.length ?? 0) > 32 ||
    input.previousBytes.byteLength +
      input.rewrittenBytes.byteLength +
      proofEntries.reduce(
        (size, evidence) => size + evidence.bytes.byteLength,
        0
      ) >
      64 * 1024 * 1024
  )
    throw new Error("codex_rollout_continuation_ancestry_limit");
  const previous = lines(input.previousBytes);
  const rewritten = lines(input.rewrittenBytes);
  const header = rewritten.records[0]!;
  const metadata = row(header.payload);
  const base = row(metadata.history_base);
  const previousRollout = codexRolloutIdFromLabel(input.previousSourceLabel);
  const currentRollout = codexRolloutIdFromLabel(input.rewrittenSourceLabel);
  let previousOrdinal = -1;
  for (const record of previous.records) {
    if (
      typeof record.ordinal !== "number" ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal <= previousOrdinal
    )
      throw new Error("codex_rollout_continuation_invalid_ordinal");
    previousOrdinal = record.ordinal;
  }
  if (
    !previousRollout ||
    !currentRollout ||
    previousRollout === currentRollout ||
    header.type !== "session_meta" ||
    metadata.id !== input.externalSessionId ||
    metadata.history_mode !== "paginated" ||
    typeof base.end_byte_offset !== "number" ||
    !Number.isSafeInteger(base.end_byte_offset) ||
    typeof base.end_ordinal_exclusive !== "number" ||
    !Number.isSafeInteger(base.end_ordinal_exclusive) ||
    base.end_ordinal_exclusive < 0 ||
    header.ordinal !== base.end_ordinal_exclusive ||
    !Number.isSafeInteger(input.previousStartOffset) ||
    input.previousStartOffset < 0
  )
    throw new Error("codex_rollout_continuation_identity_mismatch");
  const proveCutoff = (
    evidence: ReturnType<typeof lines>,
    start: number,
    cutoff: Row
  ) => {
    const lastIndex = evidence.ends.indexOf(
      Number(cutoff.end_byte_offset) - start
    );
    const lastOrdinal = evidence.records[lastIndex]?.ordinal;
    if (
      lastIndex < 0 ||
      !Number.isSafeInteger(cutoff.end_byte_offset) ||
      !Number.isSafeInteger(cutoff.end_ordinal_exclusive) ||
      typeof lastOrdinal !== "number" ||
      lastOrdinal + 1 !== cutoff.end_ordinal_exclusive ||
      (evidence.records[lastIndex + 1] !== undefined &&
        evidence.records[lastIndex + 1]!.ordinal !==
          cutoff.end_ordinal_exclusive)
    )
      throw new Error("codex_rollout_continuation_cutoff_unproven");
  };
  type Evidence = NonNullable<typeof input.ancestors>[number];
  const parsedEvidence = new Map<Evidence, ReturnType<typeof lines>>();
  const evidenceRows = (evidence: Evidence) => {
    const cached = parsedEvidence.get(evidence);
    if (cached) return cached;
    if (evidence.startOffset !== 0)
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    const parsed = lines(evidence.bytes);
    if (
      parsed.records[0]?.type !== "session_meta" ||
      row(parsed.records[0].payload).history_mode !== "paginated"
    )
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    let ordinal = -1;
    for (const record of parsed.records) {
      if (
        typeof record.ordinal !== "number" ||
        !Number.isSafeInteger(record.ordinal) ||
        record.ordinal <= ordinal
      )
        throw new Error("codex_rollout_continuation_invalid_ordinal");
      ordinal = record.ordinal;
    }
    parsedEvidence.set(evidence, parsed);
    return parsed;
  };
  const proveLogicalParent = (
    from: Row,
    target: Evidence,
    cutoff: number,
    depth = 0
  ): void => {
    if (depth > 32)
      throw new Error("codex_rollout_continuation_ancestry_limit");
    const targetRows = evidenceRows(target);
    const targetMetadata = row(targetRows.records[0]!.payload);
    if (from.id === targetMetadata.id) return;
    const parentId = continuationParent(from, cutoff);
    const route = target.logicalAncestors;
    if (!route?.length) {
      if (parentId !== targetMetadata.id)
        throw new Error(
          "codex_rollout_continuation_ancestor_identity_mismatch"
        );
      return;
    }
    const firstMetadata = row(evidenceRows(route[0]!).records[0]!.payload);
    const last = route.at(-1)!;
    if (
      firstMetadata.id !== parentId ||
      last.sourceLabel !== target.sourceLabel ||
      last.startOffset !== target.startOffset ||
      !Buffer.from(last.bytes).equals(Buffer.from(target.bytes))
    )
      throw new Error("codex_rollout_continuation_ancestor_identity_mismatch");
    const seen = new Set<string>();
    for (let index = 0; index < route.length - 1; index++) {
      const source = route[index]!;
      const next = route[index + 1]!;
      const sourcePhysical = codexRolloutIdFromLabel(source.sourceLabel);
      if (!sourcePhysical || seen.has(sourcePhysical))
        throw new Error("codex_rollout_continuation_cycle");
      seen.add(sourcePhysical);
      const sourceMetadata = row(evidenceRows(source).records[0]!.payload);
      const sourceBase = row(sourceMetadata.history_base);
      const nextRows = evidenceRows(next);
      if (
        sourceBase.thread_id !== codexRolloutIdFromLabel(next.sourceLabel) ||
        typeof sourceBase.end_ordinal_exclusive !== "number" ||
        cutoff > sourceBase.end_ordinal_exclusive
      )
        throw new Error("codex_rollout_continuation_cutoff_unproven");
      proveCutoff(nextRows, next.startOffset, sourceBase);
      proveLogicalParent(
        sourceMetadata,
        next,
        sourceBase.end_ordinal_exclusive,
        depth + 1
      );
    }
    if (seen.has(codexRolloutIdFromLabel(last.sourceLabel) ?? ""))
      throw new Error("codex_rollout_continuation_cycle");
  };
  let cutoffEvidence = previous;
  let cutoffStart = input.previousStartOffset;
  let cutoffPhysical = previousRollout;
  const seenPhysical = new Set([currentRollout]);
  let ancestryLimit = Number.MAX_SAFE_INTEGER;
  for (const ancestor of input.ancestors ?? []) {
    if (cutoffPhysical === base.thread_id || seenPhysical.has(cutoffPhysical))
      throw new Error("codex_rollout_continuation_cycle");
    seenPhysical.add(cutoffPhysical);
    const oldHeader = cutoffEvidence.records[0];
    if (cutoffStart !== 0 || oldHeader?.type !== "session_meta")
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    const oldMetadata = row(oldHeader.payload);
    const oldBase = row(oldMetadata.history_base);
    const ancestorPhysical = codexRolloutIdFromLabel(ancestor.sourceLabel);
    const ancestorRows = lines(ancestor.bytes);
    const ancestorHeader = ancestorRows.records[0];
    if (
      !ancestorPhysical ||
      oldBase.thread_id !== ancestorPhysical ||
      ancestorPhysical === currentRollout
    )
      throw new Error("codex_rollout_continuation_ancestor_identity_mismatch");
    let ordinal = -1;
    for (const record of ancestorRows.records) {
      if (
        typeof record.ordinal !== "number" ||
        !Number.isSafeInteger(record.ordinal) ||
        record.ordinal <= ordinal
      )
        throw new Error("codex_rollout_continuation_invalid_ordinal");
      ordinal = record.ordinal;
    }
    proveCutoff(ancestorRows, ancestor.startOffset, oldBase);
    if (ancestor.startOffset !== 0 || ancestorHeader?.type !== "session_meta")
      throw new Error("codex_rollout_continuation_ancestor_unproven");
    const ancestorMetadata = row(ancestorHeader.payload);
    if (ancestorMetadata.history_mode !== "paginated")
      throw new Error("codex_rollout_continuation_ancestor_identity_mismatch");
    proveLogicalParent(
      oldMetadata,
      ancestor,
      Number(oldBase.end_ordinal_exclusive)
    );
    ancestryLimit = Math.min(
      ancestryLimit,
      Number(oldBase.end_ordinal_exclusive)
    );
    if (
      base.end_ordinal_exclusive > ancestryLimit ||
      (ancestorPhysical === base.thread_id &&
        Number(base.end_byte_offset) > Number(oldBase.end_byte_offset))
    )
      throw new Error("codex_rollout_continuation_cutoff_unproven");
    cutoffEvidence = ancestorRows;
    cutoffStart = ancestor.startOffset;
    cutoffPhysical = ancestorPhysical;
  }
  if (cutoffPhysical !== base.thread_id)
    throw new Error("codex_rollout_continuation_identity_mismatch");
  proveCutoff(cutoffEvidence, cutoffStart, base);
  const hasPreviousHeader = previous.records[0]?.type === "session_meta";
  if (!hasPreviousHeader && !input.previousHistory)
    throw new Error("codex_rollout_continuation_history_fence_unproven");
  if (input.previousHistory) {
    const boundary = input.previousHistory.subagentHistoryStartOrdinal;
    if (boundary !== null && (!Number.isSafeInteger(boundary) || boundary < 0))
      throw new Error("codex_rollout_continuation_history_fence_unproven");
    // Headerless evidence retains no full logical metadata. Only corroborate
    // the own-history fence supplied by the predecessor's durable context.
    if (
      (metadata.subagent_history_start_ordinal ?? null) !== boundary ||
      (hasPreviousHeader &&
        (row(previous.records[0]!.payload).subagent_history_start_ordinal ??
          null) !== boundary)
    )
      throw new Error("codex_rollout_continuation_metadata_changed");
  }
  if (hasPreviousHeader) {
    const original = { ...row(previous.records[0]!.payload) };
    const replacement = { ...metadata };
    if (
      original.id !== input.externalSessionId ||
      original.history_mode !== "paginated"
    )
      throw new Error("codex_rollout_continuation_identity_mismatch");
    if (original.history_base != null) {
      const previousBase = row(original.history_base);
      if (
        previousBase.thread_id === previousRollout ||
        previousBase.thread_id === currentRollout
      )
        throw new Error("codex_rollout_continuation_cycle");
    }
    delete original.history_base;
    delete replacement.history_base;
    if (
      (input.ancestors?.length ?? 0) > 0 &&
      original.forked_from_ordinal_exclusive !== undefined
    ) {
      const oldFork = original.forked_from_ordinal_exclusive;
      if (
        typeof oldFork !== "number" ||
        !Number.isSafeInteger(oldFork) ||
        oldFork < 0 ||
        replacement.forked_from_ordinal_exclusive !==
          Math.min(oldFork, base.end_ordinal_exclusive)
      )
        throw new Error("codex_rollout_continuation_metadata_changed");
      delete original.forked_from_ordinal_exclusive;
      delete replacement.forked_from_ordinal_exclusive;
    }
    // Native revert creates a recorder, so these describe the replacement
    // file and binary rather than the stable logical Conversation.
    for (const field of ["timestamp", "cli_version"] as const) {
      if (original[field] === undefined && replacement[field] === undefined)
        continue;
      if (
        typeof original[field] !== "string" ||
        typeof replacement[field] !== "string" ||
        !original[field] ||
        !replacement[field] ||
        (field === "timestamp" &&
          (!Number.isFinite(Date.parse(original[field])) ||
            !Number.isFinite(Date.parse(replacement[field]))))
      )
        throw new Error("codex_rollout_continuation_metadata_changed");
      delete original[field];
      delete replacement[field];
    }
    if (!isDeepStrictEqual(original, replacement))
      throw new Error("codex_rollout_continuation_metadata_changed");
  }
  let last = -1;
  for (const record of rewritten.records) {
    if (
      typeof record.ordinal !== "number" ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal <= last
    )
      throw new Error("codex_rollout_continuation_invalid_ordinal");
    last = record.ordinal;
  }
  const liveStartOffset = rewritten.ends[0]!;
  return {
    journalStartOffset: 0,
    journalStartLine: 0,
    liveStartOffset,
    liveStartLine: 1,
    prefixDigest: createHash("sha256")
      .update(input.rewrittenBytes.subarray(0, liveStartOffset))
      .digest("hex")
  };
};

// Verify a recognized native transformation, not an approximate content match.
// Unchanged records, ordering, timestamps, thread/turn identity and every mapped
// message field must agree. Unsupported legacy conversions remain blocked.
export const verifyCodexTranscriptRewrite = (input: {
  previousBytes: Uint8Array;
  rewrittenBytes: Uint8Array;
  externalSessionId: string;
  rewrittenMetadata?: Record<string, unknown>;
}): {
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  prefixDigest: string;
} => {
  let previous = lines(input.previousBytes).records.flatMap((record) => {
    const normalized = normalizeLegacyMigrationRecord(record);
    return normalized ? [normalized] : [];
  });
  if (
    previous.some(
      (record) =>
        record.type === "event_msg" &&
        row(record.payload).type === "thread_rolled_back"
    )
  ) {
    if (previous[0]?.type !== "session_meta")
      throw new Error("codex_rollout_rewrite_rollback_frontier_unproven");
    // Native rollback owns records by instruction boundary, including late completions.
    // This bounded plan excludes Responses pairing, compactions and retained context.
    const owners: Array<number | undefined> = [];
    const alive: boolean[] = [];
    const stack: number[] = [];
    const turnBoundaries = new Map<string, number>();
    const startedTurns = new Set<string>();
    let activeTurn: string | undefined;
    let pending: number[] = [];
    const allowed = new Set([
      ...completionTypes,
      "task_started",
      "task_complete",
      "turn_aborted",
      "item_completed",
      "thread_rolled_back"
    ]);
    for (const [recordIndex, record] of previous.entries()) {
      owners.push(stack.at(-1));
      if (record.type === "session_meta") {
        if (recordIndex !== 0)
          throw new Error("codex_rollout_rewrite_rollback_plan_unsupported");
        owners[recordIndex] = undefined;
        continue;
      }
      const payload = row(record.payload);
      if (record.type !== "event_msg" || !allowed.has(String(payload.type)))
        throw new Error("codex_rollout_rewrite_rollback_plan_unsupported");
      if (payload.type === "thread_rolled_back") {
        const count = payload.num_turns;
        if (
          typeof count !== "number" ||
          !Number.isInteger(count) ||
          count < 0 ||
          count > 0xffff_ffff
        )
          throw new Error("codex_rollout_rewrite_rollback_plan_unsupported");
        if (count > 0) {
          for (
            let remaining = Math.min(count, stack.length);
            remaining > 0;
            remaining--
          )
            alive[stack.pop()!] = false;
          activeTurn = undefined;
          pending = [];
        }
        continue;
      }
      if (payload.type === "task_started") {
        if (
          typeof payload.turn_id !== "string" ||
          !payload.turn_id.length ||
          activeTurn ||
          startedTurns.has(payload.turn_id)
        )
          throw new Error("codex_rollout_rewrite_rollback_plan_unsupported");
        activeTurn = payload.turn_id;
        startedTurns.add(activeTurn);
        pending = [recordIndex];
        continue;
      }
      if (payload.type === "user_message") {
        if (!activeTurn)
          throw new Error("codex_rollout_rewrite_rollback_plan_unsupported");
        const boundary = alive.length;
        alive.push(true);
        stack.push(boundary);
        for (const pendingIndex of pending) owners[pendingIndex] = boundary;
        pending = [];
        owners[recordIndex] = boundary;
        turnBoundaries.set(activeTurn, boundary);
        continue;
      }
      const targeted = [
        "task_complete",
        "turn_aborted",
        "item_completed",
        "exec_command_end",
        "patch_apply_end",
        "dynamic_tool_call_response",
        "entered_review_mode",
        "exited_review_mode"
      ].includes(String(payload.type));
      const target =
        targeted &&
        typeof payload.turn_id === "string" &&
        payload.turn_id.length
          ? payload.turn_id
          : undefined;
      if (target && turnBoundaries.has(target))
        owners[recordIndex] = turnBoundaries.get(target);
      else if (activeTurn && !turnBoundaries.has(activeTurn))
        pending.push(recordIndex);
      if (
        ["task_complete", "turn_aborted"].includes(String(payload.type)) &&
        target === activeTurn
      ) {
        activeTurn = undefined;
        pending = [];
      }
    }
    previous = previous.filter(
      (record, recordIndex) =>
        !(
          record.type === "event_msg" &&
          row(record.payload).type === "thread_rolled_back"
        ) &&
        (owners[recordIndex] === undefined ||
          alive[owners[recordIndex]!] === true)
    );
  }
  const rewritten = lines(input.rewrittenBytes);
  const header = rewritten.records[0]!;
  const hasHeader = header.type === "session_meta";
  const metadata = row(hasHeader ? header.payload : input.rewrittenMetadata);
  if (
    metadata.id !== input.externalSessionId ||
    metadata.history_mode !== "paginated" ||
    metadata.history_base != null
  )
    throw new Error("codex_rollout_rewrite_identity_mismatch");
  let lastOrdinal = -1;
  for (const record of rewritten.records) {
    if (
      typeof record.ordinal !== "number" ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal <= lastOrdinal
    )
      throw new Error("codex_rollout_rewrite_invalid_ordinal");
    lastOrdinal = record.ordinal;
  }
  let index = hasHeader ? 1 : 0;
  let activeTurnId: string | undefined;
  let implicitTurn = false;
  let sawUser = false;
  let nextItemIndex: number | undefined =
    previous[0]?.type === "session_meta" ? 1 : undefined;
  const knownTurnIds = new Set<string>();
  let reasoning:
    | { id: string; summary_text: unknown[]; raw_content: unknown[] }
    | undefined;
  if (previous[0]?.type === "session_meta") {
    if (!hasHeader) throw new Error("codex_rollout_rewrite_unproven");
    const original = row(previous[0].payload);
    if (
      original.id !== input.externalSessionId ||
      (original.history_mode != null && original.history_mode !== "legacy")
    )
      throw new Error("codex_rollout_rewrite_identity_mismatch");
    const oldHeader = { ...original };
    const newHeader = { ...metadata };
    for (const key of [
      "history_mode",
      "history_base",
      "subagent_history_start_ordinal"
    ]) {
      delete oldHeader[key];
      delete newHeader[key];
    }
    if (
      !isDeepStrictEqual(oldHeader, newHeader) ||
      previous[0].timestamp !== header.timestamp
    )
      throw new Error("codex_rollout_rewrite_unproven");
  } else {
    const first = previous[0]!;
    const firstPayload = row(first.payload);
    if (
      first.type !== "event_msg" ||
      firstPayload.type !== "task_started" ||
      typeof firstPayload.turn_id !== "string"
    )
      throw new Error("codex_rollout_rewrite_anchor_missing");
    const anchors = rewritten.records.flatMap((record, offset) =>
      isDeepStrictEqual(withoutOrdinal(record), withoutOrdinal(first))
        ? [offset]
        : []
    );
    if (anchors.length !== 1)
      throw new Error("codex_rollout_rewrite_anchor_ambiguous");
    index = anchors[0]!;
  }
  const journalStartLine = previous[0]?.type === "session_meta" ? 0 : index;
  const journalStartOffset =
    journalStartLine === 0 ? 0 : rewritten.ends[journalStartLine - 1]!;
  const consumeSynthetic = (timestamp: unknown, payload: Row) => {
    const next = rewritten.records[index];
    if (
      !next ||
      !isDeepStrictEqual(withoutOrdinal(next), {
        timestamp,
        type: "event_msg",
        payload
      })
    )
      throw new Error("codex_rollout_rewrite_unproven");
    index++;
  };
  const finishImplicit = (timestamp: unknown) => {
    if (!activeTurnId || !implicitTurn) return;
    consumeSynthetic(timestamp, {
      type: "task_complete",
      turn_id: activeTurnId,
      last_agent_message: null,
      completed_at: Math.floor(Date.parse(String(timestamp)) / 1000)
    });
    activeTurnId = undefined;
    implicitTurn = false;
    reasoning = undefined;
  };
  const startImplicit = (timestamp: unknown, turnId: string) => {
    if (previous[0]?.type !== "session_meta")
      throw new Error("codex_rollout_rewrite_implicit_turn_unsupported");
    consumeSynthetic(timestamp, {
      type: "task_started",
      turn_id: turnId,
      started_at: Math.floor(Date.parse(String(timestamp)) / 1000),
      model_context_window: null,
      collaboration_mode_kind: "default"
    });
    activeTurnId = turnId;
    implicitTurn = true;
    sawUser = false;
    knownTurnIds.add(turnId);
    reasoning = undefined;
  };
  for (const [sourceIndex, original] of previous.entries()) {
    if (original.type === "session_meta") continue;
    const payload = row(original.payload);
    if (
      original.type === "event_msg" &&
      ((payload.type === "agent_message" && payload.message === "") ||
        payload.type === "exec_command_begin")
    )
      continue;
    if (original.type === "event_msg" && payload.type === "task_started") {
      finishImplicit(original.timestamp);
      if (typeof payload.turn_id !== "string" || activeTurnId)
        throw new Error("codex_rollout_rewrite_unclosed_turn");
      activeTurnId = payload.turn_id;
      implicitTurn = false;
      sawUser = false;
      knownTurnIds.add(activeTurnId);
      reasoning = undefined;
    }
    const converted =
      original.type === "event_msg" &&
      completionTypes.has(String(payload.type)) &&
      !(payload.type === "agent_message" && payload.message === "");
    if (converted) {
      if (
        ["agent_reasoning", "agent_reasoning_raw_content"].includes(
          String(payload.type)
        ) &&
        payload.text === ""
      )
        continue;
      if (payload.type === "user_message" && implicitTurn && sawUser)
        finishImplicit(original.timestamp);
      if (
        !activeTurnId &&
        !(
          typeof payload.turn_id === "string" &&
          knownTurnIds.has(payload.turn_id)
        )
      )
        startImplicit(
          original.timestamp,
          typeof payload.turn_id === "string" && payload.turn_id.length
            ? payload.turn_id
            : `rollout-${sourceIndex}`
        );
    }
    const next = rewritten.records[index];
    if (!next) throw new Error("codex_rollout_rewrite_unproven");
    if (converted) {
      const completedTurnId =
        typeof payload.turn_id === "string" && payload.turn_id.length
          ? payload.turn_id
          : activeTurnId;
      if (!completedTurnId || !knownTurnIds.has(completedTurnId))
        throw new Error("codex_rollout_rewrite_implicit_turn_unsupported");
      const completed = row(next.payload);
      const item = row(completed.item);
      if (
        next.type !== "event_msg" ||
        completed.type !== "item_completed" ||
        completed.thread_id !== input.externalSessionId ||
        completed.turn_id !== completedTurnId ||
        next.timestamp !== original.timestamp ||
        completed.completed_at_ms !== Date.parse(String(original.timestamp)) ||
        completed.started_at_ms != null ||
        typeof item.id !== "string" ||
        !item.id.length
      )
        throw new Error("codex_rollout_rewrite_unproven");
      let expected: Row;
      if (payload.type === "user_message") {
        expected = {
          type: "UserMessage",
          id: item.id,
          content: legacyUserContent(payload),
          ...(payload.client_id == null ? {} : { client_id: payload.client_id })
        };
        sawUser = true;
        reasoning = undefined;
      } else if (payload.type === "agent_message") {
        if (typeof payload.message !== "string" || !payload.message.length)
          throw new Error("codex_rollout_rewrite_unproven");
        expected = {
          type: "AgentMessage",
          id: item.id,
          content: [{ type: "Text", text: payload.message }]
        };
        for (const key of ["phase", "memory_citation", "delivery", "questions"])
          if (payload[key] != null) expected[key] = payload[key];
        reasoning = undefined;
      } else if (
        payload.type === "agent_reasoning" ||
        payload.type === "agent_reasoning_raw_content"
      ) {
        if (typeof payload.text !== "string" || !payload.text.length)
          throw new Error("codex_rollout_rewrite_unproven");
        reasoning ??= { id: item.id, summary_text: [], raw_content: [] };
        (payload.type === "agent_reasoning"
          ? reasoning.summary_text
          : reasoning.raw_content
        ).push(payload.text);
        expected = { type: "Reasoning", ...reasoning };
      } else {
        expected = legacyToolCompletion(payload, item.id);
        reasoning = undefined;
      }
      if (
        [
          "user_message",
          "agent_message",
          "agent_reasoning",
          "agent_reasoning_raw_content",
          "context_compacted"
        ].includes(String(payload.type)) ||
        (["entered_review_mode", "exited_review_mode"].includes(
          String(payload.type)
        ) &&
          payload.item_id == null)
      ) {
        if (!/^item-[1-9][0-9]*$/.test(item.id))
          throw new Error("codex_rollout_rewrite_unproven");
        const generatedIndex = Number(item.id.slice(5));
        const continuedReasoning =
          item.type === "Reasoning" &&
          reasoning?.id === item.id &&
          reasoning.summary_text.length + reasoning.raw_content.length > 1;
        if (!continuedReasoning) {
          nextItemIndex ??= generatedIndex;
          if (
            !Number.isSafeInteger(generatedIndex) ||
            generatedIndex !== nextItemIndex
          )
            throw new Error("codex_rollout_rewrite_unproven");
          nextItemIndex++;
        }
      }
      if (!isDeepStrictEqual(item, expected))
        throw new Error("codex_rollout_rewrite_unproven");
    } else {
      let expectedRecord = withoutOrdinal(original);
      if (original.type === "event_msg" && payload.type === "item_completed") {
        const preservedItem = row(payload.item);
        if (
          !["FunctionCallOutput", "Plan"].includes(
            String(preservedItem.type)
          ) &&
          !(
            preservedItem.type === "Extension" &&
            preservedItem.kind === "clock.sleep"
          ) &&
          !(
            preservedItem.type === "SubAgentActivity" &&
            preservedItem.kind === "completed"
          )
        )
          throw new Error("codex_rollout_rewrite_preserved_item_unsupported");
        const normalizedItem = { ...preservedItem };
        if (
          normalizedItem.type === "FunctionCallOutput" &&
          normalizedItem.namespace == null
        )
          delete normalizedItem.namespace;
        if (normalizedItem.type === "SubAgentActivity") {
          normalizedItem.model ??= null;
          normalizedItem.reasoning_effort ??= null;
        }
        const preservedPayload: Row = {
          ...payload,
          item: normalizedItem,
          thread_id: input.externalSessionId,
          completed_at_ms:
            payload.completed_at_ms === undefined ? 0 : payload.completed_at_ms
        };
        if (preservedPayload.started_at_ms == null)
          delete preservedPayload.started_at_ms;
        expectedRecord = { ...expectedRecord, payload: preservedPayload };
        reasoning = undefined;
      }
      if (!isDeepStrictEqual(expectedRecord, withoutOrdinal(next)))
        throw new Error("codex_rollout_rewrite_unproven");
      if (
        original.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      ) {
        const following = rewritten.records[index + 1];
        const hookRecord =
          following?.type === "event_msg" &&
          row(following.payload).type === "task_started"
            ? rewritten.records[index + 2]
            : following;
        const hookPayload = hookRecord ? row(hookRecord.payload) : undefined;
        const hookItem =
          hookPayload?.type === "item_completed"
            ? row(hookPayload.item)
            : undefined;
        const content = payload.content;
        const looksLikeHook =
          Array.isArray(content) &&
          content.some(
            (part) =>
              typeof row(part).text === "string" &&
              String(row(part).text).includes("<hook_prompt")
          );
        if (hookItem?.type === "HookPrompt") {
          if (
            typeof payload.id !== "string" ||
            !payload.id.length ||
            !Array.isArray(content) ||
            !Array.isArray(hookItem.fragments) ||
            !hookItem.fragments.length
          )
            throw new Error("codex_rollout_rewrite_hook_unproven");
          const escape = (value: string): string =>
            value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&apos;");
          const expectedContent = hookItem.fragments.map((part) => {
            const fragment = row(part);
            if (
              typeof fragment.text !== "string" ||
              typeof fragment.hookRunId !== "string" ||
              !fragment.hookRunId.trim() ||
              Object.keys(fragment).sort().join(",") !== "hookRunId,text"
            )
              throw new Error("codex_rollout_rewrite_hook_unproven");
            return {
              type: "input_text",
              text: `<hook_prompt hook_run_id="${escape(fragment.hookRunId)}">${escape(fragment.text)}</hook_prompt>`
            };
          });
          if (
            !isDeepStrictEqual(content, expectedContent) ||
            !isDeepStrictEqual(hookItem, {
              type: "HookPrompt",
              id: payload.id,
              fragments: hookItem.fragments
            })
          )
            throw new Error("codex_rollout_rewrite_hook_unproven");
          index++;
          if (!activeTurnId)
            startImplicit(original.timestamp, `rollout-${sourceIndex}`);
          consumeSynthetic(original.timestamp, {
            type: "item_completed",
            thread_id: input.externalSessionId,
            turn_id: activeTurnId,
            item: hookItem,
            completed_at_ms: Date.parse(String(original.timestamp))
          });
          reasoning = undefined;
          index--;
        } else if (looksLikeHook)
          throw new Error("codex_rollout_rewrite_hook_unproven");
      }
    }
    if (
      original.type === "event_msg" &&
      ["task_complete", "turn_aborted"].includes(String(payload.type))
    ) {
      if (payload.turn_id !== activeTurnId)
        throw new Error("codex_rollout_rewrite_unclosed_turn");
      activeTurnId = undefined;
      implicitTurn = false;
      reasoning = undefined;
    }
    index++;
  }
  finishImplicit(previous.at(-1)?.timestamp);
  if (activeTurnId) throw new Error("codex_rollout_rewrite_unclosed_turn");
  const liveStartOffset = rewritten.ends[index - 1]!;
  return {
    journalStartOffset,
    journalStartLine,
    liveStartOffset,
    liveStartLine: index,
    prefixDigest: createHash("sha256")
      .update(
        input.rewrittenBytes.subarray(journalStartOffset, liveStartOffset)
      )
      .digest("hex")
  };
};
