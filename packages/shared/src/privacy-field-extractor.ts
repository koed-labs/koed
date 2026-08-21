import { createHash } from "node:crypto";
import {
  privacyClassificationFieldRequestSchema,
  privacyClassifiedFieldSchema,
  privacyLabels,
  type PrivacyClassificationFieldRequest,
  type PrivacyClassifiedField
} from "./privacy-filter-contract.js";

export type PrivacyJsonPrimitive = string | number | boolean | null;

export type PrivacyJsonValue =
  | PrivacyJsonPrimitive
  | PrivacyJsonValue[]
  | { [key: string]: PrivacyJsonValue };

interface PrivacyFieldSchemaBase {
  /** A missing object property is accepted when this is set. */
  optional?: boolean;
}

export interface PrivacyTextFieldSchema extends PrivacyFieldSchemaBase {
  kind: "text";
  /**
   * Drop the containing array item when masking leaves only privacy
   * placeholders. Intended for lexical-anchor arrays.
   */
  filterFullyRedacted?: boolean;
}

/**
 * A protocol string that is validated and reconstructed unchanged rather than
 * sent to the classifier. Use only for closed structural fields such as type
 * discriminators, UUIDs, and timestamps.
 */
export interface PrivacyLiteralFieldSchema extends PrivacyFieldSchemaBase {
  kind: "literal";
}

/** A JSON number, boolean, or null retained unchanged. */
export interface PrivacyScalarFieldSchema extends PrivacyFieldSchemaBase {
  kind: "scalar";
}

export interface PrivacyObjectFieldSchema extends PrivacyFieldSchemaBase {
  kind: "object";
  fields: Readonly<Record<string, PrivacyFieldSchema>>;
}

export interface PrivacyArrayFieldSchema extends PrivacyFieldSchemaBase {
  kind: "array";
  items: PrivacyFieldSchema;
}

/** An exact ordered schema for heterogeneous protocol arrays. */
export interface PrivacyTupleFieldSchema extends PrivacyFieldSchemaBase {
  kind: "tuple";
  items: readonly PrivacyFieldSchema[];
}

/**
 * A closed traversal description. Undeclared non-text metadata is retained,
 * while an undeclared string-bearing subtree fails closed. Arrays apply
 * `items` to each present item.
 */
export type PrivacyFieldSchema =
  | PrivacyTextFieldSchema
  | PrivacyLiteralFieldSchema
  | PrivacyScalarFieldSchema
  | PrivacyObjectFieldSchema
  | PrivacyArrayFieldSchema
  | PrivacyTupleFieldSchema;

export interface PrivacyFieldLimits {
  /** Root is depth zero. */
  maxDepth: number;
  /** Counts object properties and array entries in the source. */
  maxKeys: number;
  /** UTF-8 bytes in the JSON source. */
  maxBytes: number;
}

export const DEFAULT_PRIVACY_FIELD_LIMITS: Readonly<PrivacyFieldLimits> =
  Object.freeze({
    maxDepth: 32,
    maxKeys: 20_000,
    maxBytes: 4 * 1024 * 1024
  });

export type ExtractedPrivacyTextField = PrivacyClassificationFieldRequest;

export type MaskedPrivacyTextField = PrivacyClassifiedField;

export interface PrivacyFieldSource<
  T extends PrivacyJsonValue = PrivacyJsonValue
> {
  source: T;
  schema: PrivacyFieldSchema;
  /**
   * Optional original JSON or one-record NDJSON bytes. When supplied, strict
   * UTF-8 decoding and ordered JSON equality with `source` are required.
   */
  decodedSource?: string | Uint8Array;
  limits?: Partial<PrivacyFieldLimits>;
}

export interface PrivacyFieldReconstruction<
  T extends PrivacyJsonValue = PrivacyJsonValue
> extends PrivacyFieldSource<T> {
  fields: readonly MaskedPrivacyTextField[];
}

export type PrivacyFieldErrorCode =
  | "invalid_schema"
  | "invalid_source"
  | "source_mismatch"
  | "bounds_exceeded"
  | "malformed_path"
  | "duplicate_path"
  | "missing_path"
  | "unexpected_path"
  | "invalid_classification"
  | "source_field_mismatch"
  | "invalid_filter_location";

/** Error messages deliberately contain neither source text nor JSON paths. */
export class PrivacyFieldError extends TypeError {
  readonly code: PrivacyFieldErrorCode;

  constructor(code: PrivacyFieldErrorCode, message: string) {
    super(message);
    this.name = "PrivacyFieldError";
    this.code = code;
  }
}

