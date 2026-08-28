import { createHash } from "node:crypto";

import { classifyApprovalActivity } from "./approval-activity.js";
import type { SharedMemoryRepresentation } from "./collaboration-contract.js";
import { crossIdentitySyncDigest } from "./cross-identity-sync.js";
import {
  LCM_LEXICAL_ANCHOR_MAX_COUNT,
  LCM_LEXICAL_ANCHOR_MAX_LENGTH
} from "./lcm-summary-limits.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ITEMS = 2_048;
export const SHARED_MEMORY_SEMANTIC_FIELD_MAX_BYTES = 256 * 1_024;
export const SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS = 65_536;
export const SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES = 64 * 1_024 * 1_024;
export const SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES =
  80 * 1_024 * 1_024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_KEYS = 2_000;

export const sharedMemoryRepresentations = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups",
  "curated_assertions"
] as const;

export type SharedMemorySourceItemType =
  | "user_message"
  | "assistant_message"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "lcm_leaf"
  | "lcm_rollup"
  | "curated_assertion";

export interface SharedMemorySourceItemInput {
  itemType: string;
  schemaVersion: number;
  sourceId: string;
  sourceLogicalMemoryId: string;
  sourceRevision: number;
  occurredAt?: string | null;
  classification?: {
    hiddenReasoning?: boolean;
    systemInstruction?: boolean;
    containsCredentials?: boolean;
    unsupportedProtocolItem?: boolean;
  };
  content: unknown;
}

export interface SharedMemoryCanonicalSourceItemDto {
  itemType: SharedMemorySourceItemType;
  schemaVersion: 1;
  sourceId: string;
  sourceLogicalMemoryId: string;
  sourceRevision: number;
  occurredAt: string | null;
  content: Record<string, unknown>;
}

export interface SharedMemorySemanticClassificationField {
  path: string;
  text: string;
  inputSha256: string;
  inputByteLength: number;
  replacementMode: "replace_value" | "reject_if_changed";
}

export interface SharedMemorySemanticMaskedField {
  path: string;
  inputSha256: string;
  inputByteLength: number;
  sanitizedText: string;
}

export class SharedMemoryConflictError extends Error {
  statusCode = 409;

  constructor(message = "Shared Memory optimistic version conflict") {
    super(message);
    this.name = "SharedMemoryConflictError";
  }
}

export class SharedMemorySourceItemRejectedError extends Error {
  statusCode = 422;

  constructor(
    public readonly reasonCode:
      | "unknown_item_type"
      | "unknown_schema_version"
      | "hidden_reasoning"
      | "system_instruction"
      | "unsupported_protocol_item"
      | "invalid_item_schema"
      | "wrong_representation"
      | "cross_memory_provenance"
      | "approval_activity_excluded"
  ) {
    super(`Shared Memory source item rejected: ${reasonCode}`);
    this.name = "SharedMemorySourceItemRejectedError";
  }
}

export class SharedMemorySemanticResourceLimitError extends SharedMemorySourceItemRejectedError {
  constructor(
    public readonly limitKind:
      | "field_bytes"
      | "preview_items"
      | "preview_fields"
      | "preview_bytes"
      | "preview_encoded_bytes",
    public readonly observed: number,
    public readonly maximum: number
  ) {
    super("invalid_item_schema");
    this.name = "SharedMemorySemanticResourceLimitError";
  }
}

const exactObjectKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const prohibitedInstructionKeyPattern =
  /^(?:hidden[_-]?reasoning|chain[_-]?of[_-]?thought|system[_-]?(?:instruction|message|prompt))$/i;

const validateStructuredValue = (
  value: unknown,
  state: { depth: number; keys: { count: number } }
): unknown => {
  if (state.depth > MAX_JSON_DEPTH || state.keys.count > MAX_JSON_KEYS) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
    }
    return value;
  }
  if (typeof value === "string") {
    const inputBytes = Buffer.byteLength(value, "utf8");
    if (inputBytes > SHARED_MEMORY_SEMANTIC_FIELD_MAX_BYTES) {
      throw new SharedMemorySemanticResourceLimitError(
        "field_bytes",
        inputBytes,
        SHARED_MEMORY_SEMANTIC_FIELD_MAX_BYTES
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    state.keys.count += value.length;
    return value.map((item) =>
      validateStructuredValue(item, { ...state, depth: state.depth + 1 })
    );
  }
  if (!isPlainObject(value)) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    state.keys.count += 1;
    if (prohibitedInstructionKeyPattern.test(key)) {
      throw new SharedMemorySourceItemRejectedError("system_instruction");
    }
    output[key] = validateStructuredValue(item, {
      ...state,
      depth: state.depth + 1
    });
  }
  return output;
};

