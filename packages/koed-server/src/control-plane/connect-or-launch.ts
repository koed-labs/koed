import type { ControlClient } from "./client.js";
import type { ControlDiscovery } from "./discovery.js";

/** Discovery is routing metadata, not an authentication decision. */
export async function connectOrLaunchControlPlane(input: {
  read(): ControlDiscovery | undefined;
  isLocked(): boolean;
  launch(): void;
  launchIfMissing?: boolean;
  launchFailure?: () => Error | undefined;
  connect(discovery: ControlDiscovery): Promise<ControlClient>;
  installationId: string;
  productVersion: string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<ControlClient> {
  const connect = (discovery: ControlDiscovery) => {
    if (
      discovery.installationId !== input.installationId ||
      discovery.productVersion !== input.productVersion
    )
      throw new Error(
        "The running Koed Server Control Plane is incompatible with this installation or version"
      );
    return input.connect(discovery);
  };
  const existing = input.read();
  if (existing) return connect(existing);
  if (input.isLocked())
    throw new Error(
      "Koed has an owner but no control-plane endpoint; Operator attention required"
    );
  if (input.launchIfMissing === false)
    throw new Error(
      "No control-plane endpoint is available; Stop was not recorded"
    );
  input.launch();
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 120_000);
  while (now() < deadline) {
    const discovery = input.read();
    if (discovery) return connect(discovery);
    const failure = input.launchFailure?.();
    if (failure && !input.isLocked()) throw failure;
    await sleep(100);
  }
  throw new Error(
    "Timed out waiting for the Koed Server Control Plane; no fallback was attempted"
  );
}