function fail(code: PrivacyFieldErrorCode, message: string): never {
  throw new PrivacyFieldError(code, message);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const ownEnumerableDataKeys = (
  value: Record<string, unknown>,
  errorCode: PrivacyFieldErrorCode = "invalid_source"
): string[] => {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(errorCode, "JSON value contains unsupported properties");
  }

  const stringKeys = keys as string[];
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(errorCode, "JSON value contains unsupported properties");
    }
  }
  return stringKeys;
};

const resolveLimits = (
  partial: Partial<PrivacyFieldLimits> | undefined
): PrivacyFieldLimits => {
  const limits = { ...DEFAULT_PRIVACY_FIELD_LIMITS, ...partial };
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    !Number.isSafeInteger(limits.maxKeys) ||
    limits.maxKeys < 0 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  ) {
    fail("bounds_exceeded", "Privacy field limits are invalid");
  }
  return limits;
};

function validateJsonSource(
  source: unknown,
  limits: PrivacyFieldLimits,
  encodedByteLength?: number
): asserts source is PrivacyJsonValue {
  let keyCount = 0;
  const ancestors = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > limits.maxDepth) {
      fail("bounds_exceeded", "JSON source exceeds the depth limit");
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return;
    }
    if (typeof value === "string") {
      if (!hasWellFormedUtf16(value)) {
        fail("invalid_source", "JSON source contains malformed Unicode");
      }
      return;
    }
    if (typeof value !== "object") {
      fail("invalid_source", "Source is not a JSON value");
    }
    if (ancestors.has(value)) {
      fail("invalid_source", "JSON source must not contain cycles");
    }
    ancestors.add(value);

    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" &&
              (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
                Number(key) >= value.length))
        )
      ) {
        fail("invalid_source", "JSON arrays contain unsupported properties");
      }
      keyCount += value.length;
      if (keyCount > limits.maxKeys) {
        fail("bounds_exceeded", "JSON source exceeds the key limit");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          fail("invalid_source", "JSON arrays must not contain holes");
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          fail("invalid_source", "JSON arrays contain unsupported properties");
        }
        visit(descriptor.value, depth + 1);
      }
    } else {
      if (!isPlainObject(value)) {
        fail("invalid_source", "Source is not a plain JSON value");
      }
      const keys = ownEnumerableDataKeys(value);
      keyCount += keys.length;
      if (keyCount > limits.maxKeys) {
        fail("bounds_exceeded", "JSON source exceeds the key limit");
      }
      for (const key of keys) {
        if (!hasWellFormedUtf16(key)) {
          fail("invalid_source", "JSON source contains malformed Unicode");
        }
        visit(value[key], depth + 1);
      }
    }
    ancestors.delete(value);
  };

  visit(source, 0);
  const byteLength =
    encodedByteLength ?? Buffer.byteLength(JSON.stringify(source), "utf8");
  if (byteLength > limits.maxBytes) {
    fail("bounds_exceeded", "JSON source exceeds the byte limit");
  }
}

