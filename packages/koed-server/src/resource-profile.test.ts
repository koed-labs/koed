import { describe, expect, it } from "vitest";
import { applyResourceProfile } from "./resource-profile.js";

describe("resource profile", () => {
  it("leaves Balanced to each component's defaults", () => {
    expect(
      applyResourceProfile({ A: "1" }, "balanced", { cpuCount: 8 })
    ).toEqual({
      A: "1"
    });
  });

  it("fills in Low and Full settings", () => {
    expect(applyResourceProfile({}, "low", { cpuCount: 8 })).toEqual({
      KOED_BACKGROUND_NICE: "19",
      EMBEDDING_LLAMA_N_THREADS: "2",
      MEMORY_CODEX_TRANSCRIPT_POLL_MS: "15000"
    });
    expect(applyResourceProfile({}, "full", { cpuCount: 8 })).toEqual({
      KOED_BACKGROUND_NICE: "0",
      EMBEDDING_LLAMA_N_THREADS: "8",
      MEMORY_CODEX_TRANSCRIPT_POLL_MS: "1000"
    });
  });

  it("keeps at least one embedding thread", () => {
    expect(
      applyResourceProfile({}, "low", { cpuCount: 2 }).EMBEDDING_LLAMA_N_THREADS
    ).toBe("1");
  });

  it("never overrides an explicit setting", () => {
    expect(
      applyResourceProfile(
        { KOED_BACKGROUND_NICE: "5", LLAMA_N_THREADS: "3" },
        "low",
        {
          cpuCount: 8,
          explicit: { MEMORY_CODEX_TRANSCRIPT_POLL_MS: "2000" }
        }
      )
    ).toEqual({ KOED_BACKGROUND_NICE: "5", LLAMA_N_THREADS: "3" });
  });

  it("treats a blank setting as unset", () => {
    expect(
      applyResourceProfile({}, "full", {
        cpuCount: 4,
        explicit: { EMBEDDING_LLAMA_N_THREADS: " " }
      }).EMBEDDING_LLAMA_N_THREADS
    ).toBe("4");
  });

  it("keeps a repository setting when the process variable is blank", () => {
    expect(
      applyResourceProfile({ EMBEDDING_LLAMA_N_THREADS: "" }, "low", {
        cpuCount: 8,
        explicit: { EMBEDDING_LLAMA_N_THREADS: "8" },
        overrides: { embeddingThreads: 6 }
      }).EMBEDDING_LLAMA_N_THREADS
    ).toBe("");
  });
});
