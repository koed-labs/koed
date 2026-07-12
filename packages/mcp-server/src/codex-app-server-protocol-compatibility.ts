import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type JsonRecord = Record<string, unknown>;

const DEFAULT_SCHEMA_GENERATION_TIMEOUT_MS = 10_000;

export interface CodexConversationProtocolCompatibility {
  schemaSha256: string;
  notificationMethods: string[];
  requestMethods: string[];
  threadItemTypes: string[];
}

const REQUIRED_NOTIFICATION_METHODS = [
  "thread/started",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated"
] as const;

const REQUIRED_REQUEST_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt"
] as const;

const REQUIRED_THREAD_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "plan",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
] as const;

const REQUIRED_SCHEMA_FIELDS: Array<{
  file: string;
  fields: readonly string[];
}> = [
  {
    file: "v2/ThreadStartedNotification.json",
    fields: ["thread"]
  },
  {
    file: "v2/ItemStartedNotification.json",
    fields: ["item", "threadId", "turnId", "startedAtMs"]
  },
  {
    file: "v2/ItemCompletedNotification.json",
    fields: ["item", "threadId", "turnId", "completedAtMs"]
  },
  {
    file: "v2/TurnCompletedNotification.json",
    fields: ["threadId", "turn"]
  },
  {
    file: "v2/TurnStartedNotification.json",
    fields: ["threadId", "turn"]
  },
  {
    file: "v2/ThreadTokenUsageUpdatedNotification.json",
    fields: ["threadId", "turnId", "tokenUsage"]
  },
  {
    file: "v2/AgentMessageDeltaNotification.json",
    fields: ["delta", "itemId", "threadId", "turnId"]
  },
  {
    file: "v2/CommandExecutionOutputDeltaNotification.json",
    fields: ["delta", "itemId", "threadId", "turnId"]
  },
  {
    file: "v2/FileChangeOutputDeltaNotification.json",
    fields: ["delta", "itemId", "threadId", "turnId"]
  },
  {
    file: "v2/PlanDeltaNotification.json",
    fields: ["delta", "itemId", "threadId", "turnId"]
  },
  {
    file: "v2/ReasoningSummaryTextDeltaNotification.json",
    fields: ["delta", "itemId", "summaryIndex", "threadId", "turnId"]
  },
  {
    file: "v2/ReasoningTextDeltaNotification.json",
    fields: ["contentIndex", "delta", "itemId", "threadId", "turnId"]
  },
  {
    file: "v2/ThreadStartResponse.json",
    fields: ["thread"]
  },
  {
    file: "v2/ThreadResumeResponse.json",
    fields: ["thread"]
  },
  {
    file: "v2/TurnStartResponse.json",
    fields: ["turn"]
  },
  {
    file: "v2/ThreadResumeParams.json",
    fields: ["threadId"]
  },
  {
    file: "v2/TurnStartParams.json",
    fields: ["input", "threadId"]
  },
  {
    file: "v2/TurnInterruptParams.json",
    fields: ["threadId", "turnId"]
  }
] as const;

const REQUIRED_DEFINITION_FIELDS: Array<{
  file: string;
  definition: string;
  fields: readonly string[];
}> = [
  {
    file: "v2/ThreadStartedNotification.json",
    definition: "Thread",
    fields: ["id", "sessionId", "ephemeral"]
  },
  {
    file: "v2/ThreadStartResponse.json",
    definition: "Thread",
    fields: ["id", "sessionId"]
  },
  {
    file: "v2/ThreadResumeResponse.json",
    definition: "Thread",
    fields: ["id", "sessionId"]
  },
  {
    file: "v2/TurnStartResponse.json",
    definition: "Turn",
    fields: ["id"]
  },
  {
    file: "v2/TurnStartedNotification.json",
    definition: "Turn",
    fields: ["id"]
  },
  {
    file: "v2/TurnCompletedNotification.json",
    definition: "Turn",
    fields: ["id"]
  }
] as const;

const REQUIRED_DEFINITION_PROPERTIES: Array<{
  file: string;
  definition: string;
  fields: readonly string[];
}> = [
  {
    file: "v2/ThreadStartedNotification.json",
    definition: "Thread",
    fields: ["parentThreadId", "path"]
  }
] as const;

