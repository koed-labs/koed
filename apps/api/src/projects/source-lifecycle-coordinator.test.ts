import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationActionGrantControl } from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";
import {
  createSourceLifecycleCoordinator,
  type SourceLifecycleOperation
} from "./delete-coordinator.js";

const fixture = (logicalMemoryId: string | null, backend: boolean) => {
  const sourceIdentity = vi.fn(() => null);
  const authority = vi.fn();
  const store = vi.fn(() => {
    throw new Error("Unexpected store access");
  });
  const coordinator = createSourceLifecycleCoordinator({
    sharedMemoryControl: {
      resolveProjectSourceAuthority: authority
    } as unknown as CollaborationSharedMemoryControl,
    actionGrantControl: {} as CollaborationActionGrantControl,
    resolveSourceIdentity: sourceIdentity,
    storeForOperation: store
  });
  const operation: SourceLifecycleOperation = {
    sources: [
      {
        sessionId: randomUUID(),
        logicalMemoryId,
        backends: backend ? [{ backendId: "team-a", relationshipIds: [] }] : []
      }
    ],
    grantFreezeAcks: []
  };
  return {
    coordinator,
    sourceIdentity,
    authority,
    store,
    input: {
      ownerUserId: randomUUID(),
      resourceId: randomUUID(),
      batchId: randomUUID(),
      operation
    }
  };
};

describe("Source lifecycle resource coordination", () => {
  it("does not require Team authority or credentials for a never-shared chat", async () => {
    const value = fixture(null, false);
    await value.coordinator.advance(value.input);
    expect(await value.coordinator.cancel(value.input)).toBe(true);
    expect(value.sourceIdentity).not.toHaveBeenCalled();
    expect(value.authority).not.toHaveBeenCalled();
    expect(value.store).not.toHaveBeenCalled();
  });

  it("fails closed when a backend exists but its retained source identity is missing", async () => {
    const value = fixture(null, true);
    await expect(value.coordinator.advance(value.input)).rejects.toThrow(
      "Verified source identity"
    );
    expect(await value.coordinator.cancel(value.input)).toBe(false);
    expect(value.authority).not.toHaveBeenCalled();
    expect(value.store).not.toHaveBeenCalled();
  });

  it("requires verified owner provenance before any Team dispatch", async () => {
    const value = fixture(randomUUID(), true);
    await expect(value.coordinator.advance(value.input)).rejects.toThrow(
      "Verified Project source identity"
    );
    expect(await value.coordinator.cancel(value.input)).toBe(false);
    expect(value.authority).not.toHaveBeenCalled();
  });
});
