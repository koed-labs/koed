// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readNowPreferences, writeNowPreferences } from "./now-preferences.js";

describe("Now folds", () => {
  beforeEach(() => localStorage.clear());
  it("persists the two section folds independently and recovers malformed storage", () => {
    writeNowPreferences({ needsFolded: true, projectsFolded: false });
    expect(readNowPreferences()).toEqual({
      needsFolded: true,
      projectsFolded: false
    });
    localStorage.setItem("koed.hq.now.v1", "broken");
    expect(readNowPreferences()).toEqual({
      needsFolded: false,
      projectsFolded: false
    });
  });
});
