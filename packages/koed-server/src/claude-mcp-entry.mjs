import { resolve } from "node:path";

/**
 * @typedef {{command: string, args: string[], environment: Array<[string, string]>}} ClaudeMcpEntry
 */
/**
 * Claude 2.1.267 displays argv by joining it with spaces. Splitting that display
 * cannot recover quoted/spaced values. Only the supported Koed configuration's
 * single CLI argument is unambiguous; reject custom argv before any mutation.
 * Environment values are literal display bytes, never shell-evaluated/unquoted.
 * @param {string} output
 * @param {string} expectedMcpCli
 * @param {string} expectedKoedHome
 * @returns {ClaudeMcpEntry | null}
 */
export function parseClaudeOwnedMcpEntry(
  output,
  expectedMcpCli,
  expectedKoedHome
) {
  const args = output.match(/^\s*Args:\s+(.+)$/m)?.[1]?.replace(/\r$/, "");
  const command = output.match(/^[ \t]*Command:[ \t]*([^\r\n]*)\r?$/m)?.[1];
  if (!command?.trim() || !args || resolve(args) !== resolve(expectedMcpCli))
    return null;
  const environment = [
    ...output.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/gm)
  ].map(([, name, value]) => [name, value.replace(/\r$/, "")]);
  if (new Set(environment.map(([name]) => name)).size !== environment.length)
    return null;
  const koedHome = environment.find(([name]) => name === "KOED_HOME")?.[1];
  if (!koedHome || resolve(koedHome) !== resolve(expectedKoedHome)) return null;
  return { command, args: [args], environment };
}
