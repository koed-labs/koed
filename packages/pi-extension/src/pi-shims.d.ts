declare module "@earendil-works/pi-ai" {
  export const Type: {
    Union(...args: unknown[]): unknown;
    Literal(value: string): unknown;
    Object(shape: Record<string, unknown>): unknown;
    String(options?: Record<string, unknown>): unknown;
    Optional(value: unknown): unknown;
    Number(options?: Record<string, unknown>): unknown;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    appendEntry(customType: string, data?: unknown): void;
    registerTool(tool: unknown): void;
    on(event: string, handler: (...args: any[]) => unknown): void;
  }

  export function defineTool(tool: {
    [key: string]: any;
    execute?: (...args: any[]) => any;
  }): any;

  export const createExtensionRuntime: () => unknown;
  export const getAgentDir: () => string;
  export const createAgentSession: (
    input: Record<string, unknown>
  ) => Promise<{
    session: {
      prompt(prompt: string): Promise<void>;
      abort(): Promise<void>;
      dispose(): void;
      messages: unknown[];
    };
  }>;

  export const AuthStorage: any;
  export const ModelRegistry: any;
  export const SessionManager: any;
  export const SettingsManager: any;
}
