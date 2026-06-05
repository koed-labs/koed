import type { SearchDomain } from "./types";

export type MemoryScopeCommandName = "/global" | "/project" | "/session";

export type MemoryScopeCommand = {
  command: MemoryScopeCommandName;
  endIndex: number;
  searchDomain: SearchDomain;
  startIndex: number;
};

const memoryScopeCommandPattern = /(^|\s)\/(session|project|global)(?=\s|$)/gi;

const commandDomains = {
  global: "global",
  project: "project",
  session: "session"
} as const satisfies Record<string, SearchDomain>;

function isMemoryScopeCommandText(
  value: string
): value is keyof typeof commandDomains {
  return value in commandDomains;
}

export function parseMemoryScopeCommand(
  input: string
): MemoryScopeCommand | null {
  const matches = input.matchAll(memoryScopeCommandPattern);
  for (const match of matches) {
    const prefix = match[1] ?? "";
    const commandText = match[2]?.toLowerCase();
    if (!commandText || !isMemoryScopeCommandText(commandText)) {
      continue;
    }
    const startIndex = match.index + prefix.length;
    return {
      command: `/${commandText}` as MemoryScopeCommandName,
      endIndex: startIndex + commandText.length + 1,
      searchDomain: commandDomains[commandText],
      startIndex
    };
  }
  return null;
}

export function stripMemoryScopeCommands(input: string) {
  return input
    .replace(memoryScopeCommandPattern, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
