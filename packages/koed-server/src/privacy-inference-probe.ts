import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const corpus = ["Email Alice at alice@example.com and call +44 7700 900123."];
type Provider = "cpu" | "cuda";
type Signature = Array<{ maskedText: string; spans: string }>;
interface Runtime {
  load(): Promise<void>;
  isReady(): boolean;
  dispose(): Promise<void>;
}

// This entrypoint is launched only after the component and model are admitted.
// Profiling establishes actual kernel execution; requested-provider labels alone
// cannot establish CUDA success. No timings are used for download selection.
export async function runPrivacyInferenceProbe(
  args = process.argv.slice(2)
): Promise<void> {
  const [root, cache, requested, work] = args;
  if (!root || !cache || !work || (requested !== "cpu" && requested !== "cuda"))
    throw new Error("Invalid Privacy inference verification arguments.");
  const moduleUrl = (file: string) =>
    pathToFileURL(
      resolve(root, "node_modules/@koed/privacy-service/dist", file)
    ).href;
  const [{ resolveConfig }, { createPrivacyRuntime }, { parityOutput }] =
    await Promise.all([
      import(moduleUrl("config.js")) as Promise<{
        resolveConfig(): { runtimeEngine?: string };
      }>,
      import(moduleUrl("runtime-factory.js")) as Promise<{
        createPrivacyRuntime(
          config: unknown,
          provider: Provider,
          verification: { profilePrefix: string }
        ): Runtime;
      }>,
      import(moduleUrl("runtime-manager.js")) as Promise<{
        parityOutput(runtime: Runtime, corpus: string[]): Promise<Signature>;
      }>
    ]);
  process.env.KOED_PRIVACY_TRANSFORMERS_CACHE = resolve(cache);
  const config = resolveConfig();
  let sequence = 0;
  const infer = async (provider: Provider) => {
    const prefix = `provider-${sequence++}`;
    const runtime = createPrivacyRuntime(config, provider, {
      profilePrefix: resolve(work, prefix)
    });
    let signature: Signature;
    try {
      await runtime.load();
      if (!runtime.isReady())
        throw new Error("Privacy model did not become ready.");
      signature = await parityOutput(runtime, corpus);
      if (
        signature.length !== 1 ||
        signature[0]!.maskedText === corpus[0] ||
        signature[0]!.maskedText.includes("alice@example.com") ||
        signature[0]!.spans === "[]"
      )
        throw new Error(
          "Privacy verification did not mask the synthetic fixture."
        );
    } finally {
      await runtime.dispose();
    }
    const providers = new Set<string>();
    for (const name of readdirSync(work).filter(
      (name) => name.startsWith(`${prefix}_`) && name.endsWith(".json")
    )) {
      const events: unknown = JSON.parse(
        readFileSync(resolve(work, name), "utf8")
      );
      if (!Array.isArray(events))
        throw new Error("Invalid ONNX execution profile.");
      for (const event of events as unknown[]) {
        if (!event || typeof event !== "object") continue;
        const entry = event as { cat?: unknown; args?: { provider?: unknown } };
        if (entry.cat === "Node" && typeof entry.args?.provider === "string")
          providers.add(entry.args.provider);
      }
    }
    const cpuWorker =
      provider === "cpu" && config.runtimeEngine === "onnx-worker";
    if (
      !cpuWorker &&
      !providers.has(
        provider === "cuda" ? "CUDAExecutionProvider" : "CPUExecutionProvider"
      )
    )
      throw new Error(
        `Actual ${provider} execution was not established by ONNX profiling.`
      );
    return {
      signature,
      providers: [...providers].sort(),
      proof: cpuWorker ? "cpu-only-worker" : "onnx-execution-profile"
    };
  };
  const cpu = await infer("cpu");
  let selected = cpu;
  let activeProvider: Provider = "cpu";
  let fallbackReason: string | undefined;
  if (requested === "cuda") {
    try {
      const cuda = await infer("cuda");
      if (JSON.stringify(cuda.signature) !== JSON.stringify(cpu.signature))
        throw new Error("CUDA masking does not match CPU masking.");
      selected = cuda;
      activeProvider = "cuda";
    } catch {
      // Re-run CPU after the CUDA failure; an earlier CPU result is not recovery.
      selected = await infer("cpu");
      if (JSON.stringify(selected.signature) !== JSON.stringify(cpu.signature))
        throw new Error("CPU masking changed during CUDA recovery.");
      fallbackReason = "cuda_initialization_or_inference_failed";
    }
  }
  process.stdout.write(
    `KOED_PRIVACY_INFERENCE_RESULT:${JSON.stringify({ activeProvider, requestedProvider: requested, executedProviders: selected.providers, proof: selected.proof, maskingSha256: createHash("sha256").update(JSON.stringify(selected.signature)).digest("hex"), ...(fallbackReason ? { fallbackReason } : {}) })}\n`
  );
}

if (process.argv[1]?.endsWith("privacy-inference-probe.js"))
  void runPrivacyInferenceProbe().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
