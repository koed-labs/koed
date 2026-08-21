import {
  extractPrivacyTextFields,
  reconstructPrivacyTextFields,
  type ExtractedPrivacyTextField,
  type MaskedPrivacyTextField,
  type PrivacyFieldSchema,
  type PrivacyJsonValue
} from "./privacy-field-extractor.js";

const SUPPORTED_ROOT_TYPES = new Set([
  "session_meta",
  "event_msg",
  "response_item",
  "compacted"
]);
const DROPPED_ROOT_TYPES = new Set(["turn_context"]);
const DROPPED_MESSAGE_ROLES = new Set(["system", "developer"]);
const PROHIBITED_INSTRUCTION_KEYS = new Set([
  "base_instructions",
  "developer_instructions",
  "system_instructions",
  "encrypted_content"
]);

export type CodexTeamSourceDropReason =
  | "hidden_reasoning"
  | "system_instructions"
  | "unsupported_record";

export type PreparedCodexTeamSourceRecord =
  | {
      disposition: "include";
      source: PrivacyJsonValue;
      schema: PrivacyFieldSchema;
      fields: ExtractedPrivacyTextField[];
    }
  | { disposition: "drop"; reason: CodexTeamSourceDropReason };

export class CodexTeamSourcePrivacyError extends TypeError {
  readonly code:
    | "malformed_record"
    | "unsupported_record"
    | "prohibited_content";

  constructor(code: CodexTeamSourcePrivacyError["code"], message: string) {
    super(message);
    this.name = "CodexTeamSourcePrivacyError";
    this.code = code;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const asJsonValue = (value: unknown): PrivacyJsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (!isObject(value)) {
    throw new CodexTeamSourcePrivacyError(
      "malformed_record",
      "Conversation Source record is not canonical JSON"
    );
  }
  const output: Record<string, PrivacyJsonValue> = {};
  for (const [key, item] of Object.entries(value))
    output[key] = asJsonValue(item);
  return output;
};

const containsProhibitedInstructionField = (
  value: PrivacyJsonValue
): boolean => {
  if (Array.isArray(value))
    return value.some(containsProhibitedInstructionField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      PROHIBITED_INSTRUCTION_KEYS.has(key) ||
      containsProhibitedInstructionField(item as PrivacyJsonValue)
  );
};

type CodexProtocolContext = {
  rootType: string;
};

const pathEquals = (
  path: readonly (string | number)[],
  expected: readonly (string | number)[]
): boolean =>
  path.length === expected.length &&
  path.every((segment, index) => segment === expected[index]);

const pathMatchesContentField = (
  path: readonly (string | number)[],
  field: string
): boolean =>
  path.length === 4 &&
  path[0] === "payload" &&
  path[1] === "content" &&
  typeof path[2] === "number" &&
  path[3] === field;

const isProtocolEnum = (value: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_.:/-]{0,255}$/u.test(value);

const isProtocolTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

const isProtocolIdentifier = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value
  ) || /^[A-Za-z][A-Za-z0-9]*[-_:][A-Za-z0-9_.:-]{1,255}$/u.test(value);

const isProtocolLiteral = (
  context: CodexProtocolContext,
  path: readonly (string | number)[],
  value: string
): boolean => {
  if (pathEquals(path, ["type"])) return isProtocolEnum(value);
  if (pathEquals(path, ["timestamp"])) return isProtocolTimestamp(value);

  if (
    pathEquals(path, ["payload", "type"]) ||
    pathEquals(path, ["payload", "role"]) ||
    pathEquals(path, ["payload", "status"]) ||
    pathEquals(path, ["payload", "phase"]) ||
    pathEquals(path, ["payload", "method"]) ||
    pathEquals(path, ["payload", "reasoning_effort"]) ||
    pathMatchesContentField(path, "type") ||
    pathMatchesContentField(path, "role")
  ) {
    return isProtocolEnum(value);
  }

  if (
    context.rootType === "session_meta" &&
    (pathEquals(path, ["payload", "id"]) ||
      pathEquals(path, ["payload", "parentThreadId"]))
  ) {
    return isProtocolIdentifier(value);
  }
  if (
    context.rootType === "event_msg" &&
    pathEquals(path, ["payload", "turn_id"])
  ) {
    return isProtocolIdentifier(value);
  }
  if (
    context.rootType === "response_item" &&
    (pathEquals(path, ["payload", "id"]) ||
      pathEquals(path, ["payload", "call_id"]) ||
      pathEquals(path, [
        "payload",
        "internal_chat_message_metadata_passthrough",
        "turn_id"
      ]))
  ) {
    return isProtocolIdentifier(value);
  }
  if (
    pathEquals(path, ["payload", "timestamp"]) &&
    context.rootType === "session_meta"
  ) {
    return isProtocolTimestamp(value);
  }
  return false;
};

