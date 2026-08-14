import { describe, expect, it, vi } from "vitest";
import { createSharedMemoryEmbeddingService } from "./shared-memory-embedding-service.js";

describe("Shared Memory embedding reconciliation", () => {
  it("runs through the normal background embedding workflow", async () => {
    const reconcileSharedMemorySemanticItems = vi.fn().mockResolvedValue({
      processed: 2,
      embedded: 2,
      failed: 0
    });
    const service = createSharedMemoryEmbeddingService({
      embeddingWorkflow: { reconcileSharedMemorySemanticItems },
      logger: { info: vi.fn(), error: vi.fn() }
    });

    await expect(service.processOnce()).resolves.toEqual({
      processed: 2,
      embedded: 2,
      failed: 0
    });
    expect(reconcileSharedMemorySemanticItems).toHaveBeenCalledWith({
      limit: 32
    });
  });
});
