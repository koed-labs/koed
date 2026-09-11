export interface KoedPiToolContext {
  cwd: string;
}

export declare const callTool: (
  name: string,
  input: Record<string, unknown>,
  context: KoedPiToolContext,
  signal: AbortSignal | undefined,
  invocationKey: string
) => Promise<Record<string, unknown>>;

export default function koedExtension(pi: unknown): void;