const REQUIRED_SCHEMA_PROPERTIES: Array<{
  file: string;
  fields: readonly string[];
}> = [
  {
    file: "v2/TurnStartParams.json",
    fields: ["clientUserMessageId"]
  },
  {
    file: "v2/ThreadStartParams.json",
    fields: ["historyMode"]
  }
] as const;

const THREAD_ITEM_SCHEMA_FILES = [
  "v2/ItemStartedNotification.json",
  "v2/ItemCompletedNotification.json"
] as const;

type SemanticPropertyShape =
  | "present"
  | "string"
  | "array"
  | "string_array"
  | "integer";

const THREAD_ITEM_SEMANTIC_REQUIREMENTS: Record<
  string,
  {
    required?: readonly string[];
    properties: Readonly<Record<string, SemanticPropertyShape>>;
  }
> = {
  userMessage: {
    required: ["content"],
    properties: { content: "array" }
  },
  agentMessage: {
    required: ["text"],
    properties: { text: "string", phase: "present" }
  },
  reasoning: {
    properties: { summary: "string_array", content: "string_array" }
  },
  commandExecution: {
    required: ["command", "status"],
    properties: {
      command: "string",
      aggregatedOutput: "string",
      exitCode: "integer",
      status: "present",
      durationMs: "integer"
    }
  },
  mcpToolCall: {
    required: ["arguments", "server", "status", "tool"],
    properties: {
      server: "string",
      tool: "string",
      arguments: "present",
      result: "present",
      error: "present",
      status: "present",
      durationMs: "integer"
    }
  },
  dynamicToolCall: {
    required: ["arguments", "status", "tool"],
    properties: {
      tool: "string",
      arguments: "present",
      contentItems: "array",
      success: "present",
      status: "present",
      durationMs: "integer"
    }
  },
  collabAgentToolCall: {
    required: ["agentsStates", "receiverThreadIds", "status", "tool"],
    properties: {
      tool: "present",
      agentsStates: "present",
      prompt: "present",
      receiverThreadIds: "array",
      status: "present"
    }
  }
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readSchema = (directory: string, relativePath: string): JsonRecord => {
  const filePath = path.join(directory, relativePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Codex app-server protocol schema is missing or malformed: ${relativePath}`,
      { cause: error }
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `Codex app-server protocol schema is not an object: ${relativePath}`
    );
  }
  return parsed;
};

const schemaDefinition = (
  schema: JsonRecord,
  name: string
): JsonRecord | null => {
  const definitions = isRecord(schema.definitions)
    ? schema.definitions
    : isRecord(schema.$defs)
      ? schema.$defs
      : {};
  return isRecord(definitions[name]) ? definitions[name] : null;
};

const requiredFields = (schema: JsonRecord): Set<string> =>
  new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : []
  );

const schemaProperties = (schema: JsonRecord): Set<string> =>
  new Set(isRecord(schema.properties) ? Object.keys(schema.properties) : []);

const propertySchema = (schema: JsonRecord, field: string): unknown =>
  isRecord(schema.properties) ? schema.properties[field] : undefined;

const schemaAlternatives = (
  value: unknown,
  root: JsonRecord,
  seen = new Set<string>()
): unknown[] => {
  if (value === true || value === false || !isRecord(value)) {
    return [value];
  }
  const alternatives: unknown[] = [value];
  const reference = typeof value.$ref === "string" ? value.$ref : undefined;
  const definitionPrefix = "#/definitions/";
  const defsPrefix = "#/$defs/";
  if (reference && !seen.has(reference)) {
    const definitionName = reference.startsWith(definitionPrefix)
      ? reference.slice(definitionPrefix.length)
      : reference.startsWith(defsPrefix)
        ? reference.slice(defsPrefix.length)
        : undefined;
    if (definitionName) {
      const definition = schemaDefinition(root, definitionName);
      if (definition) {
        const nextSeen = new Set(seen);
        nextSeen.add(reference);
        alternatives.push(...schemaAlternatives(definition, root, nextSeen));
      }
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const nested = value[keyword];
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        alternatives.push(...schemaAlternatives(entry, root, seen));
      }
    }
  }
  return alternatives;
};

const schemaAllowsType = (
  value: unknown,
  expected: "string" | "array" | "integer",
  root: JsonRecord
): boolean =>
  schemaAlternatives(value, root).some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }
    const types = Array.isArray(candidate.type)
      ? candidate.type
      : typeof candidate.type === "string"
        ? [candidate.type]
        : [];
    return types.includes(expected);
  });

const schemaIsStringArray = (value: unknown, root: JsonRecord): boolean =>
  schemaAlternatives(value, root).some((candidate) => {
    if (!isRecord(candidate) || !schemaAllowsType(candidate, "array", root)) {
      return false;
    }
    return schemaAllowsType(candidate.items, "string", root);
  });

const semanticShapeMatches = (
  value: unknown,
  shape: SemanticPropertyShape,
  root: JsonRecord
): boolean => {
  if (value === undefined || value === false) {
    return false;
  }
  if (shape === "present") {
    return true;
  }
  if (shape === "string_array") {
    return schemaIsStringArray(value, root);
  }
  return schemaAllowsType(value, shape, root);
};

const stringEnumsForProperty = (
  value: unknown,
  propertyName: string,
  output = new Set<string>()
): Set<string> => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      stringEnumsForProperty(entry, propertyName, output);
    }
    return output;
  }
  if (!isRecord(value)) {
    return output;
  }
  const properties = isRecord(value.properties) ? value.properties : null;
  const property =
    properties && isRecord(properties[propertyName])
      ? properties[propertyName]
      : null;
  if (property && Array.isArray(property.enum)) {
    for (const entry of property.enum) {
      if (typeof entry === "string") {
        output.add(entry);
      }
    }
  }
  for (const nested of Object.values(value)) {
    stringEnumsForProperty(nested, propertyName, output);
  }
  return output;
};

const assertContains = (
  label: string,
  actual: ReadonlySet<string>,
  required: readonly string[]
): void => {
  const missing = required.filter((entry) => !actual.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Unsupported Codex app-server protocol: missing ${label}: ${missing.join(", ")}`
    );
  }
};

