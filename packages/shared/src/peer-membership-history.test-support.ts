// Test-only model; this is not a production membership protocol.
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";

const protocol = "koed/peer-membership/test-v1";
const id = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const encoded = (length: number) =>
  z.string().refine((s) => {
    const bytes = Buffer.from(s, "base64url");
    return bytes.length === length && bytes.toString("base64url") === s;
  });
const member = z
  .object({ deviceId: id, signingPublicKey: encoded(32) })
  .strict();
const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("genesis"), initialMember: member }).strict(),
  z.object({ kind: z.literal("add"), target: member }).strict(),
  z.object({ kind: z.literal("revoke"), targetDeviceId: id }).strict()
]);
const unsigned = z
  .object({
    protocol: z.literal(protocol),
    groupId: id,
    parentHash: encoded(32).nullable(),
    authorDeviceId: id,
    body
  })
  .strict();
const record = z.object({ unsigned, signature: encoded(64) }).strict();
type RecordValue = z.infer<typeof record>;
type Member = z.infer<typeof member>;
export type Anchor = { groupId: string; genesisHash: string };
type Snapshot = { active: Map<string, Member>; used: Map<string, Member> };
type Data = {
  anchor: Anchor;
  records: Map<string, RecordValue>;
  snapshots: Map<string, Snapshot>;
  conflict: boolean;
  collision: boolean;
  incomplete: boolean;
  effectiveMembers: Map<string, Member>;
  revocations: Set<string>;
  ids: Map<string, string>;
  keys: Map<string, string>;
};
declare const stateBrand: unique symbol;
export type State = { readonly [stateBrand]: true };
const states = new WeakMap<State, Data>();
const makeState = (data: Data): State => {
  const state = Object.freeze({}) as State;
  states.set(state, data);
  return state;
};
export function markIncomplete(state: State): State {
  const data = states.get(state);
  if (!data) throw new TypeError("invalid state");
  return makeState({ ...data, incomplete: true, effectiveMembers: new Map() });
}
export function inspect(state: State) {
  const data = states.get(state);
  if (!data) throw new TypeError("invalid state");
  return {
    conflict: data.conflict,
    collision: data.collision,
    incomplete: data.incomplete,
    effectiveMembers: new Map(
      [...data.effectiveMembers].map(([id, member]) => [id, { ...member }])
    ),
    revocations: new Set(data.revocations),
    recordCount: data.records.size,
    records: [...data.records.entries()].map(([hash, record]) => ({
      hash,
      parentHash: record.unsigned.parentHash,
      evidence: canonicalizePdsJson(record)
    }))
  };
}
const maxBytes = 16384;
const hashDecision = (value: RecordValue["unsigned"]): string =>
  createHash("sha256")
    .update(`${protocol}/record\n`)
    .update(canonicalizePdsJson(value))
    .digest("base64url");
const verifyDecision = (value: RecordValue, publicKey: string): boolean => {
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey, "base64url")
      ]),
      format: "der",
      type: "spki"
    });
    return verify(
      null,
      Buffer.from(
        `${protocol}/decision\n${canonicalizePdsJson(value.unsigned)}`
      ),
      key,
      Buffer.from(value.signature, "base64url")
    );
  } catch {
    return false;
  }
};
export function initialize(
  anchor: Anchor,
  json: string
):
  | { status: "accepted"; state: State }
  | { status: "invalid" | "limit"; reason: string } {
  if (Buffer.byteLength(json) > maxBytes)
    return { status: "limit", reason: "record too large" };
  try {
    const parsed = record.parse(parseCanonicalPdsJson(json));
    const value = parsed.unsigned;
    if (
      value.groupId !== anchor.groupId ||
      hashDecision(value) !== anchor.genesisHash ||
      value.parentHash !== null ||
      value.body.kind !== "genesis" ||
      value.authorDeviceId !== value.body.initialMember.deviceId ||
      !verifyDecision(parsed, value.body.initialMember.signingPublicKey)
    )
      return { status: "invalid", reason: "invalid genesis" };
    const members = new Map([
      [value.body.initialMember.deviceId, value.body.initialMember]
    ]);
    return {
      status: "accepted",
      state: makeState({
        anchor: { ...anchor },
        records: new Map([[anchor.genesisHash, parsed]]),
        snapshots: new Map([
          [anchor.genesisHash, { active: members, used: new Map(members) }]
        ]),
        conflict: false,
        collision: false,
        incomplete: false,
        effectiveMembers: new Map(members),
        revocations: new Set(),
        ids: new Map([
          [
            value.body.initialMember.deviceId,
            value.body.initialMember.signingPublicKey
          ]
        ]),
        keys: new Map([
          [
            value.body.initialMember.signingPublicKey,
            value.body.initialMember.deviceId
          ]
        ])
      })
    };
  } catch {
    return { status: "invalid", reason: "invalid record" };
  }
}

