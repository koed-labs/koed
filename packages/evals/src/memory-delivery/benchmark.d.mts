export type DeliveryScenario =
  | "delayed"
  | "fast"
  | "not_found"
  | "failed"
  | "interrupted"
  | "blocking"
  | "fallback";
export interface DeliveryEvent {
  kind: string;
  at: number;
  mode?: string;
  outcome?: string;
  status?: string;
  route?: string;
  target?: string;
}
export interface ImportSettings {
  retryDelayMs: number;
  cacheAuthorization: boolean;
}
export type ClaudeDeliveryScenario =
  | "background_enabled"
  | "background_disabled"
  | "blocking_background"
  | "fast"
  | "not_found"
  | "failed"
  | "interrupted"
  | "ambiguous";
export declare const deliveryScenarios: readonly DeliveryScenario[];
export declare const claudeDeliveryScenarios: readonly ClaudeDeliveryScenario[];
export declare function scoreDeliveryRun(input: {
  scenario: DeliveryScenario;
  events: DeliveryEvent[];
  expectedSettings: ImportSettings;
  actualSettings: ImportSettings | null;
  exitCode: number | null;
  host?: "codex" | "pi" | "claude";
}): { passed: boolean; checks: Record<string, boolean> };
export declare function scoreClaudeDeliveryRun(input: {
  scenario: ClaudeDeliveryScenario;
  events: DeliveryEvent[];
  expectedSettings: ImportSettings;
  actualSettings: ImportSettings | null;
  exitCode: number | null;
  executions: number;
  interrupted: boolean;
  waiterDetached: boolean;
}): { passed: boolean; checks: Record<string, boolean> };
export declare function scoreAttributedDeliveryRun(input: {
  scenario: "mixed" | "concurrent";
  events: DeliveryEvent[];
  expectedSettings: Record<string, ImportSettings>;
  actualSettings: Record<string, ImportSettings>;
}): { passed: boolean; checks: Record<string, boolean> };
