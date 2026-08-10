import { describe, expect, it } from "vitest";
import { decideHistoricalAdmission } from "./historical-admission.js";

const config = {
  maxBytes: 1_000_000,
  maxConcurrency: 1,
  maxRows: 100,
  maxRuntimeMs: 15_000,
  maxLiveProjectionRows: 0
};

const input = {
  apiHealthy: true,
  queueHealthy: true,
  embeddingServiceHealthy: true,
  historicalImportRows: 10,
  liveProjectionRows: 0,
  activeHistoricalBatches: 0
};

describe("historical import admission", () => {
  it("admits only when live pressure is below its threshold", () => {
    expect(decideHistoricalAdmission(input, config)).toEqual({
      admitted: true
    });
    expect(
      decideHistoricalAdmission({ ...input, liveProjectionRows: 1 }, config)
    ).toEqual({ admitted: false, reason: "live_projection_pressure" });
  });

  it("pauses historical admission for every degraded dependency", () => {
    expect(
      decideHistoricalAdmission({ ...input, apiHealthy: false }, config)
    ).toEqual({ admitted: false, reason: "api_degraded" });
    expect(
      decideHistoricalAdmission({ ...input, queueHealthy: false }, config)
    ).toEqual({ admitted: false, reason: "queue_degraded" });
    expect(
      decideHistoricalAdmission(
        { ...input, embeddingServiceHealthy: false },
        config
      )
    ).toEqual({ admitted: false, reason: "embedding_service_degraded" });
  });

  it("caps historical concurrency and ignores an empty backlog", () => {
    expect(
      decideHistoricalAdmission(
        { ...input, activeHistoricalBatches: 1 },
        config
      )
    ).toEqual({ admitted: false, reason: "concurrency_cap" });
    expect(
      decideHistoricalAdmission({ ...input, historicalImportRows: 0 }, config)
    ).toEqual({ admitted: false, reason: "no_historical_backlog" });
  });
});
