export interface ClaudeMcpEntry {
  command: string;
  args: string[];
  environment: Array<[string, string]>;
}
export declare function parseClaudeOwnedMcpEntry(
  output: string,
  expectedMcpCli: string,
  expectedKoedHome: string
): ClaudeMcpEntry | null;
