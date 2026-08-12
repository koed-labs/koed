import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  combineProductPeakMemoryTelemetry,
  resolveProductProcessInventory,
  startProductPeakMemorySampler
} from "./process-telemetry.js";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

const livePid = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child.pid!;
};

describe("Retrieval Arena product process telemetry", () => {
  it("combines concurrent stable processes with the maximum sequential AI child", async () => {
    const pids = await Promise.all([livePid(), livePid(), livePid()]);
    const inventory = resolveProductProcessInventory({
      KOED_EVAL_PRODUCT_PROCESS_TELEMETRY: JSON.stringify({
        schemaVersion: "koed-retrieval-arena-process-telemetry-v1",
        components: [
          ["api", "memory-api"],
          ["database", "postgres"],
          ["embedding_service", "qwen-embedding"]
        ].map(([role, component], index) => ({
          role,
          component,
          pid: pids[index],
          provenance: `runtime-status:${component}`
        }))
      })
    });
    const stable = startProductPeakMemorySampler(inventory!).finish();
    const report = combineProductPeakMemoryTelemetry(stable, [
      {
        role: "ai_client_model",
        component: "codex-reader",
        pid: 10001,
        peakRssBytes: 40,
        provenance: "memory-answer-app-server-attempt:1",
        measurement: "proc_status_tree",
        attemptIndex: 1,
        sampleCount: 4,
        samplingIntervalMs: 10
      },
      {
        role: "ai_client_model",
        component: "codex-reader",
        pid: 10002,
        peakRssBytes: 70,
        provenance: "memory-answer-app-server-attempt:2",
        measurement: "ps_rss",
        attemptIndex: 2,
        sampleCount: 5,
        samplingIntervalMs: 10
      }
    ]);

    expect(report.components).toHaveLength(5);
    expect(report.dynamicAiClientPeakRssBytes).toBe(70);
    expect(report.aggregatePeakRssBytes).toBe(
      report.stableAggregatePeakRssBytes + 70
    );
    expect(report.aggregation).toBe("stable_concurrent_plus_max_dynamic_child");
  });

  it("fails closed when stable inventory or dynamic child telemetry is absent", async () => {
    expect(() =>
      resolveProductProcessInventory({
        KOED_EVAL_PRODUCT_PROCESS_TELEMETRY: JSON.stringify({
          schemaVersion: "koed-retrieval-arena-process-telemetry-v1",
          components: [
            {
              role: "api",
              component: "memory-api",
              pid: process.pid,
              provenance: "runtime-status"
            }
          ]
        })
      })
    ).toThrow();
    expect(() =>
      resolveProductProcessInventory({
        KOED_EVAL_PRODUCT_PROCESS_TELEMETRY: JSON.stringify({
          schemaVersion: "koed-retrieval-arena-process-telemetry-v1",
          components: [
            "api",
            "database",
            "embedding_service",
            "ai_client_model"
          ].map((role, index) => ({
            role,
            component: role,
            pid: process.pid + index,
            provenance: `${role}-status`
          }))
        })
      })
    ).toThrow();

    const pids = await Promise.all([livePid(), livePid(), livePid()]);
    const inventory = resolveProductProcessInventory({
      KOED_EVAL_PRODUCT_PROCESS_TELEMETRY: JSON.stringify({
        schemaVersion: "koed-retrieval-arena-process-telemetry-v1",
        components: ["api", "database", "embedding_service"].map(
          (role, index) => ({
            role,
            component: role,
            pid: pids[index],
            provenance: `${role}-status`
          })
        )
      })
    });
    expect(() =>
      combineProductPeakMemoryTelemetry(
        startProductPeakMemorySampler(inventory!).finish(),
        []
      )
    ).toThrow(/missing dynamically measured ai_client_model/);
  });
});
