import { canonicalize } from "json-canonicalize";

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const assertPdsValue = (value: unknown, ancestors: Set<object>): void => {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (hasLoneSurrogate(value))
      throw new TypeError("PDS JSON rejects lone surrogates");
    return;
  }
  if (typeof value === "number") {
    throw new TypeError(
      "PDS JSON represents numeric values as decimal strings"
    );
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(`PDS JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value))
    throw new TypeError("PDS JSON rejects cyclic values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertPdsValue(item, ancestors);
      return;
    }
    if (Reflect.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("PDS JSON only supports plain objects");
    }
    for (const [key, item] of Object.entries(value)) {
      if (hasLoneSurrogate(key))
        throw new TypeError("PDS JSON rejects lone surrogates");
      assertPdsValue(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
};

class StrictJsonScanner {
  private position = 0;

  constructor(private readonly input: string) {}

  parse(): void {
    this.skipWhitespace();
    this.value();
    this.skipWhitespace();
    if (this.position !== this.input.length) this.fail("trailing data");
  }

  private value(): void {
    const character = this.input[this.position];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return void this.string();
    if (character === "-" || /[0-9]/.test(character ?? ""))
      return this.number();
    for (const literal of ["true", "false", "null"]) {
      if (this.input.startsWith(literal, this.position)) {
        this.position += literal.length;
        return;
      }
    }
    this.fail("invalid value");
  }

  private object(): void {
    const keys = new Set<string>();
    this.position += 1;
    this.skipWhitespace();
    if (this.consume("}")) return;
    while (true) {
      this.skipWhitespace();
      if (this.input[this.position] !== '"') this.fail("object key");
      const key = this.string();
      if (keys.has(key)) this.fail("duplicate object member");
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("object colon");
      this.skipWhitespace();
      this.value();
      this.skipWhitespace();
      if (this.consume("}")) return;
      if (!this.consume(",")) this.fail("object separator");
    }
  }

  private array(): void {
    this.position += 1;
    this.skipWhitespace();
    if (this.consume("]")) return;
    while (true) {
      this.value();
      this.skipWhitespace();
      if (this.consume("]")) return;
      if (!this.consume(",")) this.fail("array separator");
      this.skipWhitespace();
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (character === '"') {
        const raw = this.input.slice(start, this.position);
        try {
          const value = JSON.parse(raw) as unknown;
          if (typeof value !== "string" || hasLoneSurrogate(value)) {
            this.fail("invalid Unicode string");
          }
          return value;
        } catch (error) {
          if (error instanceof SyntaxError) this.fail("invalid string");
          throw error;
        }
      }
      if (character === "\\") {
        const escape = this.input[this.position++];
        if (escape === "u") this.position += 4;
      } else if (character !== undefined && character < " ") {
        this.fail("control character in string");
      }
    }
    this.fail("unterminated string");
  }

  private number(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.input.slice(this.position)
    );
    if (!match) this.fail("invalid number");
    this.position += match[0].length;
  }

  private consume(character: string): boolean {
    if (this.input[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.input[this.position] ?? "")) this.position += 1;
  }

  private fail(reason: string): never {
    throw new SyntaxError(
      `PDS JSON rejects ${reason} at byte ${this.position}`
    );
  }
}

export const canonicalizePdsJson = (value: unknown): string => {
  assertPdsValue(value, new Set());
  return canonicalize(value);
};

export const parseCanonicalPdsJson = (input: string): unknown => {
  new StrictJsonScanner(input).parse();
  const parsed = JSON.parse(input) as unknown;
  const canonical = canonicalizePdsJson(parsed);
  if (canonical !== input)
    throw new SyntaxError("PDS JSON input is not RFC 8785 canonical");
  return parsed;
};

export const parsePdsUint64 = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("PDS uint64 must be a canonical decimal string");
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("PDS uint64 exceeds unsigned 64-bit range");
  }
  return parsed;
};

export const pdsUint64be = (value: string): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(parsePdsUint64(value));
  return bytes;
};