const requiredString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateTextContent = (content: unknown): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, ["text"]) ||
    !requiredString(content.text)
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    text: validateStructuredValue(content.text, {
      depth: 0,
      keys: { count: 0 }
    })
  };
};

const validateToolContent = (content: unknown): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, ["toolName", "toolCallId", "payload"]) ||
    !requiredString(content.toolName) ||
    (content.toolCallId !== null && !requiredString(content.toolCallId)) ||
    !("payload" in content)
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    toolName: content.toolName,
    toolCallId: content.toolCallId,
    payload: validateStructuredValue(content.payload, {
      depth: 0,
      keys: { count: 0 }
    })
  };
};

const validateExpansionItems = (
  value: unknown,
  allowedTypes: readonly SharedMemorySourceItemType[]
): SharedMemoryCanonicalSourceItemDto[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ITEMS
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return value.map((entry) => {
    if (
      !isPlainObject(entry) ||
      !exactObjectKeys(entry, [
        "itemType",
        "schemaVersion",
        "sourceId",
        "sourceLogicalMemoryId",
        "sourceRevision",
        "occurredAt",
        "content"
      ]) ||
      !allowedTypes.includes(entry.itemType as SharedMemorySourceItemType) ||
      entry.schemaVersion !== 1 ||
      !requiredString(entry.sourceId) ||
      !UUID_PATTERN.test(entry.sourceId) ||
      !requiredString(entry.sourceLogicalMemoryId) ||
      !UUID_PATTERN.test(entry.sourceLogicalMemoryId) ||
      !Number.isSafeInteger(entry.sourceRevision) ||
      Number(entry.sourceRevision) < 0 ||
      (entry.occurredAt !== null &&
        (typeof entry.occurredAt !== "string" ||
          Number.isNaN(Date.parse(entry.occurredAt))))
    ) {
      throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
    }
    const itemType = entry.itemType as SharedMemorySourceItemType;
    const content =
      itemType === "user_message" ||
      itemType === "assistant_message" ||
      itemType === "thought"
        ? validateTextContent(entry.content)
        : itemType === "tool_call" || itemType === "tool_result"
          ? validateToolContent(entry.content)
          : itemType === "curated_assertion"
            ? validateCuratedAssertionContent(entry.content)
            : validateLcmContent(entry.content, itemType);
    return {
      itemType,
      schemaVersion: 1,
      sourceId: entry.sourceId,
      sourceLogicalMemoryId: entry.sourceLogicalMemoryId,
      sourceRevision: Number(entry.sourceRevision),
      occurredAt: entry.occurredAt as string | null,
      content
    };
  });
};

const validateLcmContent = (
  content: unknown,
  itemType: "lcm_leaf" | "lcm_rollup"
): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, [
      "title",
      "summaryText",
      "lexicalAnchors",
      "sourceIds",
      "expansionItems"
    ]) ||
    (content.title !== undefined && typeof content.title !== "string") ||
    !requiredString(content.summaryText) ||
    !Array.isArray(content.lexicalAnchors) ||
    content.lexicalAnchors.length > LCM_LEXICAL_ANCHOR_MAX_COUNT ||
    content.lexicalAnchors.some(
      (value) =>
        !requiredString(value) || value.length > LCM_LEXICAL_ANCHOR_MAX_LENGTH
    ) ||
    new Set(content.lexicalAnchors).size !== content.lexicalAnchors.length ||
    !Array.isArray(content.sourceIds) ||
    content.sourceIds.length === 0 ||
    content.sourceIds.some(
      (value) => !requiredString(value) || !UUID_PATTERN.test(value)
    )
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    ...(typeof content.title === "string"
      ? {
          title: validateStructuredValue(content.title, {
            depth: 0,
            keys: { count: 0 }
          })
        }
      : {}),
    summaryText: validateStructuredValue(content.summaryText, {
      depth: 0,
      keys: { count: 0 }
    }),
    lexicalAnchors: validateStructuredValue(content.lexicalAnchors, {
      depth: 0,
      keys: { count: 0 }
    }),
    sourceIds: [...new Set(content.sourceIds as string[])],
    ...(content.expansionItems === undefined
      ? {}
      : {
          expansionItems: validateExpansionItems(
            content.expansionItems,
            itemType === "lcm_rollup"
              ? ["lcm_leaf"]
              : [
                  "user_message",
                  "assistant_message",
                  "thought",
                  "tool_call",
                  "tool_result"
                ]
          )
        })
  };
};

