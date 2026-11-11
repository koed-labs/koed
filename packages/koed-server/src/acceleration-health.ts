import type {
  AccelerationSnapshot,
  EmbeddingBackend
} from "./acceleration-contract.js";
import type { RuntimeLifecycleObservation } from "./runtime-lifecycle.js";
import { fetchBoundedJsonObject } from "@koed-labs/shared";

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const reason = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z0-9_ -]{1,120}$/i.test(value)
    ? value
    : null;
const backend = (value: unknown): EmbeddingBackend | null => {
  const match =
    typeof value === "string"
      ? /^(cpu|cuda|metal);runtime=llama\.cpp;n-gpu-layers=(?:\d+|all)$/.exec(
          value
        )
      : null;
  return match ? (match[1] as EmbeddingBackend) : null;
};

// Read only the authenticated, content-free service status. Never forward raw
// service responses, credentials, paths, or subprocess output to the renderer.
async function status(
  base: string,
  path: string,
  token: string | undefined,
  header: string,
  fetcher: typeof fetch
) {
  if (!token?.trim()) return null;
  try {
    const parsed = new URL(path, base);
    if (
      parsed.username ||
      parsed.password ||
      !["http:", "https:"].includes(parsed.protocol)
    )
      return null;
    const { response, payload } = await fetchBoundedJsonObject(
      fetcher,
      parsed,
      { headers: { [header]: token }, redirect: "error" },
      { timeoutMs: 5_000, maxBytes: 64 * 1024 }
    );
    return response.ok ? payload : null;
  } catch {
    return null;
  }
}

export async function inspectAccelerationServices({
  environment,
  lifecycle,
  externalEmbeddingUrl,
  externalPrivacyUrl,
  privacyInstalled,
  fetcher = fetch
}: {
  environment: NodeJS.ProcessEnv;
  lifecycle: RuntimeLifecycleObservation;
  externalEmbeddingUrl?: string;
  externalPrivacyUrl?: string;
  privacyInstalled: boolean;
  fetcher?: typeof fetch;
}): Promise<Pick<AccelerationSnapshot, "embedding" | "privacy">> {
  const embedding: AccelerationSnapshot["embedding"] = {
    state:
      lifecycle.state === "stopped"
        ? "stopped"
        : lifecycle.state === "starting"
          ? "starting"
          : "unavailable",
    backend: null,
    fallbackReason: null
  };
  const privacy: AccelerationSnapshot["privacy"] = {
    state: !privacyInstalled
      ? "absent"
      : lifecycle.state === "stopped"
        ? "stopped"
        : "unavailable",
    provider: null,
    fallbackReason: null
  };
  // Lifecycle tracks supervisor ownership, not individual service readiness.
  // A service can become ready before supervisor startup completes.
  // Let authenticated service health establish the backend independently.
  if (
    lifecycle.state !== "running" &&
    lifecycle.state !== "starting" &&
    !externalEmbeddingUrl
  )
    return { embedding, privacy };
  const embeddingBase =
    externalEmbeddingUrl ??
    `http://${environment.KOED_EMBEDDING_HOST?.trim() || "127.0.0.1"}:${environment.KOED_EMBEDDING_PORT?.trim() || environment.EMBEDDING_SERVICE_HOST_PORT?.trim() || "3800"}`;
  const privacyBase =
    externalPrivacyUrl ??
    `http://${environment.PRIVACY_SERVICE_HOST?.trim() || "127.0.0.1"}:${environment.PRIVACY_SERVICE_PORT?.trim() || "8092"}`;
  const [embeddingStatus, privacyStatus] = await Promise.all([
    status(
      embeddingBase,
      "/health",
      environment.EMBEDDING_SERVICE_TOKEN,
      "x-koed-embedding-token",
      fetcher
    ),
    privacyInstalled
      ? status(
          privacyBase,
          "/v1/runtime/status",
          environment.PRIVACY_RUNTIME_CONTROL_TOKEN,
          "x-koed-privacy-token",
          fetcher
        )
      : null
  ]);
  if (
    embeddingStatus?.status === "ok" &&
    embeddingStatus.authRequired === true &&
    embeddingStatus.authValid === true
  ) {
    // The service encodes its verified backend in accelerationDescription.
    embedding.backend = backend(embeddingStatus.acceleration);
    embedding.state = embedding.backend ? "ready" : "unavailable";
    embedding.fallbackReason = reason(
      record(embeddingStatus.accelerationFallback)?.reason
    );
  }
  if (
    privacyStatus &&
    privacyStatus.component === "privacy_filter" &&
    privacyStatus.switchState === "ready" &&
    (privacyStatus.inferenceState === undefined ||
      privacyStatus.inferenceState === "ready") &&
    ["cpu", "cuda", "coreml", "directml"].includes(
      String(privacyStatus.activeProvider)
    ) &&
    Array.isArray(privacyStatus.verifiedProviders) &&
    privacyStatus.verifiedProviders.includes(privacyStatus.activeProvider)
  ) {
    privacy.state = "ready";
    privacy.provider = String(privacyStatus.activeProvider);
    privacy.fallbackReason = reason(privacyStatus.fallbackReason);
  }
  return { embedding, privacy };
}