function validateSchema(
  schema: unknown,
  limits: PrivacyFieldLimits
): asserts schema is PrivacyFieldSchema {
  let keyCount = 0;
  const ancestors = new Set<object>();

  const visit = (node: unknown, depth: number, insideArray: boolean): void => {
    if (depth > limits.maxDepth || !isPlainObject(node)) {
      fail("invalid_schema", "Privacy field schema is invalid");
    }
    if (ancestors.has(node)) {
      fail("invalid_schema", "Privacy field schema is invalid");
    }
    ancestors.add(node);
    const kind = node.kind;
    if (node.optional !== undefined && typeof node.optional !== "boolean") {
      fail("invalid_schema", "Privacy field schema is invalid");
    }

    if (kind === "literal" || kind === "scalar") {
      const keys = ownEnumerableDataKeys(node, "invalid_schema");
      if (keys.some((key) => key !== "kind" && key !== "optional")) {
        fail("invalid_schema", "Privacy field schema is invalid");
      }
    } else if (kind === "text") {
      const keys = ownEnumerableDataKeys(node, "invalid_schema");
      if (
        keys.some(
          (key) =>
            key !== "kind" &&
            key !== "optional" &&
            key !== "filterFullyRedacted"
        )
      ) {
        fail("invalid_schema", "Privacy field schema is invalid");
      }
      if (
        node.filterFullyRedacted !== undefined &&
        typeof node.filterFullyRedacted !== "boolean"
      ) {
        fail("invalid_schema", "Privacy field schema is invalid");
      }
      if (node.filterFullyRedacted === true && !insideArray) {
        fail(
          "invalid_filter_location",
          "Redacted-field filtering is valid only for direct array items"
        );
      }
    } else if (kind === "array") {
      const keys = ownEnumerableDataKeys(node, "invalid_schema");
      if (
        keys.some(
          (key) => key !== "kind" && key !== "optional" && key !== "items"
        )
      ) {
        fail("invalid_schema", "Privacy field schema is invalid");
      }
      visit(node.items, depth + 1, true);
    } else if (kind === "tuple" && Array.isArray(node.items)) {
      const keys = ownEnumerableDataKeys(node, "invalid_schema");
      if (
        keys.some(
          (key) => key !== "kind" && key !== "optional" && key !== "items"
        )
      ) {
        fail("invalid_schema", "Privacy field schema is invalid");
      }
      keyCount += node.items.length;
      if (keyCount > limits.maxKeys) {
        fail("bounds_exceeded", "Privacy field schema exceeds the key limit");
      }
      for (const item of node.items) visit(item, depth + 1, true);
    } else if (kind === "object" && isPlainObject(node.fields)) {
      const nodeKeys = ownEnumerableDataKeys(node, "invalid_schema");
      if (
        nodeKeys.some(
          (key) => key !== "kind" && key !== "optional" && key !== "fields"
        )
      ) {
        fail("invalid_schema", "Privacy field schema is invalid");
      }
      const fieldKeys = ownEnumerableDataKeys(node.fields, "invalid_schema");
      keyCount += fieldKeys.length;
      if (keyCount > limits.maxKeys) {
        fail("bounds_exceeded", "Privacy field schema exceeds the key limit");
      }
      for (const key of fieldKeys) {
        if (!hasWellFormedUtf16(key)) {
          fail("invalid_schema", "Privacy field schema is invalid");
        }
        visit(node.fields[key], depth + 1, false);
      }
    } else {
      fail("invalid_schema", "Privacy field schema is invalid");
    }
    ancestors.delete(node);
  };

  visit(schema, 0, false);
}

const orderedJsonEqual = (
  left: PrivacyJsonValue,
  right: PrivacyJsonValue
): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => orderedJsonEqual(item, right[index]!))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        orderedJsonEqual(
          left[key] as PrivacyJsonValue,
          right[key] as PrivacyJsonValue
        )
    )
  );
};

const validateDecodedSource = (
  decodedSource: string | Uint8Array | undefined,
  source: PrivacyJsonValue,
  limits: PrivacyFieldLimits
): void => {
  if (decodedSource === undefined) return;

  let decoded: string;
  let byteLength: number;
  if (typeof decodedSource === "string") {
    if (!hasWellFormedUtf16(decodedSource)) {
      fail("invalid_source", "Encoded source contains malformed Unicode");
    }
    decoded = decodedSource;
    byteLength = Buffer.byteLength(decodedSource, "utf8");
  } else if (decodedSource instanceof Uint8Array) {
    byteLength = decodedSource.byteLength;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodedSource);
    } catch {
      fail("invalid_source", "Encoded source is not valid UTF-8");
    }
  } else {
    fail("invalid_source", "Encoded source has an unsupported type");
  }
  if (byteLength > limits.maxBytes) {
    fail("bounds_exceeded", "JSON source exceeds the byte limit");
  }

  const record = decoded.endsWith("\r\n")
    ? decoded.slice(0, -2)
    : decoded.endsWith("\n")
      ? decoded.slice(0, -1)
      : decoded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    fail("invalid_source", "Encoded source is not one valid JSON record");
  }
  validateJsonSource(parsed, limits, byteLength);
  if (!orderedJsonEqual(parsed, source)) {
    fail(
      "source_mismatch",
      "Decoded source does not equal the supplied source"
    );
  }
};

const encodePointerSegment = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const appendPointer = (path: string, segment: string | number): string =>
  `${path}/${encodePointerSegment(String(segment))}`;

const decodeJsonPointer = (path: unknown): string[] => {
  if (typeof path !== "string" || !hasWellFormedUtf16(path)) {
    fail("malformed_path", "Privacy field path is malformed");
  }
  if (path === "") return [];
  if (!path.startsWith("/")) {
    fail("malformed_path", "Privacy field path is malformed");
  }

  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (/~(?:[^01]|$)/u.test(segment)) {
        fail("malformed_path", "Privacy field path is malformed");
      }
      return segment.replaceAll("~1", "/").replaceAll("~0", "~");
    });
  if (`/${segments.map(encodePointerSegment).join("/")}` !== path) {
    fail("malformed_path", "Privacy field path is malformed");
  }
  return segments;
};