const threadItemVariants = (schema: JsonRecord): Map<string, JsonRecord> => {
  const threadItem = schemaDefinition(schema, "ThreadItem");
  const variants =
    threadItem && Array.isArray(threadItem.oneOf) ? threadItem.oneOf : [];
  const output = new Map<string, JsonRecord>();
  for (const value of variants) {
    if (!isRecord(value)) {
      continue;
    }
    const properties = isRecord(value.properties) ? value.properties : {};
    const typeProperty = isRecord(properties.type) ? properties.type : {};
    const types = Array.isArray(typeProperty.enum) ? typeProperty.enum : [];
    for (const type of types) {
      if (typeof type === "string") {
        output.set(type, value);
      }
    }
  }
  return output;
};

const assertThreadItemIdentity = (file: string, schema: JsonRecord): void => {
  const variants = threadItemVariants(schema);
  assertContains(
    `${file} ThreadItem variants`,
    new Set(variants.keys()),
    REQUIRED_THREAD_ITEM_TYPES
  );
  for (const type of REQUIRED_THREAD_ITEM_TYPES) {
    const variant = variants.get(type);
    if (!variant) {
      continue;
    }
    assertContains(
      `${file} ${type} required identity fields`,
      requiredFields(variant),
      ["id", "type"]
    );
    if (type === "userMessage") {
      assertContains(
        `${file} userMessage identity properties`,
        schemaProperties(variant),
        ["clientId"]
      );
    }
  }
};

const assertThreadItemSemantics = (file: string, schema: JsonRecord): void => {
  const variants = threadItemVariants(schema);
  for (const [type, requirement] of Object.entries(
    THREAD_ITEM_SEMANTIC_REQUIREMENTS
  )) {
    const variant = variants.get(type);
    if (!variant) {
      continue;
    }
    if (requirement.required) {
      assertContains(
        `${file} ${type} required semantic fields`,
        requiredFields(variant),
        requirement.required
      );
    }
    for (const [field, shape] of Object.entries(requirement.properties)) {
      if (
        !semanticShapeMatches(propertySchema(variant, field), shape, schema)
      ) {
        throw new Error(
          `Unsupported Codex app-server protocol: invalid ${file} ${type} semantic property: ${field} (${shape})`
        );
      }
    }
  }
};

