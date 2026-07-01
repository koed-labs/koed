import { describe, expect, it } from "vitest";
import {
  lcmSummaryOptionValue,
  parseLcmSummaryRunsOption,
  parseLcmSummaryThresholdOption
} from "./cli-options.js";

describe("LCM summary generation CLI options", () => {
  it("requires values for value-taking flags", () => {
    expect(lcmSummaryOptionValue(["--case", "one"], "--case")).toBe("one");
    expect(() => lcmSummaryOptionValue(["--case"], "--case")).toThrow(
      "--case requires a value"
    );
    expect(() =>
      lcmSummaryOptionValue(["--case", "--runs", "1"], "--case")
    ).toThrow("--case requires a value");
  });

  it("validates runs", () => {
    expect(parseLcmSummaryRunsOption(undefined)).toBeUndefined();
    expect(parseLcmSummaryRunsOption("1")).toBe(1);
    expect(parseLcmSummaryRunsOption("3")).toBe(3);
    expect(() => parseLcmSummaryRunsOption("0")).toThrow("--runs");
    expect(() => parseLcmSummaryRunsOption("-1")).toThrow("--runs");
    expect(() => parseLcmSummaryRunsOption("1.5")).toThrow("--runs");
    expect(() => parseLcmSummaryRunsOption("nope")).toThrow("--runs");
  });

  it("validates threshold", () => {
    expect(parseLcmSummaryThresholdOption(undefined)).toBeUndefined();
    expect(parseLcmSummaryThresholdOption("0")).toBe(0);
    expect(parseLcmSummaryThresholdOption("0.9")).toBe(0.9);
    expect(parseLcmSummaryThresholdOption("1")).toBe(1);
    expect(() => parseLcmSummaryThresholdOption("-0.1")).toThrow("--threshold");
    expect(() => parseLcmSummaryThresholdOption("1.1")).toThrow("--threshold");
    expect(() => parseLcmSummaryThresholdOption("nope")).toThrow("--threshold");
  });

  it("validates semantic judge threshold with the judge flag name", () => {
    expect(parseLcmSummaryThresholdOption("0.85", "--judge-threshold")).toBe(
      0.85
    );
    expect(() =>
      parseLcmSummaryThresholdOption("1.1", "--judge-threshold")
    ).toThrow("--judge-threshold");
  });

  it("reads semantic judge model options", () => {
    const args = [
      "--semantic-judge",
      "--judge-model",
      "codex-app-server:judge",
      "--judge-reasoning-effort",
      "medium"
    ];

    expect(args.includes("--semantic-judge")).toBe(true);
    expect(lcmSummaryOptionValue(args, "--judge-model")).toBe(
      "codex-app-server:judge"
    );
    expect(lcmSummaryOptionValue(args, "--judge-reasoning-effort")).toBe(
      "medium"
    );
  });
});
