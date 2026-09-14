import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { cpus, release } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { PrivacyValidationCache } from "./runtime-manager.js";

const providers = new Set(["cpu", "cuda", "coreml", "dml"]);
type CacheValue = NonNullable<
  Awaited<ReturnType<PrivacyValidationCache["read"]>>
>;

function valid(value: unknown): value is CacheValue {
  if (!value || typeof value !== "object") return false;
  const v = value as CacheValue;
  return (
    Array.isArray(v.baseline) &&
    v.baseline.length === 3 &&
    v.baseline.every(
      (entry) =>
        entry &&
        typeof entry.maskedText === "string" &&
        typeof entry.spans === "string"
    ) &&
    Array.isArray(v.providers) &&
    v.providers.includes("cpu") &&
    v.providers.every((p) => providers.has(p)) &&
    Array.isArray(v.calibrations) &&
    v.calibrations.every(
      (c) =>
        c &&
        providers.has(c.provider) &&
        v.providers.includes(c.provider) &&
        typeof c.measuredAt === "string" &&
        Number.isFinite(Date.parse(c.measuredAt)) &&
        [
          c.sampleTokens,
          c.durationMs,
          c.sampleCount,
          c.warmTokensPerSecond
        ].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    )
  );
}

/** Only synthetic fixture outputs and provider measurements are persisted. */
export function fileValidationCache(
  path: string,
  fingerprint: string
): PrivacyValidationCache {
  const key = (runtime: Parameters<PrivacyValidationCache["read"]>[0]) =>
    JSON.stringify([
      fingerprint,
      runtime.modelId,
      runtime.modelRevision,
      runtime.classifierHash
    ]);
  return {
    async read(runtime) {
      try {
        const raw = await readFile(path, "utf8");
        if (raw.length > 64_000) return undefined;
        const parsed = JSON.parse(raw) as { key?: string; value?: unknown };
        return parsed.key === key(runtime) && valid(parsed.value)
          ? parsed.value
          : undefined;
      } catch {
        return undefined;
      }
    },
    async write(runtime, value) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          temporary,
          JSON.stringify({ key: key(runtime), value }),
          { mode: 0o600, flag: "wx" }
        );
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
  };
}

export async function createValidationCache(
  modelCache: string,
  cachePath = join(modelCache, "runtime-validation-v1.json")
): Promise<PrivacyValidationCache | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const transformer = require.resolve("@huggingface/transformers");
    const onnx = createRequire(transformer).resolve("onnxruntime-node");
    const sources = await Promise.all(
      [
        "runtime",
        "runtime-manager",
        "validation-cache",
        "masking",
        "decoder",
        "offsets",
        "labels",
        "secrets",
        "provenance"
      ].map((name) => readFile(new URL(`./${name}.js`, import.meta.url)))
    );
    const command =
      process.platform === "darwin"
        ? ([
            "/usr/sbin/system_profiler",
            ["SPDisplaysDataType", "-json"]
          ] as const)
        : process.platform === "win32"
          ? ([
              "powershell.exe",
              [
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion | ConvertTo-Json -Compress"
              ]
            ] as const)
          : ([
              "nvidia-smi",
              ["--query-gpu=uuid,name,driver_version", "--format=csv,noheader"]
            ] as const);
    let acceleratorIdentity: string;
    try {
      acceleratorIdentity = (
        await promisify(execFile)(command[0], [...command[1]], {
          timeout: 3000,
          maxBuffer: 1024 * 1024
        })
      ).stdout;
    } catch {
      // Without a stable accelerator identity, do not reuse provider validation.
      return undefined;
    }
    const hash = createHash("sha256");
    hash.update(acceleratorIdentity);
    hash.update(
      JSON.stringify(
        Object.entries(process.env)
          .filter(([key]) => /^(ORT_|OMP_|CUDA_|DML_)/.test(key))
          .sort()
      )
    );
    for (const source of sources) hash.update(source);
    // Resolved dependency paths include package versions in bundled/pnpm installs.
    hash.update(transformer).update(onnx);
    hash.update(await readFile(transformer)).update(await readFile(onnx));
    hash.update(
      JSON.stringify([
        process.platform,
        process.arch,
        process.version,
        release(),
        cpus().map((cpu) => cpu.model),
        modelCache
      ])
    );
    return fileValidationCache(cachePath, hash.digest("hex"));
  } catch {
    // An unsupported package layout disables caching, never validation.
    return undefined;
  }
}
