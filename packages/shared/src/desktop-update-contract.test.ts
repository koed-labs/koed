import { describe, expect, it } from "vitest";
import {
  desktopUpdateRequestSchema,
  desktopUpdateStateSchema
} from "./desktop-update-contract.js";

describe("desktop update contract", () => {
  it("accepts only fixed update commands", () => {
    for (const operation of ["get_state", "check", "open_release"]) {
      expect(desktopUpdateRequestSchema.safeParse({ operation }).success).toBe(
        true
      );
    }
    for (const request of [
      { operation: "download" },
      { operation: "restart" },
      { operation: "check", url: "https://evil.example" },
      { operation: "check", extra: true },
      {}
    ]) {
      expect(desktopUpdateRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("requires a release only for available state", () => {
    const release = { version: "0.10.1", summary: "Fixes and improvements" };
    expect(
      desktopUpdateStateSchema.safeParse({
        installedVersion: "0.10.0",
        status: "available",
        release,
        checkedAt: "2026-11-06T00:00:00.000Z"
      }).success
    ).toBe(true);
    for (const status of ["idle", "current", "disabled"]) {
      expect(
        desktopUpdateStateSchema.safeParse({
          installedVersion: "0.10.0",
          status,
          release: null,
          checkedAt: null
        }).success
      ).toBe(true);
      expect(
        desktopUpdateStateSchema.safeParse({
          installedVersion: "0.10.0",
          status,
          release,
          checkedAt: null
        }).success
      ).toBe(false);
    }
    expect(
      desktopUpdateStateSchema.safeParse({
        installedVersion: "0.10.0",
        status: "available",
        release: null,
        checkedAt: null
      }).success
    ).toBe(false);
  });

  it("bounds version, release URL, and release notes", () => {
    expect(
      desktopUpdateStateSchema.safeParse({
        installedVersion: "0.10.0",
        status: "available",
        checkedAt: null,
        release: { version: "0.10.1", summary: "x".repeat(4_001) }
      }).success
    ).toBe(false);
    expect(
      desktopUpdateStateSchema.safeParse({
        installedVersion: "x".repeat(65),
        status: "available",
        checkedAt: null,
        release: { version: "0.10.1", summary: "notes" }
      }).success
    ).toBe(false);
    expect(
      desktopUpdateStateSchema.safeParse({
        installedVersion: "0.10.0",
        status: "available",
        checkedAt: null,
        release: { version: "0.10.1", summary: "x".repeat(4_001) }
      }).success
    ).toBe(false);
  });
});
