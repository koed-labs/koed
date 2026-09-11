export declare const callLocalRuntimeTool: (input: {
  koedHome: string;
  name: string;
  input: Record<string, unknown>;
  context: { cwd: string };
  signal?: AbortSignal;
  invocationKey: string;
}) => Promise<Record<string, unknown>>;
