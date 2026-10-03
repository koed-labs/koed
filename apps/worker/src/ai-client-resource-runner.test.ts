import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiClientResourceDiscoveryRunnerClaim } from "@koed/shared";
import type { LocalAiClientInstanceConfiguration } from "@koed/mcp-server";
import {
  createAiClientResourceRunner,
  type AiClientResourceRunner
} from "./ai-client-resource-runner.js";
import type { AiClientResourceRunnerAuthority } from "./ai-client-resource-authority-client.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const deviceId = "device-1";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const claim = {
  operationId: "33333333-3333-4333-8333-333333333333",
  ownerUserId,
  requestId: "44444444-4444-4444-8444-444444444444",
  hostedInstanceId: "instance-1",
  aiClientInstanceId: "instance-1",
  provider: "codex",
  computerLabel: null,
  projectId: null,
  targetDeviceId: deviceId,
  targetDeploymentId: deploymentId,
  state: "running",
  revision: 1,
  attempt: 1,
  leaseToken: "55555555-5555-4555-8555-555555555555",
  createdAt: new Date().toISOString()
} satisfies AiClientResourceDiscoveryRunnerClaim;

const instance = {
  instanceId: "instance-1",
  driverId: "codex",
  executablePath: "/configured/codex",
  configHome: "/configured/home",
  enabled: true
} as LocalAiClientInstanceConfiguration;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("AI Client resource runner", () => {
  afterEach(() => vi.useRealTimers());

  it("renews an active lease and does not claim a queued operation before discovery settles", async () => {
    vi.useFakeTimers();
    const discovery = deferred<{
      version: 1;
      provider: "codex";
      aiClientInstanceId: string;
      hostedInstanceId: string;
      computerLabel: null;
      projectId: null;
      observedAt: string;
      expiresAt: string;
      resources: [];
    }>();
    const secondClaim = {
      ...claim,
      operationId: "66666666-6666-4666-8666-666666666666"
    };
    const claimCalls: Array<{ limit: number }> = [];
    const originalLeaseExpiresAt = Date.now() + 1_000;
    let leaseExpiresAt = originalLeaseExpiresAt;
    const heartbeat = vi.fn(
      async (_claim, _runnerId, renewedLeaseMs: number) => {
        leaseExpiresAt = Date.now() + renewedLeaseMs;
        return true;
      }
    );
    const complete = vi.fn(async () => {
      expect(Date.now()).toBeLessThan(leaseExpiresAt);
    });
    const fail = vi.fn(async () => undefined);
    const authority = {
      async claim(input) {
        claimCalls.push({ limit: input.limit });
        return claimCalls.length === 1 ? [claim] : [secondClaim];
      },
      heartbeat,
      complete,
      fail
    } as unknown as AiClientResourceRunnerAuthority;
    const runner: AiClientResourceRunner = createAiClientResourceRunner({
      authority,
      repository: {} as never,
      localOwnerUserId: ownerUserId,
      deviceId,
      deploymentId,
      koedHome: "/unused",
      leaseMs: 1_000,
      heartbeatIntervalMs: 250,
      loadRegistry: () => ({ instances: [instance] }),
      discoverResources: () => discovery.promise
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]?.limit).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(heartbeat).toHaveBeenCalledTimes(6);
    expect(claimCalls).toHaveLength(1);
    expect(Date.now()).toBeGreaterThan(originalLeaseExpiresAt);

    discovery.resolve({
      version: 1,
      provider: "codex",
      aiClientInstanceId: "instance-1",
      hostedInstanceId: "instance-1",
      computerLabel: null,
      projectId: null,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resources: []
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledTimes(1);

    await runner.stop();
    expect(fail).not.toHaveBeenCalled();
  });
});
