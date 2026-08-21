export const aiClientSourceAdapterRegistry = Object.freeze([
  Object.freeze({
    sourceKind: "codex",
    sourceRuntime: "codex",
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "codex-transcript-v1"
  }),
  Object.freeze({
    sourceKind: "codex",
    sourceRuntime: "codex-cli",
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "codex-transcript-v1"
  }),
  Object.freeze({
    sourceKind: "claude-code",
    sourceRuntime: "claude-code",
    artifactFormat: "claude_session_jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "claude-code-transcript-v1"
  }),
  Object.freeze({
    sourceKind: "pi",
    sourceRuntime: "pi",
    artifactFormat: "pi_session_jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "pi-session-v1"
  })
] as const);

export const privacyMaterializationSourceAdapters = Object.freeze([
  Object.freeze({
    sourceKind: "codex",
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1
  })
] as const);

export const isPrivacyMaterializationSourceAdapter = (candidate: {
  sourceKind?: unknown;
  artifactFormat?: unknown;
  artifactFormatVersion?: unknown;
}): boolean =>
  privacyMaterializationSourceAdapters.some(
    (adapter) =>
      candidate.sourceKind === adapter.sourceKind &&
      candidate.artifactFormat === adapter.artifactFormat &&
      candidate.artifactFormatVersion === adapter.artifactFormatVersion
  );

export type AiClientSourceAdapter =
  (typeof aiClientSourceAdapterRegistry)[number];

export type AiClientSourceKind = AiClientSourceAdapter["sourceKind"];
export type AiClientSourceRuntime = AiClientSourceAdapter["sourceRuntime"];
export type AiClientSourceArtifactFormat =
  AiClientSourceAdapter["artifactFormat"];
export type AiClientSourceArtifactFormatVersion =
  AiClientSourceAdapter["artifactFormatVersion"];
export type AiClientSourceAdapterVersion =
  AiClientSourceAdapter["sourceAdapterVersion"];

export interface AiClientSourceAdapterCandidate {
  sourceKind?: unknown;
  sourceRuntime?: unknown;
  artifactFormat?: unknown;
  artifactFormatVersion?: unknown;
  sourceAdapterVersion?: unknown;
}

export const resolveAiClientSourceAdapter = (
  candidate: AiClientSourceAdapterCandidate
): AiClientSourceAdapter | null =>
  aiClientSourceAdapterRegistry.find(
    (adapter) =>
      candidate.sourceKind === adapter.sourceKind &&
      candidate.sourceRuntime === adapter.sourceRuntime &&
      candidate.artifactFormat === adapter.artifactFormat &&
      candidate.artifactFormatVersion === adapter.artifactFormatVersion &&
      candidate.sourceAdapterVersion === adapter.sourceAdapterVersion
  ) ?? null;

export const isSupportedAiClientSourceAdapter = (
  candidate: AiClientSourceAdapterCandidate
): candidate is AiClientSourceAdapterCandidate & AiClientSourceAdapter =>
  resolveAiClientSourceAdapter(candidate) !== null;

export function assertSupportedAiClientSourceAdapter(
  candidate: AiClientSourceAdapterCandidate
): asserts candidate is AiClientSourceAdapterCandidate & AiClientSourceAdapter {
  if (!isSupportedAiClientSourceAdapter(candidate)) {
    throw new TypeError("AI-client source adapter tuple is unsupported");
  }
}
