import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopOnboardingStatePath,
  readDesktopOnboardingComplete,
  writeDesktopOnboardingComplete
} from "./onboarding-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const home = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-onboarding-"));
  roots.push(root);
  return root;
};

describe("Desktop onboarding state", () => {
  it("fails closed for absent, malformed, or unsupported state", () => {
    const path = desktopOnboardingStatePath(home());
    expect(readDesktopOnboardingComplete(path)).toBe(false);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ complete: true, schemaVersion: 2 }), {
      flag: "w"
    });
    expect(readDesktopOnboardingComplete(path)).toBe(false);
  });

  it("persists validated completion state atomically under KOED_HOME", () => {
    const path = desktopOnboardingStatePath(home());
    writeDesktopOnboardingComplete(path, new Date("2026-07-26T15:00:00.000Z"));

    expect(readDesktopOnboardingComplete(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      complete: true,
      completedAt: "2026-07-26T15:00:00.000Z",
      schemaVersion: 1
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
