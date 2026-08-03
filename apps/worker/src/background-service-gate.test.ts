import { describe, expect, it, vi } from "vitest";

import { startWorkerBackgroundServices } from "./background-service-gate.js";

const service = () => ({ start: vi.fn(), stop: vi.fn() });

describe("Worker Team collaboration feature gate", () => {
  it("keeps Personal background work running while Team jobs stay stopped", async () => {
    const projection = service();
    const embeddingAndLcm = service();
    const crossIdentitySync = service();
    const replayPruning = service();
    const retentionPurge = service();
    const otherTeamJob = service();

    const active = startWorkerBackgroundServices({
      teamCollaborationEnabled: false,
      personal: [projection, embeddingAndLcm],
      maintenance: [retentionPurge],
      team: [crossIdentitySync, replayPruning, otherTeamJob]
    });

    expect(projection.start).toHaveBeenCalledOnce();
    expect(embeddingAndLcm.start).toHaveBeenCalledOnce();
    for (const teamService of [
      crossIdentitySync,
      replayPruning,
      otherTeamJob
    ]) {
      expect(teamService.start).not.toHaveBeenCalled();
    }
    expect(retentionPurge.start).toHaveBeenCalledOnce();

    await active.stop();
    expect(projection.stop).toHaveBeenCalledOnce();
    expect(embeddingAndLcm.stop).toHaveBeenCalledOnce();
    expect(crossIdentitySync.stop).not.toHaveBeenCalled();
    expect(retentionPurge.stop).toHaveBeenCalledOnce();
  });

  it("starts Team background work only when explicitly enabled", () => {
    const projection = service();
    const crossIdentitySync = service();
    const replayPruning = service();
    const retentionPurge = service();

    startWorkerBackgroundServices({
      teamCollaborationEnabled: true,
      personal: [projection],
      maintenance: [retentionPurge],
      team: [crossIdentitySync, replayPruning]
    });

    expect(projection.start).toHaveBeenCalledOnce();
    expect(crossIdentitySync.start).toHaveBeenCalledOnce();
    expect(replayPruning.start).toHaveBeenCalledOnce();
    expect(retentionPurge.start).toHaveBeenCalledOnce();
  });
});