const resolvePointer = (
  source: PrivacyJsonValue,
  segments: readonly string[]
): PrivacyJsonValue => {
  let current = source;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        fail("malformed_path", "Privacy field path is malformed");
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        fail(
          "unexpected_path",
          "Privacy field path is not declared by the source"
        );
      }
      current = current[index]!;
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, segment)) {
        fail(
          "unexpected_path",
          "Privacy field path is not declared by the source"
        );
      }
      current = current[segment] as PrivacyJsonValue;
    } else {
      fail(
        "unexpected_path",
        "Privacy field path is not declared by the source"
      );
    }
  }
  return current;
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const collectFields = (
  source: PrivacyJsonValue,
  schema: PrivacyFieldSchema,
  path: string,
  fields: ExtractedPrivacyTextField[]
): void => {
  if (schema.kind === "literal") {
    if (typeof source !== "string") {
      fail("invalid_source", "Declared protocol literal is not a string");
    }
    return;
  }
  if (schema.kind === "scalar") {
    if (
      source !== null &&
      typeof source !== "number" &&
      typeof source !== "boolean"
    ) {
      fail("invalid_source", "Declared protocol scalar is not a scalar");
    }
    return;
  }
  if (schema.kind === "text") {
    if (typeof source !== "string") {
      fail("invalid_source", "Declared privacy text field is not a string");
    }
    const field = privacyClassificationFieldRequestSchema.safeParse({
      path,
      text: source
    });
    if (!field.success) {
      fail(
        "bounds_exceeded",
        "Extracted privacy field exceeds contract bounds"
      );
    }
    fields.push(field.data);
    return;
  }
  if (schema.kind === "array") {
    if (!Array.isArray(source)) {
      fail("invalid_source", "Declared privacy array field is not an array");
    }
    source.forEach((item, index) =>
      collectFields(item, schema.items, appendPointer(path, index), fields)
    );
    return;
  }
  if (schema.kind === "tuple") {
    if (!Array.isArray(source) || source.length !== schema.items.length) {
      fail(
        "invalid_source",
        "Declared privacy tuple does not match its source"
      );
    }
    source.forEach((item, index) =>
      collectFields(
        item,
        schema.items[index]!,
        appendPointer(path, index),
        fields
      )
    );
    return;
  }
  if (!isPlainObject(source)) {
    fail("invalid_source", "Declared privacy object field is not an object");
  }

  const present = new Set<string>();
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(schema.fields, key)) {
      const containsText = (value: PrivacyJsonValue): boolean => {
        if (typeof value === "string") return true;
        if (Array.isArray(value)) return value.some(containsText);
        return isPlainObject(value)
          ? Object.values(value).some((entry) =>
              containsText(entry as PrivacyJsonValue)
            )
          : false;
      };
      if (containsText(source[key] as PrivacyJsonValue)) {
        fail(
          "invalid_schema",
          "Undeclared text-bearing source fields are not permitted"
        );
      }
      continue;
    }
    present.add(key);
    collectFields(
      source[key] as PrivacyJsonValue,
      schema.fields[key]!,
      appendPointer(path, key),
      fields
    );
  }
  for (const key of Object.keys(schema.fields)) {
    if (!present.has(key) && schema.fields[key]!.optional !== true) {
      fail("missing_path", "A required privacy field path is missing");
    }
  }
};

const prepareSource = <T extends PrivacyJsonValue>(
  input: PrivacyFieldSource<T>
): { limits: PrivacyFieldLimits; fields: ExtractedPrivacyTextField[] } => {
  const limits = resolveLimits(input.limits);
  validateJsonSource(input.source, limits);
  validateSchema(input.schema, limits);
  validateDecodedSource(input.decodedSource, input.source, limits);
  const fields: ExtractedPrivacyTextField[] = [];
  collectFields(input.source, input.schema, "", fields);
  const uniquePaths = new Set(fields.map((field) => field.path));
  if (uniquePaths.size !== fields.length) {
    fail("duplicate_path", "Privacy field schema produced duplicate paths");
  }
  if (fields.length > 128) {
    fail("bounds_exceeded", "Extracted privacy fields exceed contract bounds");
  }
  return { limits, fields };
};

export const extractPrivacyTextFields = <T extends PrivacyJsonValue>(
  input: PrivacyFieldSource<T>
): ExtractedPrivacyTextField[] => prepareSource(input).fields;

const placeholderNames = [
  ...privacyLabels.map((label) => label.toUpperCase()),
  "PRIVATE_DATA"
].join("|");
const fullyRedactedPattern = new RegExp(
  `^(?:\\s*\\[(?:${placeholderNames})\\]\\s*)+$`,
  "u"
);

