import { describe, expect, it, vi } from "vitest";
import { SharedMemoryConflictError } from "@koed/shared";
import {
  retryContinuousPreviewAfterFreeze,
  SharedMemoryAuthorizationError
} from "./shared-memory-repository.js";

const databaseConflict = (code: "40001" | "40P01") =>
  Object.assign(new Error("transient database conflict"), { code });

describe("continuous preview retry after a grant freeze", () => {
  it("retries a serialization conflict while the grant remains active", async () => {
    const createPreview = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(databaseConflict("40001"))
      .mockRejectedValueOnce(databaseConflict("40P01"))
      .mockResolvedValueOnce("authoritative preview");
    const grantIsFrozen = vi.fn().mockResolvedValue(false);

    await expect(
      retryContinuousPreviewAfterFreeze(createPreview, grantIsFrozen)
    ).resolves.toEqual({ frozen: false, preview: "authoritative preview" });
    expect(createPreview).toHaveBeenCalledTimes(3);
    expect(grantIsFrozen).toHaveBeenCalledTimes(2);
  });

  it("stops after three transient attempts and propagates the final error", async () => {
    const finalError = databaseConflict("40P01");
    const createPreview = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(databaseConflict("40001"))
      .mockRejectedValueOnce(databaseConflict("40P01"))
      .mockRejectedValueOnce(finalError);
    const grantIsFrozen = vi.fn().mockResolvedValue(false);

    await expect(
      retryContinuousPreviewAfterFreeze(createPreview, grantIsFrozen)
    ).rejects.toBe(finalError);
    expect(createPreview).toHaveBeenCalledTimes(3);
    expect(grantIsFrozen).toHaveBeenCalledTimes(3);
  });

  it("does not hide an unexpected error behind a concurrent freeze", async () => {
    const unexpected = new TypeError("broken preview builder");
    const createPreview = vi.fn().mockRejectedValue(unexpected);
    const grantIsFrozen = vi.fn().mockResolvedValue(true);

    await expect(
      retryContinuousPreviewAfterFreeze(createPreview, grantIsFrozen)
    ).rejects.toBe(unexpected);
    expect(createPreview).toHaveBeenCalledTimes(1);
    expect(grantIsFrozen).not.toHaveBeenCalled();
  });

  it.each([
    new SharedMemoryConflictError("grant changed"),
    new SharedMemoryAuthorizationError("grant frozen")
  ])(
    "accepts an observed freeze after a known lifecycle error",
    async (error) => {
      const createPreview = vi.fn().mockRejectedValue(error);
      const grantIsFrozen = vi.fn().mockResolvedValue(true);

      await expect(
        retryContinuousPreviewAfterFreeze(createPreview, grantIsFrozen)
      ).resolves.toEqual({ frozen: true });
      expect(createPreview).toHaveBeenCalledTimes(1);
      expect(grantIsFrozen).toHaveBeenCalledTimes(1);
    }
  );
});
