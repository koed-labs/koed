export interface SecretSpan {
  start: number;
  end: number;
}

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,255}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?([^\s"']{8,})/gi
] as const;

export const detectDeterministicSecrets = (text: string): SecretSpan[] => {
  const spans: SecretSpan[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const whole = match[0];
      const captured = match[1];
      const relativeStart = captured ? whole.lastIndexOf(captured) : 0;
      const start = (match.index ?? 0) + relativeStart;
      spans.push({ start, end: start + (captured ?? whole).length });
    }
  }
  return spans.sort(
    (left, right) => left.start - right.start || right.end - left.end
  );
};