type Result =
  | { status: "accepted" | "duplicate"; state: State }
  | { status: "pending"; state: State; missingParent: string }
  | { status: "invalid" | "limit"; state: State; reason: string };

export function apply(state: State, json: string): Result {
  const data = states.get(state);
  if (!data) throw new TypeError("invalid state");
  const invalid = (reason: string): Result => ({
    status: "invalid",
    state,
    reason
  });
  const limit = (): Result => ({
    status: "limit",
    state: makeState({
      ...data,
      incomplete: true,
      effectiveMembers: new Map()
    }),
    reason: "resource limit"
  });
  if (data.incomplete || Buffer.byteLength(json) > maxBytes) return limit();
  let parsed: RecordValue;
  try {
    parsed = record.parse(parseCanonicalPdsJson(json));
  } catch {
    return invalid("invalid record");
  }
  const value = parsed.unsigned;
  if (
    value.groupId !== data.anchor.groupId ||
    value.parentHash === null ||
    value.body.kind === "genesis"
  )
    return invalid("invalid scope or kind");
  const parent = data.snapshots.get(value.parentHash);
  if (!parent)
    return { status: "pending", state, missingParent: value.parentHash };
  const author = parent.active.get(value.authorDeviceId);
  if (!author || !verifyDecision(parsed, author.signingPublicKey))
    return invalid("invalid author or signature");
  const hash = hashDecision(value);
  if (data.records.has(hash)) return { status: "duplicate", state };
  const active = new Map(parent.active);
  const used = new Map(parent.used);
  const revocations = new Set(data.revocations);
  if (value.body.kind === "add") {
    const target = value.body.target;
    if (
      used.has(target.deviceId) ||
      [...used.values()].some(
        (m) => m.signingPublicKey === target.signingPublicKey
      )
    )
      return invalid("reused identity");
    active.set(target.deviceId, target);
    used.set(target.deviceId, target);
  } else {
    const target = active.get(value.body.targetDeviceId);
    if (!target || target.deviceId === value.authorDeviceId)
      return invalid("invalid revocation");
    active.delete(target.deviceId);
    revocations.add(JSON.stringify([target.deviceId, target.signingPublicKey]));
  }
  if (data.records.size >= 1024) return limit();
  const conflict =
    data.conflict ||
    [...data.records.values()].some(
      (r) => r.unsigned.parentHash === value.parentHash
    );
  const ids = new Map(data.ids);
  const keys = new Map(data.keys);
  const target = value.body.kind === "add" ? value.body.target : undefined;
  const collision =
    data.collision ||
    (target !== undefined &&
      ((ids.has(target.deviceId) &&
        ids.get(target.deviceId) !== target.signingPublicKey) ||
        (keys.has(target.signingPublicKey) &&
          keys.get(target.signingPublicKey) !== target.deviceId)));
  if (target) {
    if (!ids.has(target.deviceId))
      ids.set(target.deviceId, target.signingPublicKey);
    if (!keys.has(target.signingPublicKey))
      keys.set(target.signingPublicKey, target.deviceId);
  }
  return {
    status: "accepted",
    state: makeState({
      ...data,
      records: new Map(data.records).set(hash, parsed),
      snapshots: new Map(data.snapshots).set(hash, { active, used }),
      revocations,
      conflict,
      collision,
      ids,
      keys,
      effectiveMembers:
        conflict || collision ? new Map<string, Member>() : new Map(active)
    })
  };
}
