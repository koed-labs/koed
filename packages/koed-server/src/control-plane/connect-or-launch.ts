import type { ControlClient } from "./client.js";
import type { ControlDiscovery } from "./discovery.js";

export class ControlOwnerGoneError extends Error {}

/** Discovery is routing metadata, not an authentication decision. */
export async function connectOrLaunchControlPlane(input: {
  read(): ControlDiscovery | undefined;
  isLocked(): boolean;
  hasLiveOwner?(): boolean;
  isDiscoveryDead?(discovery: ControlDiscovery): boolean;
  isCurrentDiscovery?(discovery: ControlDiscovery): boolean;
  launch(): void;
  launchIfMissing?: boolean;
  waitForOwner?: boolean;
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
  const usable = (record: ControlDiscovery) =>
    !input.isDiscoveryDead?.(record) &&
    (input.isCurrentDiscovery?.(record) ?? true);
  const stale = existing && !usable(existing) ? existing : undefined;
  if (existing && !stale) return connect(existing);
  const ownerStarting = input.isLocked() && (input.hasLiveOwner?.() ?? true);
  if (stale && !ownerStarting && !input.isDiscoveryDead?.(stale))
    throw new Error("Control-plane discovery owner cannot be verified");
  if (ownerStarting) {
    if (input.waitForOwner === false)
      throw new Error(
        "Koed has an owner but no control-plane endpoint; Operator attention required"
      );
    const now = input.now ?? Date.now;
    const sleep =
      input.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline =
      now() +
      (input.launchIfMissing === false
        ? Math.min(input.timeoutMs ?? 10_000, 10_000)
        : (input.timeoutMs ?? 120_000));
    while (
      now() < deadline &&
      input.isLocked() &&
      (input.hasLiveOwner?.() ?? true)
    ) {
      await sleep(100);
      const discovery = input.read();
      if (discovery && usable(discovery)) return connect(discovery);
    }
    if (!input.isLocked() || !(input.hasLiveOwner?.() ?? true))
      throw new ControlOwnerGoneError(
        "Control-plane owner exited before publishing discovery"
      );
    throw new Error(
      "Koed has an owner but no control-plane endpoint; Operator attention required"
    );
  }
  if (input.launchIfMissing === false) {
    if (stale)
      throw new ControlOwnerGoneError(
        "Control-plane owner exited before Stop was recorded"
      );
    const message =
      "No control-plane endpoint is available; Stop was not recorded";
    if (input.waitForOwner) throw new ControlOwnerGoneError(message);
    throw new Error(message);
  }
  input.launch();
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 120_000);
  let failureObservedAt: number | undefined;
  while (now() < deadline) {
    const discovery = input.read();
    if (discovery && usable(discovery)) return connect(discovery);
    const failure = input.launchFailure?.();
    if (failure) {
      failureObservedAt ??= now();
      const liveOwner = input.isLocked() && (input.hasLiveOwner?.() ?? true);
      if (!liveOwner && now() - failureObservedAt >= 1_000) throw failure;
    }
    await sleep(100);
  }
  throw new Error(
    "Timed out waiting for the Koed Server Control Plane; no fallback was attempted"
  );
}