const validateCuratedAssertionContent = (
  content: unknown
): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, [
      "assertionText",
      "topicTitle",
      "tags",
      "sourceCount",
      "expansionItems"
    ]) ||
    !requiredString(content.assertionText) ||
    (content.topicTitle !== null &&
      content.topicTitle !== undefined &&
      typeof content.topicTitle !== "string") ||
    !Array.isArray(content.tags) ||
    content.tags.some((tag) => !requiredString(tag)) ||
    !Number.isSafeInteger(content.sourceCount) ||
    Number(content.sourceCount) < 1
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    assertionText: validateStructuredValue(content.assertionText, {
      depth: 0,
      keys: { count: 0 }
    }),
    topicTitle:
      typeof content.topicTitle === "string"
        ? validateStructuredValue(content.topicTitle, {
            depth: 0,
            keys: { count: 0 }
          })
        : null,
    tags: validateStructuredValue(content.tags, {
      depth: 0,
      keys: { count: 0 }
    }),
    sourceCount: content.sourceCount,
    ...(content.expansionItems === undefined
      ? {}
      : {
          expansionItems: validateExpansionItems(content.expansionItems, [
            "user_message",
            "assistant_message",
            "thought",
            "tool_call",
            "tool_result",
            "lcm_leaf",
            "lcm_rollup"
          ])
        })
  };
};

const SEMANTIC_PATH_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const semanticObjectPath = (parent: string, key: string): string =>
  SEMANTIC_PATH_IDENTIFIER_PATTERN.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;

type ClassificationFieldWithSegments =
  SharedMemorySemanticClassificationField & {
    segments: Array<string | number>;
  };

const collectClassificationFields = (
  items: readonly SharedMemoryCanonicalSourceItemDto[]
): ClassificationFieldWithSegments[] => {
  const fields: ClassificationFieldWithSegments[] = [];
  const add = (
    path: string,
    segments: Array<string | number>,
    text: string,
    replacementMode: SharedMemorySemanticClassificationField["replacementMode"] = "replace_value"
  ): void => {
    fields.push({
      path,
      segments,
      text,
      inputSha256: createHash("sha256").update(text, "utf8").digest("hex"),
      inputByteLength: Buffer.byteLength(text, "utf8"),
      replacementMode
    });
  };
  const visitStructuredStrings = (
    value: unknown,
    path: string,
    segments: Array<string | number>
  ): void => {
    if (typeof value === "string") {
      add(path, segments, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visitStructuredStrings(entry, `${path}.${index}`, [...segments, index])
      );
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [keyIndex, key] of Object.keys(value).sort().entries()) {
      add(`${path}.$key.${keyIndex}`, [], key, "reject_if_changed");
      visitStructuredStrings(value[key], semanticObjectPath(path, key), [
        ...segments,
        key
      ]);
    }
  };
  const visitItem = (
    item: SharedMemoryCanonicalSourceItemDto,
    path: string,
    segments: Array<string | number>
  ): void => {
    const contentPath = `${path}.content`;
    const contentSegments = [...segments, "content"];
    const addContent = (key: string, text: string): void =>
      add(`${contentPath}.${key}`, [...contentSegments, key], text);
    const visitExpansionItems = (): void => {
      const expansionItems = item.content.expansionItems;
      if (!Array.isArray(expansionItems)) return;
      expansionItems.forEach((entry, index) =>
        visitItem(
          entry as SharedMemoryCanonicalSourceItemDto,
          `${contentPath}.expansionItems.${index}`,
          [...contentSegments, "expansionItems", index]
        )
      );
    };

    if (
      item.itemType === "user_message" ||
      item.itemType === "assistant_message" ||
      item.itemType === "thought"
    ) {
      addContent("text", String(item.content.text));
      return;
    }
    if (item.itemType === "tool_call" || item.itemType === "tool_result") {
      addContent("toolName", String(item.content.toolName));
      visitStructuredStrings(item.content.payload, `${contentPath}.payload`, [
        ...contentSegments,
        "payload"
      ]);
      return;
    }
    if (item.itemType === "lcm_leaf" || item.itemType === "lcm_rollup") {
      if (typeof item.content.title === "string") {
        addContent("title", item.content.title);
      }
      addContent("summaryText", String(item.content.summaryText));
      const lexicalAnchors = item.content.lexicalAnchors;
      if (Array.isArray(lexicalAnchors)) {
        lexicalAnchors.forEach((anchor, index) => {
          if (typeof anchor === "string") {
            add(
              `${contentPath}.lexicalAnchors.${index}`,
              [...contentSegments, "lexicalAnchors", index],
              anchor
            );
          }
        });
      }
      visitExpansionItems();
      return;
    }
    addContent("assertionText", String(item.content.assertionText));
    if (typeof item.content.topicTitle === "string") {
      addContent("topicTitle", item.content.topicTitle);
    }
    const tags = item.content.tags;
    if (Array.isArray(tags)) {
      tags.forEach((tag, index) => {
        if (typeof tag === "string") {
          add(
            `${contentPath}.tags.${index}`,
            [...contentSegments, "tags", index],
            tag
          );
        }
      });
    }
    visitExpansionItems();
  };

  items.forEach((item, index) => visitItem(item, `items.${index}`, [index]));
  return fields;
};

