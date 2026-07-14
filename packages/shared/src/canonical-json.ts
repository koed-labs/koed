const compareCanonicalKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const serializeCanonicalJson = (
  value: unknown,
  ancestors: Set<object>
): string => {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON only supports finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not support cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => serializeCanonicalJson(item, ancestors))
        .join(",")}]`;
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only supports plain objects");
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareCanonicalKeys(left, right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${serializeCanonicalJson(entryValue, ancestors)}`
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJsonStringify = (value: unknown): string =>
  serializeCanonicalJson(value, new Set());
