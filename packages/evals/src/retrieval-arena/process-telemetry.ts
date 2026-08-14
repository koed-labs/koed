import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";

const stableProductProcessRoleSchema = z.enum([
  "api",
  "database",
  "embedding_service"
]);
const productProcessRoleSchema = z.enum([
  "api",
  "database",
  "embedding_service",
  "ai_client_model"
]);
const measurementSchema = z.enum([
  "proc_status_tree",
  "ps_rss",
  "powershell_working_set"
]);
const productProcessInventorySchema = z
  .object({
    schemaVersion: z.literal("koed-retrieval-arena-process-telemetry-v1"),
    components: z
      .array(
        z
          .object({
            role: stableProductProcessRoleSchema,
            component: z.string().trim().min(1),
            pid: z.number().int().positive(),
            provenance: z.string().trim().min(1)
          })
          .strict()
      )
      .min(3)
  })
  .strict();

const measuredComponentSchema = z
  .object({
    role: productProcessRoleSchema,
    component: z.string().trim().min(1),
    pid: z.number().int().positive(),
    peakRssBytes: z.number().int().positive(),
    provenance: z.string().trim().min(1),
    measurement: measurementSchema,
    attemptIndex: z.number().int().positive().optional(),
    sampleCount: z.number().int().positive().optional(),
    samplingIntervalMs: z.number().int().positive().optional()
  })
  .strict();

const productPeakMemoryTelemetrySchema = z
  .object({
    schemaVersion: z.literal("koed-retrieval-arena-peak-memory-v2"),
    aggregation: z.literal("stable_concurrent_plus_max_dynamic_child"),
    aggregatePeakRssBytes: z.number().int().positive(),
    stableAggregatePeakRssBytes: z.number().int().positive(),
    dynamicAiClientPeakRssBytes: z.number().int().positive(),
    components: z.array(measuredComponentSchema).min(4)
  })
  .strict();

export type ProductProcessRole = z.infer<typeof productProcessRoleSchema>;
export type ProductProcessInventory = z.infer<
  typeof productProcessInventorySchema
>;
export type ProductPeakMemoryTelemetry = z.infer<
  typeof productPeakMemoryTelemetrySchema
>;
export type DynamicAiClientProcessTelemetry = {
  role: "ai_client_model";
  component: string;
  pid: number;
  peakRssBytes: number;
  provenance: string;
  measurement: z.infer<typeof measurementSchema>;
  attemptIndex: number;
  sampleCount: number;
  samplingIntervalMs: number;
};

type StablePeakMemoryTelemetry = {
  aggregatePeakRssBytes: number;
  components: Array<{
    role: z.infer<typeof stableProductProcessRoleSchema>;
    component: string;
    pid: number;
    peakRssBytes: number;
    provenance: string;
    measurement: "proc_status_tree" | "ps_rss";
  }>;
};

const requiredStableRoles = stableProductProcessRoleSchema.options;
const assertCompleteStableRoles = (
  components: Array<{ role: z.infer<typeof stableProductProcessRoleSchema> }>
): void => {
  const roles = new Set(components.map(({ role }) => role));
  const missing = requiredStableRoles.filter((role) => !roles.has(role));
  if (missing.length)
    throw new Error(
      `product stable process telemetry is missing required roles: ${missing.join(", ")}`
    );
};

export const validateProductPeakMemoryTelemetry = (
  value: unknown
): ProductPeakMemoryTelemetry => {
  const telemetry = productPeakMemoryTelemetrySchema.parse(value);
  assertCompleteStableRoles(
    telemetry.components.filter(
      (
        component
      ): component is typeof component & {
        role: z.infer<typeof stableProductProcessRoleSchema>;
      } => component.role !== "ai_client_model"
    )
  );
  if (!telemetry.components.some(({ role }) => role === "ai_client_model"))
    throw new Error(
      "product process telemetry is missing dynamically measured ai_client_model attempts"
    );
  const dynamic = telemetry.components.filter(
    ({ role }) => role === "ai_client_model"
  );
  if (
    dynamic.some(
      (component) =>
        component.attemptIndex === undefined ||
        component.sampleCount === undefined ||
        component.samplingIntervalMs === undefined
    ) ||
    new Set(dynamic.map(({ attemptIndex }) => attemptIndex)).size !==
      dynamic.length
  )
    throw new Error(
      "dynamic ai_client_model telemetry requires unique attempts and complete sampling provenance"
    );
  const dynamicPeak = Math.max(
    ...dynamic.map(({ peakRssBytes }) => peakRssBytes)
  );
  if (
    telemetry.dynamicAiClientPeakRssBytes !== dynamicPeak ||
    telemetry.aggregatePeakRssBytes !==
      telemetry.stableAggregatePeakRssBytes + dynamicPeak
  )
    throw new Error("product peak-memory telemetry aggregate is inconsistent");
  return telemetry;
};