export const assertCodexConversationProtocolCompatibility = (input: {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): CodexConversationProtocolCompatibility => {
  const schemaGenerationTimeoutMs =
    typeof input.timeoutMs === "number" &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : DEFAULT_SCHEMA_GENERATION_TIMEOUT_MS;
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-codex-protocol-")
  );
  try {
    const generated = spawnSync(
      input.binary,
      [
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        outputDirectory
      ],
      {
        cwd: input.cwd,
        env: input.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: schemaGenerationTimeoutMs,
        shell: process.platform === "win32",
        windowsHide: true
      }
    );
    if (generated.error || generated.status !== 0) {
      if (
        generated.error &&
        "code" in generated.error &&
        generated.error.code === "ETIMEDOUT"
      ) {
        throw new Error(
          `Codex app-server protocol schema generation timed out after ${schemaGenerationTimeoutMs}ms`,
          { cause: generated.error }
        );
      }
      const detail = (generated.stderr || generated.stdout || "").trim();
      throw new Error(
        `Codex app-server protocol schema generation failed${
          detail ? `: ${detail.slice(0, 500)}` : ""
        }`,
        generated.error ? { cause: generated.error } : undefined
      );
    }

    const serverNotifications = readSchema(
      outputDirectory,
      "ServerNotification.json"
    );
    const clientRequests = readSchema(outputDirectory, "ClientRequest.json");
    const schemaCache = new Map<string, JsonRecord>();
    const schemaFor = (file: string): JsonRecord => {
      const cached = schemaCache.get(file);
      if (cached) {
        return cached;
      }
      const schema = readSchema(outputDirectory, file);
      schemaCache.set(file, schema);
      return schema;
    };
    const completedItem = schemaFor("v2/ItemCompletedNotification.json");
    const notificationMethods = stringEnumsForProperty(
      serverNotifications,
      "method"
    );
    const requestMethods = stringEnumsForProperty(clientRequests, "method");
    const threadItemTypes = new Set(threadItemVariants(completedItem).keys());
    assertContains(
      "notification methods",
      notificationMethods,
      REQUIRED_NOTIFICATION_METHODS
    );
    assertContains("request methods", requestMethods, REQUIRED_REQUEST_METHODS);
    assertContains(
      "ThreadItem variants",
      threadItemTypes,
      REQUIRED_THREAD_ITEM_TYPES
    );

    for (const requirement of REQUIRED_SCHEMA_FIELDS) {
      const schema = schemaFor(requirement.file);
      assertContains(
        `${requirement.file} required fields`,
        requiredFields(schema),
        requirement.fields
      );
    }
    for (const requirement of REQUIRED_DEFINITION_FIELDS) {
      const schema = schemaFor(requirement.file);
      const definition = schemaDefinition(schema, requirement.definition);
      if (!definition) {
        throw new Error(
          `Unsupported Codex app-server protocol: missing ${requirement.file} definition: ${requirement.definition}`
        );
      }
      assertContains(
        `${requirement.file} ${requirement.definition} required fields`,
        requiredFields(definition),
        requirement.fields
      );
    }
    for (const requirement of REQUIRED_DEFINITION_PROPERTIES) {
      const schema = schemaFor(requirement.file);
      const definition = schemaDefinition(schema, requirement.definition);
      if (!definition) {
        throw new Error(
          `Unsupported Codex app-server protocol: missing ${requirement.file} definition: ${requirement.definition}`
        );
      }
      assertContains(
        `${requirement.file} ${requirement.definition} properties`,
        schemaProperties(definition),
        requirement.fields
      );
    }
    for (const requirement of REQUIRED_SCHEMA_PROPERTIES) {
      const schema = schemaFor(requirement.file);
      assertContains(
        `${requirement.file} properties`,
        schemaProperties(schema),
        requirement.fields
      );
    }
    for (const file of THREAD_ITEM_SCHEMA_FILES) {
      const schema = schemaFor(file);
      assertThreadItemIdentity(file, schema);
      assertThreadItemSemantics(file, schema);
    }

    const fingerprint = createHash("sha256");
    for (const [file, schema] of [...schemaCache.entries()].sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      fingerprint.update(file);
      fingerprint.update(JSON.stringify(schema));
    }
    fingerprint.update(JSON.stringify(serverNotifications));
    fingerprint.update(JSON.stringify(clientRequests));
    const compatibility = {
      schemaSha256: fingerprint.digest("hex"),
      notificationMethods: [...notificationMethods].sort(),
      requestMethods: [...requestMethods].sort(),
      threadItemTypes: [...threadItemTypes].sort()
    };
    return compatibility;
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
};