export const extractSharedMemorySemanticClassificationFields = (
  items: readonly SharedMemoryCanonicalSourceItemDto[]
): SharedMemorySemanticClassificationField[] => {
  if (items.length === 0) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (items.length > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ITEMS) {
    throw new SharedMemorySemanticResourceLimitError(
      "preview_items",
      items.length,
      SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ITEMS
    );
  }
  const previewBytes = Buffer.byteLength(JSON.stringify(items), "utf8");
  if (previewBytes > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES) {
    throw new SharedMemorySemanticResourceLimitError(
      "preview_encoded_bytes",
      previewBytes,
      SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES
    );
  }
  const fields = collectClassificationFields(items);
  if (fields.length === 0) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (fields.length > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS) {
    throw new SharedMemorySemanticResourceLimitError(
      "preview_fields",
      fields.length,
      SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS
    );
  }
  const fieldBytes = fields.reduce(
    (total, field) => total + field.inputByteLength,
    0
  );
  if (fieldBytes > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES) {
    throw new SharedMemorySemanticResourceLimitError(
      "preview_bytes",
      fieldBytes,
      SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES
    );
  }
  return fields.map((field) => ({
    path: field.path,
    text: field.text,
    inputSha256: field.inputSha256,
    inputByteLength: field.inputByteLength,
    replacementMode: field.replacementMode
  }));
};

const maskClassificationFields = (
  value: unknown,
  path: string,
  allowedPaths: ReadonlySet<string>
): unknown => {
  if (typeof value === "string") {
    return allowedPaths.has(path) ? { semanticSanitizedString: true } : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      maskClassificationFields(entry, `${path}.${index}`, allowedPaths)
    );
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        maskClassificationFields(
          value[key],
          semanticObjectPath(path, key),
          allowedPaths
        )
      ])
  );
};

export const validateSharedMemorySemanticSanitizedReconstruction = (
  authoritativeItems: readonly SharedMemoryCanonicalSourceItemDto[],
  sanitizedItems: readonly SharedMemoryCanonicalSourceItemDto[]
): void => {
  const authoritativeFields = collectClassificationFields(authoritativeItems);
  const sanitizedFields = collectClassificationFields(sanitizedItems);
  const authoritativePaths = authoritativeFields.map((field) => field.path);
  const sanitizedPaths = sanitizedFields.map((field) => field.path);
  if (
    crossIdentitySyncDigest(authoritativePaths) !==
    crossIdentitySyncDigest(sanitizedPaths)
  ) {
    throw new SharedMemoryConflictError(
      "Sanitized semantic content fields do not match the authoritative schema"
    );
  }
  const allowedPaths = new Set(authoritativePaths);
  if (
    crossIdentitySyncDigest(
      maskClassificationFields(authoritativeItems, "items", allowedPaths)
    ) !==
    crossIdentitySyncDigest(
      maskClassificationFields(sanitizedItems, "items", allowedPaths)
    )
  ) {
    throw new SharedMemoryConflictError(
      "Sanitized semantic DTO changed identity, order, shape, or non-string content"
    );
  }
};

