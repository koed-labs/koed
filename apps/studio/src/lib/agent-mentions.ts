export type MentionCandidate = Readonly<{
  id: string;
  name: string;
  mentionToken?: string;
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
  const prefix = maskUnaddressableText(text).slice(0, cursor);
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(prefix);
  if (!match) return null;
  const at = prefix.lastIndexOf("@");
  return { query: match[1], start: at, end: cursor };
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, "_");
}

export function canonicalAgentMentionToken(name: string, id: string): string {
  const readable = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const suffix = id
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(-8);
  return `${readable || "agent"}_${suffix || "selected"}`;
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
          normalizedName(agent.name).startsWith(normalizedQuery) ||
          normalizedName(agent.mentionToken ?? agent.name).startsWith(
            normalizedQuery
          ))
    )
    .slice()
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
}

function maskUnaddressableText(text: string): string {
  const chars = text.split("");
  const lines = text.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let offset = 0;
  let fence: { marker: "`" | "~"; size: number } | null = null;
  for (const line of lines) {
    if (!line) continue;
    const body = line.replace(/\n$/u, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(body);
    const isFenceLine = fence
      ? new RegExp(
          `^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.size},}\\s*$`,
          "u"
        ).test(body)
      : Boolean(fenceMatch);
    const isBlockQuote = !fence && /^ {0,3}>/u.test(body);
    if (isFenceLine || fence || isBlockQuote) {
      for (let index = offset; index < offset + line.length; index += 1) {
        if (chars[index] !== "\n") chars[index] = " ";
      }
    }
    if (!fence && fenceMatch) {
      fence = {
        marker: fenceMatch[1]![0] as "`" | "~",
        size: fenceMatch[1]!.length
      };
    } else if (fence && isFenceLine) {
      fence = null;
    }
    offset += line.length;
  }

  const isQuoteOpeningContext = (index: number) => {
    const previous = text[index - 1];
    return (
      previous === undefined ||
      /\s/u.test(previous) ||
      "([{<:=,;!?—–-".includes(previous)
    );
  };
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === "\n" || chars[index] === " ") continue;
    if (chars[index] === "`") {
      let size = 1;
      while (chars[index + size] === "`") size += 1;
      let close = index + size;
      let found = false;
      while (close < chars.length) {
        if (chars[close] !== "`") {
          close += 1;
          continue;
        }
        let closeSize = 1;
        while (chars[close + closeSize] === "`") closeSize += 1;
        if (closeSize === size) {
          for (let cursor = index; cursor < close + size; cursor += 1) {
            if (chars[cursor] !== "\n") chars[cursor] = " ";
          }
          index = close + size - 1;
          found = true;
          break;
        }
        close += closeSize;
      }
      if (!found) {
        for (let cursor = index; cursor < chars.length; cursor += 1) {
          if (chars[cursor] !== "\n") chars[cursor] = " ";
        }
        break;
      }
      continue;
    }
    const quotePairs: Record<string, string> = {
      '"': '"',
      "'": "'",
      "“": "”",
      "‘": "’"
    };
    const closingQuote = quotePairs[chars[index]!];
    if (!closingQuote || !isQuoteOpeningContext(index)) continue;
    let close = index + 1;
    let found = false;
    while (close < chars.length) {
      if (chars[close] === "\\") {
        close += 2;
        continue;
      }
      if (
        closingQuote === "'" &&
        /[\p{L}\p{N}]/u.test(chars[close - 1] ?? "") &&
        /[\p{L}\p{N}]/u.test(chars[close + 1] ?? "")
      ) {
        close += 1;
        continue;
      }
      if (chars[close] === closingQuote) {
        found = true;
        break;
      }
      close += 1;
    }
    if (!found) {
      for (let cursor = index; cursor < chars.length; cursor += 1) {
        if (chars[cursor] !== "\n") chars[cursor] = " ";
      }
      break;
    }
    for (let cursor = index; cursor <= close; cursor += 1) {
      if (chars[cursor] !== "\n") chars[cursor] = " ";
    }
    index = close;
  }
  return chars.join("");
}

function unquotedMentionNames(text: string): string[] {
  const mentionable = maskUnaddressableText(text);
  return Array.from(
    mentionable.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu),
    (match) => match[1]
  );
}

/** Return stable identities in the order they appear in the current draft. */
export function resolvedAgentMentionIds(
  text: string,
  agents: readonly MentionCandidate[],
  resolvedByToken: Readonly<Record<string, string>>
): string[] {
  const activeIds = new Set(
    agents
      .filter((agent) => agent.lifecycle === "active")
      .map((agent) => agent.id)
  );
  const result: string[] = [];
  const seen = new Set<string>();
  for (const name of unquotedMentionNames(text)) {
    const id = resolvedByToken[normalizedName(name)];
    if (
      !id ||
      !activeIds.has(id) ||
      seen.has(id) ||
      !agents.some(
        (agent) =>
          agent.id === id &&
          normalizedName(agent.mentionToken ?? agent.name) ===
            normalizedName(name)
      )
    )
      continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function unresolvedAgentMentions(
  text: string,
  agents: readonly MentionCandidate[]
): MentionIssue[] {
  const issues: MentionIssue[] = [];
  for (const name of unquotedMentionNames(text)) {
    const matching = agents.filter(
      (agent) =>
        normalizedName(agent.name) === normalizedName(name) ||
        normalizedName(agent.mentionToken ?? agent.name) ===
          normalizedName(name)
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
