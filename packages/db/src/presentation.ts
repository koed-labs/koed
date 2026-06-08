import { splitCodexIdePrompt } from "@koed/core";
import {
  isRecord,
  looksLikeToolPayloadText,
  normalizeDisplayText,
  truncateDisplayText
} from "./value-helpers.js";

export const clusterIdForLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "general";

const getStringField = (
  value: Record<string, unknown>,
  key: string
): string | null => {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const projectDisplayName = (row: {
  project_name: string | null;
  project_path: string | null;
}): string => {
  const candidate = row.project_name ?? row.project_path;
  if (!candidate) {
    return "this project";
  }
  const parts = candidate.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? candidate;
};

const developmentActivityText = (row: {
  project_name: string | null;
  project_path: string | null;
}): string => `Development activity captured in ${projectDisplayName(row)}.`;

export const isGenericDevelopmentActivity = (
  text: string,
  row: { project_name: string | null; project_path: string | null }
): boolean => text === developmentActivityText(row);

const extractReadableJsonText = (
  parsed: Record<string, unknown>,
  row: { project_name: string | null; project_path: string | null }
): string | null => {
  if (isRecord(parsed.toolInput) || isRecord(parsed.toolResponse)) {
    return developmentActivityText(row);
  }
  if (getStringField(parsed, "command")) {
    return developmentActivityText(row);
  }
  const directText =
    getStringField(parsed, "summaryText") ??
    getStringField(parsed, "summary") ??
    getStringField(parsed, "text") ??
    getStringField(parsed, "content");
  if (directText) {
    return directText;
  }
  return null;
};

const extractLcmSourceCandidate = (value: string): string | null => {
  const lines = value.split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\[[^\]]+\]\s*[^:]*:\s*(.+)$/);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      return candidate;
    }
  }
  return null;
};

const isInternalMemorySummary = (value: string): boolean =>
  /^\s*LCM depth \d+/.test(value) ||
  value.includes("Exact ordered source outline:") ||
  value.includes("Child summaries:");

const CODEX_REQUEST_HEADER = /^#{0,6}\s*My request for Codex:\s*$/gim;
const IMAGE_TAG = /<image\b[\s\S]*?<\/image>/gi;

const extractCodexRequestText = (value: string): string | null => {
  const split = splitCodexIdePrompt(value);
  if (split) {
    return split.userPrompt;
  }
  const markers = [...value.matchAll(CODEX_REQUEST_HEADER)];
  const marker = markers.at(-1);
  if (!marker || marker.index === undefined) {
    return null;
  }
  const requestText = value
    .slice(marker.index + marker[0].length)
    .replace(IMAGE_TAG, "")
    .trim();
  return requestText;
};

export const presentMemoryText = (
  summaryText: string,
  row: { project_name: string | null; project_path: string | null }
): string => {
  const normalized = normalizeDisplayText(summaryText);
  if (!normalized) {
    return "Captured memory.";
  }
  if (looksLikeToolPayloadText(normalized)) {
    return developmentActivityText(row);
  }

  const parsed = parseJsonObject(summaryText);
  if (parsed) {
    const readable = extractReadableJsonText(parsed, row);
    return readable
      ? presentMemoryText(readable, row)
      : developmentActivityText(row);
  }

  if (isInternalMemorySummary(summaryText)) {
    const candidate = extractLcmSourceCandidate(summaryText);
    return candidate
      ? presentMemoryText(candidate, row)
      : developmentActivityText(row);
  }

  const requestText = extractCodexRequestText(summaryText);
  if (requestText !== null) {
    return presentMemoryText(requestText, row);
  }

  return truncateDisplayText(summaryText);
};
