import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export const CODEX_GUIDANCE_FILENAME = "codex-global-agent-guidance.md";
export const CODEX_GLOBAL_INSTRUCTIONS_FILENAME = "AGENTS.md";
export const CODEX_GUIDANCE_MARKER_START = "<!-- >>> koed-memory-guidance -->";
export const CODEX_GUIDANCE_MARKER_END = "<!-- <<< koed-memory-guidance -->";

export type CodexGuidanceState = "current" | "missing" | "stale" | "malformed";

const occurrences = (content: string, value: string): number =>
  content.split(value).length - 1;

export const renderManagedCodexGuidance = (guidance: string): string =>
  `${CODEX_GUIDANCE_MARKER_START}\n${guidance.trim()}\n${CODEX_GUIDANCE_MARKER_END}`;

export const inspectManagedCodexGuidance = (
  content: string,
  guidance: string
): CodexGuidanceState => {
  const startCount = occurrences(content, CODEX_GUIDANCE_MARKER_START);
  const endCount = occurrences(content, CODEX_GUIDANCE_MARKER_END);
  if (startCount === 0 && endCount === 0) return "missing";
  if (startCount !== 1 || endCount !== 1) return "malformed";

  const start = content.indexOf(CODEX_GUIDANCE_MARKER_START);
  const end = content.indexOf(CODEX_GUIDANCE_MARKER_END, start);
  if (end < start) return "malformed";
  const actual = content.slice(start, end + CODEX_GUIDANCE_MARKER_END.length);
  return actual === renderManagedCodexGuidance(guidance) ? "current" : "stale";
};

export const reconcileManagedCodexGuidance = (
  content: string,
  guidance: string
): string => {
  const state = inspectManagedCodexGuidance(content, guidance);
  if (state === "malformed") {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }
  if (state === "current") return content;

  const managed = renderManagedCodexGuidance(guidance);
  if (state === "missing") {
    return `${content}${content ? "\n\n" : ""}${managed}\n`;
  }

  const start = content.indexOf(CODEX_GUIDANCE_MARKER_START);
  const end =
    content.indexOf(CODEX_GUIDANCE_MARKER_END, start) +
    CODEX_GUIDANCE_MARKER_END.length;
  return `${content.slice(0, start)}${managed}${content.slice(end)}`;
};

export const removeManagedCodexGuidance = (content: string): string => {
  const startCount = occurrences(content, CODEX_GUIDANCE_MARKER_START);
  const endCount = occurrences(content, CODEX_GUIDANCE_MARKER_END);
  if (startCount === 0 && endCount === 0) return content;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }

  const start = content.indexOf(CODEX_GUIDANCE_MARKER_START);
  const markerEnd = content.indexOf(CODEX_GUIDANCE_MARKER_END, start);
  if (markerEnd < start) {
    throw new Error(
      "Codex global AGENTS.md contains malformed Koed guidance markers. Repair or remove the Koed-managed marker block, then retry."
    );
  }
  const end = markerEnd + CODEX_GUIDANCE_MARKER_END.length;
  const ownedStart =
    start >= 2 && content.slice(start - 2, start) === "\n\n"
      ? start - 2
      : start;
  const ownedEnd = content[end] === "\n" ? end + 1 : end;
  return `${content.slice(0, ownedStart)}${content.slice(ownedEnd)}`;
};

export const resolveCodexHome = (environment: NodeJS.ProcessEnv): string => {
  if (environment.CODEX_HOME?.trim()) {
    return resolve(environment.CODEX_HOME.trim());
  }
  if (environment.CODEX_CONFIG_PATH?.trim()) {
    return dirname(resolve(environment.CODEX_CONFIG_PATH.trim()));
  }
  return resolve(environment.HOME?.trim() || homedir(), ".codex");
};

export const resolveCodexGlobalInstructionsPath = (
  environment: NodeJS.ProcessEnv
): string =>
  resolve(resolveCodexHome(environment), CODEX_GLOBAL_INSTRUCTIONS_FILENAME);

export const resolveCodexGuidancePath = (mcpCliPath: string): string =>
  resolve(dirname(mcpCliPath), "prompts", CODEX_GUIDANCE_FILENAME);
