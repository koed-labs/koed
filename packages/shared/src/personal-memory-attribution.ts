export const PERSONAL_MEMORY_ATTRIBUTION_FOOTER_PREFIX =
  "<!-- koed-memory-attribution:v1:";

export type PersonalMemoryAttributionFooter = {
  used: boolean;
  citationNodeIds: string[];
};

export type ParsedPersonalMemoryAttributionFooter = {
  text: string;
  attribution: PersonalMemoryAttributionFooter | null;
  recognizedFooter: boolean;
};

const footerLinePattern =
  /^<!-- koed-memory-attribution:v1:([0-9a-f-]{36}):([0-9a-f-]{36}):(.+) -->\s*$/iu;

const parsePayload = (
  value: unknown
): PersonalMemoryAttributionFooter | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "citationNodeIds,used" ||
    typeof record.used !== "boolean" ||
    !Array.isArray(record.citationNodeIds) ||
    record.citationNodeIds.length > 5 ||
    record.citationNodeIds.some(
      (id) => typeof id !== "string" || id.length < 1 || id.length > 512
    ) ||
    new Set(record.citationNodeIds).size !== record.citationNodeIds.length ||
    (!record.used && record.citationNodeIds.length > 0)
  ) {
    return null;
  }
  return {
    used: record.used,
    citationNodeIds: record.citationNodeIds as string[]
  };
};

const decodePayload = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Hide a footer or partial footer while assistant output is streaming. */
export const stripPersonalMemoryAttributionFooter = (
  value: string,
  options: { mode?: "stream" | "final" } = {}
): string => {
  const markerIndex = value
    .toLowerCase()
    .indexOf(PERSONAL_MEMORY_ATTRIBUTION_FOOTER_PREFIX.toLowerCase());
  if (markerIndex >= 0) return value.slice(0, markerIndex).trimEnd();

  const lastLineStart = value.lastIndexOf("\n") + 1;
  const lastLine = value.slice(lastLineStart);
  const trimmed = lastLine.trimStart();
  const minimumPartialLength =
    options.mode === "final" ? "<!-- koed".length : 1;
  if (
    trimmed.length >= minimumPartialLength &&
    PERSONAL_MEMORY_ATTRIBUTION_FOOTER_PREFIX.toLowerCase().startsWith(
      trimmed.toLowerCase()
    )
  ) {
    return value.slice(0, lastLineStart).trimEnd();
  }
  return value;
};

/** Parse only a footer bound to this exact encrypted command and nonce. */
export const parsePersonalMemoryAttributionFooter = (
  value: string,
  expected: { commandId: string; nonce: string }
): ParsedPersonalMemoryAttributionFooter => {
  const visibleText = stripPersonalMemoryAttributionFooter(value, {
    mode: "final"
  });
  const lastLineStart = value.lastIndexOf("\n") + 1;
  const lastLine = value.slice(lastLineStart).trim();
  const match = footerLinePattern.exec(lastLine);
  const markerCount =
    value
      .toLowerCase()
      .split(PERSONAL_MEMORY_ATTRIBUTION_FOOTER_PREFIX.toLowerCase()).length -
    1;
  if (!match) {
    return {
      text: visibleText,
      attribution: null,
      recognizedFooter:
        value
          .toLowerCase()
          .includes(PERSONAL_MEMORY_ATTRIBUTION_FOOTER_PREFIX.toLowerCase()) ||
        visibleText.length !== value.length
    };
  }
  const payload = parsePayload(decodePayload(match[3]!));
  const validBinding =
    markerCount === 1 &&
    match[1]!.toLowerCase() === expected.commandId.toLowerCase() &&
    match[2]!.toLowerCase() === expected.nonce.toLowerCase();
  return {
    text: visibleText,
    attribution: validBinding ? payload : null,
    recognizedFooter: true
  };
};

/** Encode a structured attribution as a non-rendered terminal marker. */
export const personalMemoryAttributionFooter = (input: {
  commandId: string;
  nonce: string;
  attribution: PersonalMemoryAttributionFooter;
}): string => {
  const payload = parsePayload(input.attribution);
  if (!payload) throw new TypeError("Personal Memory attribution is invalid");
  return `${PERSONAL_MEMORY_ATTRIBUTION_FOOTER_PREFIX}${input.commandId}:${input.nonce}:${JSON.stringify(payload)} -->`;
};