export const resolveProductProcessInventory = (
  environment: NodeJS.ProcessEnv = process.env
): ProductProcessInventory | null => {
  const configured = environment.KOED_EVAL_PRODUCT_PROCESS_TELEMETRY?.trim();
  if (!configured) return null;
  const inventory = productProcessInventorySchema.parse(JSON.parse(configured));
  assertCompleteStableRoles(inventory.components);
  const pids = new Set<number>();
  for (const component of inventory.components) {
    if (pids.has(component.pid))
      throw new Error(
        `product process telemetry reuses PID ${component.pid}; each stable participating component must be explicit`
      );
    pids.add(component.pid);
  }
  return inventory;
};

const processRss = (
  pid: number
): {
  rssBytes: number;
  measurement: "proc_status_tree" | "ps_rss";
} | null => {
  try {
    const pending = [pid];
    const seen = new Set<number>();
    let rssBytes = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      let status: string;
      let children = "";
      try {
        status = readFileSync(`/proc/${current}/status`, "utf8");
        children = readFileSync(
          `/proc/${current}/task/${current}/children`,
          "utf8"
        ).trim();
      } catch {
        if (current === pid) throw new Error("root process is unavailable");
        continue;
      }
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (match?.[1]) rssBytes += Number(match[1]) * 1024;
      if (children) {
        pending.push(
          ...children
            .split(/\s+/)
            .map(Number)
            .filter((child) => Number.isInteger(child) && child > 0)
        );
      }
    }
    if (rssBytes > 0) return { rssBytes, measurement: "proc_status_tree" };
  } catch {
    // Fall through to the portable ps probe.
  }
  try {
    const kib = Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
    );
    return Number.isFinite(kib) && kib > 0
      ? { rssBytes: kib * 1024, measurement: "ps_rss" }
      : null;
  } catch {
    return null;
  }
};

export const startProductPeakMemorySampler = (
  inventory: ProductProcessInventory
): { sample(): void; finish(): StablePeakMemoryTelemetry } => {
  const peaks = new Map<number, number>();
  const measurements = new Map<number, "proc_status_tree" | "ps_rss">();
  let aggregatePeakRssBytes = 0;
  const sample = (): void => {
    let aggregate = 0;
    for (const component of inventory.components) {
      const current = processRss(component.pid);
      if (!current)
        throw new Error(
          `product process telemetry unavailable for ${component.role}/${component.component} PID ${component.pid}`
        );
      aggregate += current.rssBytes;
      peaks.set(
        component.pid,
        Math.max(peaks.get(component.pid) ?? 0, current.rssBytes)
      );
      measurements.set(component.pid, current.measurement);
    }
    aggregatePeakRssBytes = Math.max(aggregatePeakRssBytes, aggregate);
  };
  sample();
  return {
    sample,
    finish() {
      sample();
      return {
        aggregatePeakRssBytes,
        components: inventory.components.map((component) => ({
          ...component,
          peakRssBytes: peaks.get(component.pid)!,
          measurement: measurements.get(component.pid)!
        }))
      };
    }
  };
};

export const combineProductPeakMemoryTelemetry = (
  stable: StablePeakMemoryTelemetry,
  dynamicAttempts: DynamicAiClientProcessTelemetry[]
): ProductPeakMemoryTelemetry => {
  if (!dynamicAttempts.length)
    throw new Error(
      "product process telemetry is missing dynamically measured ai_client_model attempts"
    );
  const dynamic = dynamicAttempts.map((attempt) =>
    measuredComponentSchema.parse(attempt)
  );
  const dynamicAiClientPeakRssBytes = Math.max(
    ...dynamic.map(({ peakRssBytes }) => peakRssBytes)
  );
  return validateProductPeakMemoryTelemetry({
    schemaVersion: "koed-retrieval-arena-peak-memory-v2",
    aggregation: "stable_concurrent_plus_max_dynamic_child",
    stableAggregatePeakRssBytes: stable.aggregatePeakRssBytes,
    dynamicAiClientPeakRssBytes,
    aggregatePeakRssBytes:
      stable.aggregatePeakRssBytes + dynamicAiClientPeakRssBytes,
    components: [...stable.components, ...dynamic]
  });
};