const itemTypesByRepresentation: Record<
  SharedMemoryRepresentation,
  readonly SharedMemorySourceItemType[]
> = {
  memory_events: [
    "user_message",
    "assistant_message",
    "thought",
    "tool_call",
    "tool_result"
  ],
  lcm_leaves: ["lcm_leaf"],
  lcm_rollups: ["lcm_rollup"],
  curated_assertions: ["curated_assertion"]
};

export const validateSharedMemoryCanonicalSourceItem = (input: {
  representation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  sourceRevision: number;
  item: SharedMemorySourceItemInput;
}): SharedMemoryCanonicalSourceItemDto => {
  const { item } = input;
  if (
    !isPlainObject(item) ||
    !exactObjectKeys(item, [
      "itemType",
      "schemaVersion",
      "sourceId",
      "sourceLogicalMemoryId",
      "sourceRevision",
      "occurredAt",
      "classification",
      "content"
    ]) ||
    (item.classification !== undefined &&
      (!isPlainObject(item.classification) ||
        !exactObjectKeys(item.classification, [
          "hiddenReasoning",
          "systemInstruction",
          "containsCredentials",
          "unsupportedProtocolItem"
        ]) ||
        Object.values(item.classification).some(
          (value) => typeof value !== "boolean"
        )))
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (!sharedMemoryRepresentations.includes(input.representation)) {
    throw new SharedMemorySourceItemRejectedError("wrong_representation");
  }
  if (
    !itemTypesByRepresentation[input.representation].includes(
      item.itemType as SharedMemorySourceItemType
    )
  ) {
    if (
      [
        "user_message",
        "assistant_message",
        "thought",
        "tool_call",
        "tool_result",
        "lcm_leaf",
        "lcm_rollup",
        "curated_assertion"
      ].includes(item.itemType)
    ) {
      throw new SharedMemorySourceItemRejectedError("wrong_representation");
    }
    throw new SharedMemorySourceItemRejectedError("unknown_item_type");
  }
  if (item.schemaVersion !== 1) {
    throw new SharedMemorySourceItemRejectedError("unknown_schema_version");
  }
  if (item.classification?.hiddenReasoning) {
    throw new SharedMemorySourceItemRejectedError("hidden_reasoning");
  }
  if (item.classification?.systemInstruction) {
    throw new SharedMemorySourceItemRejectedError("system_instruction");
  }
  if (item.classification?.unsupportedProtocolItem) {
    throw new SharedMemorySourceItemRejectedError("unsupported_protocol_item");
  }
  if (item.sourceLogicalMemoryId !== input.logicalMemoryId) {
    throw new SharedMemorySourceItemRejectedError("cross_memory_provenance");
  }
  if (
    !requiredString(item.sourceId) ||
    !UUID_PATTERN.test(item.sourceId) ||
    item.sourceRevision !== input.sourceRevision ||
    !Number.isSafeInteger(item.sourceRevision) ||
    item.sourceRevision < 0 ||
    (item.occurredAt !== undefined &&
      item.occurredAt !== null &&
      Number.isNaN(Date.parse(item.occurredAt)))
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }

  const itemType = item.itemType as SharedMemorySourceItemType;
  if (
    isPlainObject(item.content) &&
    classifyApprovalActivity({ metadata: item.content })
  ) {
    throw new SharedMemorySourceItemRejectedError("approval_activity_excluded");
  }
  const content =
    itemType === "user_message" ||
    itemType === "assistant_message" ||
    itemType === "thought"
      ? validateTextContent(item.content)
      : itemType === "tool_call" || itemType === "tool_result"
        ? validateToolContent(item.content)
        : itemType === "curated_assertion"
          ? validateCuratedAssertionContent(item.content)
          : validateLcmContent(item.content, itemType);
  const assertExpansionBoundary = (value: Record<string, unknown>): void => {
    const expansionItems = value.expansionItems;
    if (!Array.isArray(expansionItems)) return;
    for (const child of expansionItems as SharedMemoryCanonicalSourceItemDto[]) {
      if (
        child.sourceLogicalMemoryId !== input.logicalMemoryId ||
        child.sourceRevision !== input.sourceRevision
      ) {
        throw new SharedMemorySourceItemRejectedError(
          "cross_memory_provenance"
        );
      }
      assertExpansionBoundary(child.content);
    }
  };
  assertExpansionBoundary(content);

  return {
    itemType,
    schemaVersion: 1,
    sourceId: item.sourceId,
    sourceLogicalMemoryId: item.sourceLogicalMemoryId,
    sourceRevision: item.sourceRevision,
    occurredAt: item.occurredAt ?? null,
    content
  };
};

const setSemanticString = (
  root: unknown,
  segments: readonly (string | number)[],
  value: string
): void => {
  if (segments.length === 0) {
    throw new SharedMemoryConflictError(
      "Semantic masked field path cannot target the item collection"
    );
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !(segment in current)) {
        throw new SharedMemoryConflictError(
          "Semantic masked field path does not match the authoritative DTO"
        );
      }
      current = current[segment];
    } else {
      if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
        throw new SharedMemoryConflictError(
          "Semantic masked field path does not match the authoritative DTO"
        );
      }
      current = current[segment];
    }
  }
  const finalSegment = segments.at(-1)!;
  if (typeof finalSegment === "number") {
    if (
      !Array.isArray(current) ||
      !(finalSegment in current) ||
      typeof current[finalSegment] !== "string"
    ) {
      throw new SharedMemoryConflictError(
        "Semantic masked field path does not target an authoritative string"
      );
    }
    current[finalSegment] = value;
    return;
  }
  if (
    !isPlainObject(current) ||
    !Object.hasOwn(current, finalSegment) ||
    typeof current[finalSegment] !== "string"
  ) {
    throw new SharedMemoryConflictError(
      "Semantic masked field path does not target an authoritative string"
    );
  }
  current[finalSegment] = value;
};