/** True only when the complete value consists of fixed privacy placeholders. */
export const isFullyRedactedPrivacyText = (text: string): boolean =>
  fullyRedactedPattern.test(text);

const OMIT_ARRAY_ITEM = Symbol("omit-array-item");

const cloneWithMasks = (
  source: PrivacyJsonValue,
  schema: PrivacyFieldSchema | undefined,
  path: string,
  masks: ReadonlyMap<string, string>
): PrivacyJsonValue | typeof OMIT_ARRAY_ITEM => {
  if (schema?.kind === "literal") {
    if (typeof source !== "string") {
      fail("invalid_source", "Declared protocol literal is not a string");
    }
    return source;
  }
  if (schema?.kind === "scalar") {
    if (
      source !== null &&
      typeof source !== "number" &&
      typeof source !== "boolean"
    ) {
      fail("invalid_source", "Declared protocol scalar is not a scalar");
    }
    return source;
  }
  if (schema?.kind === "text") {
    const replacement = masks.get(path);
    if (replacement === undefined) {
      fail("missing_path", "A required masked privacy field is missing");
    }
    return schema.filterFullyRedacted === true &&
      isFullyRedactedPrivacyText(replacement)
      ? OMIT_ARRAY_ITEM
      : replacement;
  }
  if (Array.isArray(source)) {
    const result: PrivacyJsonValue[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const value = cloneWithMasks(
        source[index]!,
        schema?.kind === "array"
          ? schema.items
          : schema?.kind === "tuple"
            ? schema.items[index]
            : undefined,
        appendPointer(path, index),
        masks
      );
      if (value !== OMIT_ARRAY_ITEM) result.push(value);
    }
    return result;
  }
  if (isPlainObject(source)) {
    const result: Record<string, PrivacyJsonValue> = {};
    for (const key of Object.keys(source)) {
      const value = cloneWithMasks(
        source[key] as PrivacyJsonValue,
        schema?.kind === "object" && Object.hasOwn(schema.fields, key)
          ? schema.fields[key]
          : undefined,
        appendPointer(path, key),
        masks
      );
      if (value === OMIT_ARRAY_ITEM) {
        fail(
          "invalid_filter_location",
          "Redacted-field filtering is valid only for direct array items"
        );
      }
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  }
  return source;
};

export const reconstructPrivacyTextFields = <T extends PrivacyJsonValue>(
  input: PrivacyFieldReconstruction<T>
): T => {
  const { fields: expected } = prepareSource(input);
  if (!Array.isArray(input.fields)) {
    fail("invalid_source", "Masked privacy fields must be an array");
  }

  const expectedByPath = new Map(expected.map((field) => [field.path, field]));
  const masks = new Map<string, string>();
  for (const field of input.fields as readonly MaskedPrivacyTextField[]) {
    const parsed = privacyClassifiedFieldSchema.safeParse(field);
    if (!parsed.success) {
      fail("invalid_classification", "Masked privacy field is malformed");
    }
    const classified = parsed.data;
    const segments = decodeJsonPointer(classified.path);
    const resolved = resolvePointer(input.source, segments);
    if (typeof resolved !== "string") {
      fail("unexpected_path", "Masked privacy field does not address text");
    }
    if (masks.has(classified.path)) {
      fail("duplicate_path", "Masked privacy field paths must be unique");
    }
    const extracted = expectedByPath.get(classified.path);
    if (extracted === undefined) {
      fail("unexpected_path", "Masked privacy field path was not declared");
    }
    if (
      classified.decodedTextMatchesInput !== true ||
      classified.inputByteLength !==
        Buffer.byteLength(extracted.text, "utf8") ||
      classified.inputSha256 !== sha256(extracted.text)
    ) {
      fail(
        "source_field_mismatch",
        "Privacy classification does not match its source field"
      );
    }
    if (!hasWellFormedUtf16(classified.maskedText)) {
      fail("invalid_source", "Masked privacy field contains malformed Unicode");
    }
    masks.set(classified.path, classified.maskedText);
  }
  if (masks.size !== expected.length) {
    fail("missing_path", "A required masked privacy field is missing");
  }

  const reconstructed = cloneWithMasks(input.source, input.schema, "", masks);
  if (reconstructed === OMIT_ARRAY_ITEM) {
    fail(
      "invalid_filter_location",
      "Redacted-field filtering is valid only for direct array items"
    );
  }
  validateJsonSource(reconstructed, resolveLimits(input.limits));
  return reconstructed as T;
};
