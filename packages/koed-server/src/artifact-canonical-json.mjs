import { Buffer } from "node:buffer";

// Artifact signing and identity bytes: lexically sorted keys, UTF-8, no newline.
export function canonicalArtifactJson(value) {
  const ancestors = new Set();
  const encode = (item) => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object")
      throw new TypeError("artifact has unsupported JSON value");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new TypeError("artifact has unsupported JSON object");
    if (Object.getOwnPropertySymbols(item).length)
      throw new TypeError("artifact has unsupported JSON symbol key");
    if (ancestors.has(item))
      throw new TypeError("artifact has cyclic JSON value");
    ancestors.add(item);
    try {
      if (array) {
        const entries = [];
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index))
            throw new TypeError("artifact has sparse JSON array");
          entries.push(encode(item[index]));
        }
        return `[${entries.join(",")}]`;
      }
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
}

export function canonicalArtifactBytes(value) {
  return Buffer.from(canonicalArtifactJson(value), "utf8");
}
