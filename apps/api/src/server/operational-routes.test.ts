import { describe, expect, it, vi } from "vitest";
import { resolveCrossIdentitySyncCapability } from "./operational-routes.js";

describe("Cross-Identity Sync capability", () => {
  it("uses Worker readiness for an explicitly enabled developer Team backend", async () => {
    const isWorkerReady = vi.fn(async () => true);
    const hasRoutableUpstream = vi.fn(() => false);

    await expect(
      resolveCrossIdentitySyncCapability({
        deploymentProfile: "developer",
        teamCollaborationEnabled: true,
        developerTeamBackendEnabled: true,
        applicationLayerEncryptionAvailable: true,
        isWorkerReady,
        hasRoutableUpstream
      })
    ).resolves.toBe("available");
    expect(isWorkerReady).toHaveBeenCalledOnce();
    expect(hasRoutableUpstream).not.toHaveBeenCalled();
  });

  it("fails a developer Team backend closed when its Worker is not ready", async () => {
    await expect(
      resolveCrossIdentitySyncCapability({
        deploymentProfile: "developer",
        teamCollaborationEnabled: true,
        developerTeamBackendEnabled: true,
        applicationLayerEncryptionAvailable: true,
        isWorkerReady: async () => false,
        hasRoutableUpstream: () => true
      })
    ).resolves.toBe("unavailable");
  });

  it("keeps ordinary developer and local-personal runtimes source-routed", async () => {
    const isWorkerReady = vi.fn(async () => true);
    for (const deploymentProfile of ["developer", "local_personal"] as const) {
      await expect(
        resolveCrossIdentitySyncCapability({
          deploymentProfile,
          teamCollaborationEnabled: true,
          developerTeamBackendEnabled: false,
          applicationLayerEncryptionAvailable: true,
          isWorkerReady,
          hasRoutableUpstream: () => false
        })
      ).resolves.toBe("unavailable");
    }
    expect(isWorkerReady).not.toHaveBeenCalled();
  });

  it("does not advertise sync without application-layer encryption", async () => {
    const isWorkerReady = vi.fn(async () => true);
    const hasRoutableUpstream = vi.fn(() => true);

    await expect(
      resolveCrossIdentitySyncCapability({
        deploymentProfile: "developer",
        teamCollaborationEnabled: true,
        developerTeamBackendEnabled: true,
        applicationLayerEncryptionAvailable: false,
        isWorkerReady,
        hasRoutableUpstream
      })
    ).resolves.toBe("unavailable");
    expect(isWorkerReady).not.toHaveBeenCalled();
    expect(hasRoutableUpstream).not.toHaveBeenCalled();
  });
});
