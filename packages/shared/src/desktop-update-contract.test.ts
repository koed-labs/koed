import { describe, expect, it } from "vitest";
import {
  desktopUpdateRequestSchema,
  desktopUpdateStateSchema
} from "./desktop-update-contract.js";

describe("Desktop update notice contract", () => {
  it("accepts only fixed notice operations with no installer or URL authority", () => {
    for (const operation of ["get_state", "check", "open_release"]) {
      expect(desktopUpdateRequestSchema.parse({ operation })).toEqual({ operation });
      expect(desktopUpdateRequestSchema.safeParse({ operation, url: "https://evil.test" }).success).toBe(false);
    }
    for (const operation of ["download", "install", "restart", "stop"]) {
      expect(desktopUpdateRequestSchema.safeParse({ operation }).success).toBe(false);
    }
  });

  it("bounds renderer data and never implies availability without a release", () => {
    const state = { installedVersion: "0.8.1", status: "idle", release: null, checkedAt: null };
    expect(desktopUpdateStateSchema.parse(state)).toEqual(state);
    expect(desktopUpdateStateSchema.safeParse({ ...state, status: "available" }).success).toBe(false);
    expect(desktopUpdateStateSchema.safeParse({ ...state, url: "file:///tmp/x" }).success).toBe(false);
    const release = { version: "0.9.0", summary: "<script>plain text only</script>" };
    expect(desktopUpdateStateSchema.parse({ ...state, status: "available", release }).release).toEqual(release);
    expect(desktopUpdateStateSchema.safeParse({ ...state, release: { ...release, summary: "x".repeat(4001) } }).success).toBe(false);
    expect(desktopUpdateStateSchema.safeParse({ ...state, checkedAt: "not a date" }).success).toBe(false);
  });
});
