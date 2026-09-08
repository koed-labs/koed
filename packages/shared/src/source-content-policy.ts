export const sourceContentLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxAggregateBytes: 256 * 1024 * 1024,
  maxFiles: 25_000
} as const;

const secretPathPattern =
  /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials$|\.npmrc$|\.pypirc$|service-account[^/]*\.json$)/i;
const environmentTemplatePathPattern =
  /(^|\/)\.env(?:\.[^/]*)?\.(?:example|sample|template)$/i;
const secretContentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{20,}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/
] as const;

export type SourceContentExclusionReason =
  | "secret_path"
  | "secret_content"
  | "git_lfs_pointer";

export const classifySourceContent = (
  path: string,
  bytes: Uint8Array
): SourceContentExclusionReason | null => {
  if (
    secretPathPattern.test(path) &&
    !environmentTemplatePathPattern.test(path)
  ) {
    return "secret_path";
  }
  const decoder = new TextDecoder();
  if (
    decoder
      .decode(bytes.subarray(0, 128))
      .startsWith("version https://git-lfs.github.com/spec/v1\n")
  ) {
    return "git_lfs_pointer";
  }
  const text = decoder.decode(bytes);
  return secretContentPatterns.some((pattern) => pattern.test(text))
    ? "secret_content"
    : null;
};
