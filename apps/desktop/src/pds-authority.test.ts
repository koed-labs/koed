import { describe, expect, it, vi } from "vitest";
import {
  ensurePdsDesktopAuthority,
  PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE
} from "./pds-authority.js";

describe("PDS Desktop Authority provisioning", () => {
  it("creates and verifies one separate authority secret", async () => {
    const values = new Map<string, string>();
    const store = {
      get: vi.fn(async (reference: string) => values.get(reference) ?? null),
      put: vi.fn(async (reference: string, value: string) => {
        values.set(reference, value);
      }),
      delete: vi.fn()
    };
    await ensurePdsDesktopAuthority(store);
    await ensurePdsDesktopAuthority(store);
    expect(store.put).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(
      values.get(PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE)!
    );
    expect(parsed).toMatchObject({
      version: 1,
      keyId: expect.any(String),
      publicKey: expect.any(String),
      privateSeed: expect.any(String)
    });
  });

  it("fails closed instead of replacing invalid authority material", async () => {
    const put = vi.fn();
    await expect(
      ensurePdsDesktopAuthority({
        get: async () => '{"version":1}',
        put,
        delete: vi.fn()
      })
    ).rejects.toThrow("Authority key is invalid");
    expect(put).not.toHaveBeenCalled();
  });
});