const semanticRepresentationForItem = (
  item: SharedMemoryCanonicalSourceItemDto
): SharedMemoryRepresentation =>
  item.itemType === "lcm_leaf"
    ? "lcm_leaves"
    : item.itemType === "lcm_rollup"
      ? "lcm_rollups"
      : item.itemType === "curated_assertion"
        ? "curated_assertions"
        : "memory_events";

export const reconstructSharedMemorySemanticSanitizedItems = (
  authoritativeItems: readonly SharedMemoryCanonicalSourceItemDto[],
  maskedFields: readonly SharedMemorySemanticMaskedField[]
): SharedMemoryCanonicalSourceItemDto[] => {
  const expectedFields = collectClassificationFields(authoritativeItems);
  if (maskedFields.length !== expectedFields.length) {
    throw new SharedMemoryConflictError(
      "Semantic masked fields must exactly cover authoritative classifier inputs"
    );
  }
  const reconstructed = structuredClone(
    authoritativeItems
  ) as SharedMemoryCanonicalSourceItemDto[];
  maskedFields.forEach((maskedField, index) => {
    const expected = expectedFields[index];
    if (
      !expected ||
      typeof maskedField.sanitizedText !== "string" ||
      maskedField.path !== expected.path ||
      maskedField.inputSha256 !== expected.inputSha256 ||
      maskedField.inputByteLength !== expected.inputByteLength
    ) {
      throw new SharedMemoryConflictError(
        "Semantic masked field does not match the ordered authoritative input"
      );
    }
    if (expected.replacementMode === "reject_if_changed") {
      if (maskedField.sanitizedText !== expected.text) {
        throw new SharedMemoryConflictError(
          "Semantic object keys containing protected content are not shareable"
        );
      }
      return;
    }
    setSemanticString(
      reconstructed,
      expected.segments,
      maskedField.sanitizedText
    );
  });
  validateSharedMemorySemanticSanitizedReconstruction(
    authoritativeItems,
    reconstructed
  );
  return reconstructed.map((item) =>
    validateSharedMemoryCanonicalSourceItem({
      representation: semanticRepresentationForItem(item),
      logicalMemoryId: item.sourceLogicalMemoryId,
      sourceRevision: item.sourceRevision,
      item
    })
  );
};
