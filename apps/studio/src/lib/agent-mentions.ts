export type MentionCandidate = Readonly<{
  id: string;
  name: string;
  lifecycle: "active" | "retired";
}>;

export type MentionQuery = Readonly<{
  query: string;
  start: number;
  end: number;
}>;

export type MentionIssue = Readonly<{
  name: string;
  kind: "unknown" | "retired" | "ambiguous" | "unselected";
  candidateIds: readonly string[];
}>;

export function mentionQueryAtCursor(
  text: string,
  cursor: number
): MentionQuery | null {
  const prefix = text.slice(0, cursor);
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(prefix);
  if (!match) return null;
  const at = prefix.lastIndexOf("@");
  return { query: match[1], start: at, end: cursor };
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, "_");
}

export function matchMentionCandidates<T extends MentionCandidate>(
  query: string,
  agents: readonly T[]
): T[] {
  const normalizedQuery = normalizedName(query);
  return agents
    .filter(
      (agent) =>
        agent.lifecycle === "active" &&
        (!normalizedQuery ||
          normalizedName(agent.name).startsWith(normalizedQuery))
    )
    .slice()
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
}

function unquotedMentionNames(text: string): string[] {
  const withoutQuotedText = text.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    " "
  );
  return Array.from(
    withoutQuotedText.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu),
    (match) => match[1]
  );
}

export function unresolvedAgentMentions(
  text: string,
  agents: readonly MentionCandidate[]
): MentionIssue[] {
  const issues: MentionIssue[] = [];
  for (const name of unquotedMentionNames(text)) {
    const matching = agents.filter(
      (agent) => normalizedName(agent.name) === normalizedName(name)
    );
    const active = matching.filter((agent) => agent.lifecycle === "active");
    if (active.length > 1) {
      issues.push({
        name,
        kind: "ambiguous",
        candidateIds: active.map((agent) => agent.id)
      });
    } else if (active.length === 1) {
      issues.push({
        name,
        kind: "unselected",
        candidateIds: active.map((agent) => agent.id)
      });
    } else if (matching.length > 0) {
      issues.push({
        name,
        kind: "retired",
        candidateIds: matching.map((agent) => agent.id)
      });
    } else if (active.length === 0) {
      issues.push({ name, kind: "unknown", candidateIds: [] });
    }
  }
  return issues;
}