const schemaFor = (
  value: PrivacyJsonValue,
  path: readonly (string | number)[],
  context: CodexProtocolContext
): PrivacyFieldSchema => {
  if (typeof value === "string") {
    return isProtocolLiteral(context, path, value)
      ? { kind: "literal" }
      : { kind: "text" };
  }
  if (Array.isArray(value)) {
    return {
      kind: "tuple",
      items: value.map((item, index) =>
        schemaFor(item, [...path, index], context)
      )
    };
  }
  if (isObject(value)) {
    return {
      kind: "object",
      fields: Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field,
          schemaFor(item as PrivacyJsonValue, [...path, field], context)
        ])
      )
    };
  }
  return { kind: "scalar" };
};

const objectSchema = (
  value: Record<string, PrivacyJsonValue>,
  context: CodexProtocolContext
): PrivacyFieldSchema => ({
  kind: "object",
  fields: Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      schemaFor(item, [key], context)
    ])
  )
});

const payloadOf = (
  record: Record<string, PrivacyJsonValue>
): Record<string, PrivacyJsonValue> | null =>
  isObject(record.payload)
    ? (record.payload as Record<string, PrivacyJsonValue>)
    : null;

export const prepareCodexTeamSourceRecord = (input: {
  record: unknown;
  decodedSource?: string | Uint8Array;
}): PreparedCodexTeamSourceRecord => {
  const source = asJsonValue(input.record);
  if (!isObject(source)) {
    throw new CodexTeamSourcePrivacyError(
      "malformed_record",
      "Conversation Source record must be an object"
    );
  }
  const type = source.type;
  if (typeof type !== "string") {
    throw new CodexTeamSourcePrivacyError(
      "unsupported_record",
      "Conversation Source record has no supported type"
    );
  }
  if (DROPPED_ROOT_TYPES.has(type)) {
    return { disposition: "drop", reason: "system_instructions" };
  }
  if (!SUPPORTED_ROOT_TYPES.has(type)) {
    throw new CodexTeamSourcePrivacyError(
      "unsupported_record",
      "Conversation Source record type is unsupported"
    );
  }
  const payload = payloadOf(source as Record<string, PrivacyJsonValue>);
  if (type === "response_item" && payload?.type === "reasoning") {
    return { disposition: "drop", reason: "hidden_reasoning" };
  }
  if (
    (payload &&
      typeof payload.role === "string" &&
      DROPPED_MESSAGE_ROLES.has(payload.role)) ||
    containsProhibitedInstructionField(source as PrivacyJsonValue)
  ) {
    return { disposition: "drop", reason: "system_instructions" };
  }

  const schema = objectSchema(source as Record<string, PrivacyJsonValue>, {
    rootType: type
  });
  const fields = extractPrivacyTextFields({
    source: source as PrivacyJsonValue,
    schema,
    decodedSource: input.decodedSource
  });
  return { disposition: "include", source, schema, fields };
};

export const reconstructCodexTeamSourceRecord = (input: {
  prepared: Extract<PreparedCodexTeamSourceRecord, { disposition: "include" }>;
  fields: readonly MaskedPrivacyTextField[];
}): PrivacyJsonValue =>
  reconstructPrivacyTextFields({
    source: input.prepared.source,
    schema: input.prepared.schema,
    fields: input.fields
  });

export const serializeCodexTeamSourceRecord = (
  record: PrivacyJsonValue
): string => `${JSON.stringify(record)}\n`;
