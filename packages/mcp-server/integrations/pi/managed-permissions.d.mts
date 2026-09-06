interface ToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

interface ToolContext {
  signal?: AbortSignal;
  hasUI: boolean;
  ui: {
    select(
      title: string,
      options: string[],
      settings: { signal?: AbortSignal }
    ): Promise<string | undefined>;
  };
}

interface PermissionExtension {
  on(event: "session_start" | "session_shutdown", handler: () => void): void;
  on(
    event: "tool_call",
    handler: (
      event: ToolCall,
      context: ToolContext
    ) => Promise<{ block: boolean; reason: string } | undefined>
  ): void;
}

export default function managedPermissions(
  pi: PermissionExtension,
  environment?: NodeJS.ProcessEnv
): void;
