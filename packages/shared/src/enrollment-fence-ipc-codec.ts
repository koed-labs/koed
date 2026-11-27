import { z } from "zod";

const identifier = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
const sequence = z.number().int().min(1).max(100_000);
const epochIdentifier = z.string().regex(/^[0-9a-f]{32}-[0-9a-f]{16}$/);
const ids = { instanceId: identifier, epochId: epochIdentifier };
const operationIds = { ...ids, operationId: identifier };
const status = z.enum(["pending", "drained"]);
const bindChallenge = z.string().regex(/^[0-9a-f]{32}$/);
const rejected = z.strictObject({
  kind: z.literal("rejected"),
  // Wire code reports the fence error, not whether effects occurred.
  code: z.enum([
    "invalid_input",
    "instance_mismatch",
    "unknown_epoch",
    "unknown_operation",
    "owner_mismatch",
    "capacity_exceeded",
    "fenced"
  ])
});
const envelope = { v: z.literal(1), seq: sequence };
const request = <O extends string, T extends z.ZodRawShape>(op: O, args: T) =>
  z.strictObject({
    ...envelope,
    type: z.literal("request"),
    op: z.literal(op),
    args: z.strictObject(args)
  });
const response = <O extends string, T extends z.ZodRawShape>(
  op: O,
  result: T
) =>
  z.strictObject({
    ...envelope,
    type: z.literal("response"),
    op: z.literal(op),
    result: z.union([
      z.strictObject({ kind: z.literal("ok"), ...result }),
      rejected
    ])
  });

const schema = z.union([
  z.strictObject({
    v: z.literal(1),
    type: z.literal("ready"),
    instanceId: identifier
  }),
  request("bind", {}),
  request("bindAck", { challenge: bindChallenge }),
  request("create", {}),
  request("register", ids),
  request("fenceEpoch", ids),
  request("fenceOperation", operationIds),
  request("finish", {}),
  response("bind", { challenge: bindChallenge }),
  response("bindAck", {}),
  response("create", ids),
  response("register", operationIds),
  response("fenceEpoch", { ...ids, status }),
  response("fenceOperation", { ...operationIds, status }),
  response("finish", {})
]);

export type EnrollmentFenceIpcMessage = z.infer<typeof schema>;
export type EnrollmentFenceIpcRequest = Extract<
  EnrollmentFenceIpcMessage,
  { type: "request" }
>;
export type EnrollmentFenceIpcResponse = Extract<
  EnrollmentFenceIpcMessage,
  { type: "response" }
>;
export type EnrollmentFenceIpcReady = Extract<
  EnrollmentFenceIpcMessage,
  { type: "ready" }
>;
export const ENROLLMENT_FENCE_IPC_MAX_BYTES = 4096;

function assertPlainObject(
  value: unknown
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Invalid enrollment fence IPC object");
  if (Object.hasOwn(value, "__proto__"))
    throw new Error("Invalid enrollment fence IPC property");
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value)
  )) {
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new Error("Invalid enrollment fence IPC property");
  }
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("Invalid enrollment fence IPC property");
}

function validate(value: unknown): EnrollmentFenceIpcMessage {
  assertPlainObject(value);
  if ("args" in value) assertPlainObject(value.args);
  if ("result" in value) assertPlainObject(value.result);
  return schema.parse(value);
}

export function encodeEnrollmentFenceMessage(
  message: EnrollmentFenceIpcMessage
): string {
  const wire = JSON.stringify(validate(message));
  if (Buffer.byteLength(wire, "utf8") > ENROLLMENT_FENCE_IPC_MAX_BYTES)
    throw new Error("Enrollment fence IPC message too large");
  return wire;
}

// JSON.parse discards duplicate keys. Scan the already-valid JSON to detect
// decoded key collisions without recursive traversal of untrusted nesting.
function rejectDuplicateKeys(wire: string): void {
  const objects: (Set<string> | null)[] = [];
  const strings = /"(?:\\.|[^"\\])*"/gy;
  for (let i = 0; i < wire.length; i++) {
    const char = wire[i];
    if (char === "{" || char === "[")
      objects.push(char === "{" ? new Set() : null);
    else if (char === "}" || char === "]") objects.pop();
    else if (char === '"') {
      strings.lastIndex = i;
      const match = strings.exec(wire);
      if (!match) throw new Error("Invalid enrollment fence IPC JSON");
      i = strings.lastIndex - 1;
      let next = i + 1;
      while (next < wire.length && /[\x20\t\r\n]/.test(wire[next]!)) next++;
      if (wire[next] === ":") {
        const key = JSON.parse(match[0]) as string;
        const keys = objects[objects.length - 1];
        if (!keys || keys.has(key))
          throw new Error("Duplicate enrollment fence IPC key");
        keys.add(key);
      }
    }
  }
}

export function decodeEnrollmentFenceMessage(
  wire: unknown
): EnrollmentFenceIpcMessage {
  if (
    typeof wire !== "string" ||
    Buffer.byteLength(wire, "utf8") > ENROLLMENT_FENCE_IPC_MAX_BYTES
  )
    throw new Error("Invalid enrollment fence IPC message");
  const parsed: unknown = JSON.parse(
    wire,
    (key: string, value: unknown, context?: { source?: string }) => {
      if (
        key === "seq" &&
        (typeof value !== "number" ||
          !context?.source ||
          !/^[1-9][0-9]*$/.test(context.source))
      )
        throw new Error("Invalid enrollment fence IPC sequence");
      return value;
    }
  );
  rejectDuplicateKeys(wire);
  return validate(parsed);
}
