import {
  controlHelloSchema,
  type ControlHello
} from "@koed-labs/shared/local-control-protocol";

export interface AuthenticatedControlPeer {
  pid: number;
  uid: number;
}
export type ExpectedControlHello = Omit<ControlHello, "protocolVersion">;

/** Peer identity must come from native authentication; expected process identity must be verified live, not trusted from discovery. */
export function validateControlHello(
  value: unknown,
  expected: ExpectedControlHello,
  peer: AuthenticatedControlPeer
): ControlHello {
  const hello = controlHelloSchema.parse(value);
  if (hello.pid !== peer.pid || hello.pid !== expected.pid)
    throw new Error("Control-plane peer identity mismatch");
  for (const field of [
    "home",
    "installationId",
    "productVersion",
    "instanceId",
    "processIdentity",
    "nonce"
  ] as const) {
    if (hello[field] !== expected[field])
      throw new Error(`Control-plane hello ${field} mismatch`);
  }
  return hello;
}
