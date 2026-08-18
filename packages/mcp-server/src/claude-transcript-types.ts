export interface ClaudeWatcherState {
  version: 2;
  activatedAt: string;
  cursors: Record<string, { messageCount: number; updatedAt: string }>;
}
