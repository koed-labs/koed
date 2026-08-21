import { describe, expect, it, vi } from "vitest";

import { changeFidelityBundle, createShareBundle } from "./bundles.js";

const expected = {
  consentId: "00000000-0000-4000-8000-000000000001",
  logicalMemoryId: "00000000-0000-4000-8000-000000000002",
  teamId: "00000000-0000-4000-8000-000000000003",
  teamWorkspaceId: "00000000-0000-4000-8000-000000000004",
  previewId: "00000000-0000-4000-8000-000000000005",
  previewRevision: 3,
  previewHash: "a".repeat(64),
  maximumFidelity: "memory_events" as const,
  includeCuratedMemory: true
};

const consent = { ...expected };
const grant = {
  logicalMemoryId: expected.logicalMemoryId,
  teamId: expected.teamId,
  teamWorkspaceId: expected.teamWorkspaceId,
  consentId: expected.consentId,
  maximumFidelity: "memory_events",
  includeCuratedMemory: true
};
const actor = { userId: "00000000-0000-4000-8000-000000000006" };

describe("Shared Memory bundle invariants", () => {
  it("delegates share creation to the repository-owned transaction", async () => {
    const createShareBundleRepository = vi.fn(async () => ({ consent, grant }));
    const repository = {
      createShareBundle: createShareBundleRepository,
      changeFidelityBundle: vi.fn()
    };

    await expect(
      createShareBundle(repository as never, actor, {
        consent: {} as never,
        grant: {} as never,
        expected
      })
    ).resolves.toEqual({ consent, grant });
    expect(createShareBundleRepository).toHaveBeenCalledWith(actor, {
      consent: {},
      grant: {},
      expected
    });
  });

  it("propagates a repository transaction failure", async () => {
    const failure = new Error("grant write failed");
    const repository = {
      createShareBundle: vi.fn(async () => {
        throw failure;
      }),
      changeFidelityBundle: vi.fn()
    };

    await expect(
      createShareBundle(repository as never, actor, {
        consent: {} as never,
        grant: {} as never,
        expected
      })
    ).rejects.toBe(failure);
  });

  it("delegates cumulative fidelity change to the repository-owned transaction", async () => {
    const changeFidelityBundleRepository = vi.fn(async () => ({
      consent,
      grant
    }));
    const repository = {
      createShareBundle: vi.fn(),
      changeFidelityBundle: changeFidelityBundleRepository
    };

    await expect(
      changeFidelityBundle(repository as never, actor, {
        consent: {} as never,
        fidelity: {} as never,
        expected
      })
    ).resolves.toEqual({ consent, grant });
    expect(changeFidelityBundleRepository).toHaveBeenCalledWith(actor, {
      consent: {},
      fidelity: {},
      expected
    });
  });
});
