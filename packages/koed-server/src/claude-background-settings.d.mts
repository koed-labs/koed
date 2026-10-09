export declare const CLAUDE_BACKGROUND_THRESHOLD: string;
export interface ClaudeBackgroundJournalSnapshot {
  path: string;
  content: string | null;
}
export interface ClaudeBackgroundRecallStatus {
  state: "configured" | "preserved" | "disabled" | "environment_override";
  thresholdMs?: unknown;
  scope: "all_mcp_calls";
  message: string;
}
export declare function captureClaudeBackgroundJournal(
  koedHome: string
): ClaudeBackgroundJournalSnapshot;
export declare function writeClaudeBackgroundJournal(
  snapshot: ClaudeBackgroundJournalSnapshot,
  content: string | null
): void;
export declare function configureClaudeBackgroundRecall(
  settings: Record<string, unknown>,
  environment: Record<string, string | undefined>,
  settingsPath: string,
  snapshot: ClaudeBackgroundJournalSnapshot
): { report: ClaudeBackgroundRecallStatus; journal: string | null };
export declare function removeClaudeBackgroundRecall(
  settings: Record<string, unknown>,
  settingsPath: string,
  snapshot: ClaudeBackgroundJournalSnapshot
): { journal: string | null };

export declare function writeClaudeSettingsFileAtomic(
  path: string,
  content: string
): void;
