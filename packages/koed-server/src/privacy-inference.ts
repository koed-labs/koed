import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export interface PrivacyInferenceVerification {
  activeProvider: "cpu" | "cuda";
  requestedProvider: "cpu" | "cuda";
  executedProviders: string[];
  proof: "onnx-execution-profile" | "cpu-only-worker";
  maskingSha256: string;
  fallbackReason?: string;
}

export function isPrivacyInferenceVerification(
  value: unknown,
  requestedProvider?: "cpu" | "cuda"
): value is PrivacyInferenceVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as PrivacyInferenceVerification;
  return (
    ["cpu", "cuda"].includes(result.activeProvider) &&
    ["cpu", "cuda"].includes(result.requestedProvider) &&
    (requestedProvider === undefined ||
      result.requestedProvider === requestedProvider) &&
    /^[a-f0-9]{64}$/.test(result.maskingSha256) &&
    Array.isArray(result.executedProviders) &&
    result.executedProviders.every(
      (provider) => typeof provider === "string"
    ) &&
    ["onnx-execution-profile", "cpu-only-worker"].includes(result.proof) &&
    (result.activeProvider !== "cuda" ||
      (result.requestedProvider === "cuda" &&
        result.proof === "onnx-execution-profile" &&
        result.executedProviders.includes("CUDAExecutionProvider"))) &&
    (result.activeProvider !== "cpu" ||
      result.proof === "cpu-only-worker" ||
      result.executedProviders.includes("CPUExecutionProvider")) &&
    (result.requestedProvider !== "cuda" ||
      result.activeProvider !== "cpu" ||
      result.fallbackReason === "cuda_initialization_or_inference_failed") &&
    (result.fallbackReason === undefined ||
      (result.requestedProvider === "cuda" &&
        result.activeProvider === "cpu" &&
        result.fallbackReason === "cuda_initialization_or_inference_failed"))
  );
}

export async function verifyPrivacyComponentInference(input: {
  paths: KoedServerPaths;
  componentRoot: string;
  modelPath: string;
  provider: "cpu" | "cuda";
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PrivacyInferenceVerification> {
  input.signal?.throwIfAborted();
  const cache = resolve(input.paths.cacheDir, "privacy-verification");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(resolve(cache, "inference-"));
  const env: NodeJS.ProcessEnv = {
    ...input.environment,
    KOED_PRIVACY_TRANSFORMERS_CACHE: input.modelPath,
    PRIVACY_SERVICE_TOKEN: randomUUID(),
    PRIVACY_RUNTIME_CONTROL_TOKEN: randomUUID()
  };
  delete env.NODE_PATH;
  try {
    return await new Promise<PrivacyInferenceVerification>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [
            resolve(
              dirname(import.meta.filename),
              "privacy-inference-probe.js"
            ),
            input.componentRoot,
            input.modelPath,
            input.provider,
            work
          ],
          { cwd: input.componentRoot, env, stdio: ["ignore", "pipe", "pipe"] }
        );
        let output = "";
        let errors = "";
        let failure: Error | undefined;
        const stop = (error: Error) => {
          failure ??= error;
          child.kill("SIGKILL");
        };
        const abort = () => stop(new Error("Privacy installation cancelled."));
        const timer = setTimeout(
          () => stop(new Error("Privacy inference verification timed out.")),
          input.timeoutMs ?? 180000
        );
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-64 * 1024);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errors = (errors + chunk.toString()).slice(-4000);
        });
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
        child.once("error", (error) => {
          failure ??= error;
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          if (failure) {
            reject(failure);
            return;
          }
          if (code !== 0) {
            reject(
              new Error(
                `Privacy inference verification failed: ${errors.trim() || `process exited ${code}`}`
              )
            );
            return;
          }
          try {
            const line = output
              .split(/\r?\n/)
              .find((line) =>
                line.startsWith("KOED_PRIVACY_INFERENCE_RESULT:")
              );
            const result = JSON.parse(
              line?.slice("KOED_PRIVACY_INFERENCE_RESULT:".length) ?? "null"
            ) as PrivacyInferenceVerification | null;
            if (!isPrivacyInferenceVerification(result, input.provider))
              throw new Error(
                "Privacy inference verification returned invalid execution evidence."
              );
            resolveResult(result);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
