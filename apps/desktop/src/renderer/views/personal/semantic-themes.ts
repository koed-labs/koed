import type {
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";

export type ThemeSource = {
  kind: "generated_title" | "narrative";
  text: string;
};

type RankedTheme = {
  display: string;
  documentCount: number;
  key: string;
  score: number;
  tokens: string[];
};

const stopWords = new Set([
  "about",
  "able",
  "after",
  "affect",
  "again",
  "also",
  "and",
  "another",
  "around",
  "as",
  "app",
  "apps",
  "assistant",
  "await",
  "before",
  "been",
  "being",
  "both",
  "but",
  "call",
  "can",
  "captured",
  "change",
  "changes",
  "conversation",
  "completed",
  "comments",
  "consider",
  "cause",
  "could",
  "current",
  "create",
  "does",
  "deduplicated",
  "each",
  "event",
  "events",
  "feature",
  "first",
  "for",
  "from",
  "get",
  "give",
  "had",
  "have",
  "head",
  "info",
  "inspect",
  "into",
  "in",
  "just",
  "like",
  "make",
  "me",
  "memory",
  "more",
  "most",
  "move",
  "not",
  "of",
  "on",
  "only",
  "open",
  "origin",
  "other",
  "our",
  "output",
  "over",
  "please",
  "project",
  "processing",
  "promise.all",
  "requested",
  "run",
  "running",
  "runs",
  "session",
  "show",
  "short",
  "should",
  "some",
  "status",
  "than",
  "that",
  "the",
  "themed",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "to",
  "tool",
  "traditional",
  "under",
  "update",
  "using",
  "very",
  "was",
  "well",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "locally",
  "your"
]);

const genericSourcePatterns = [
  /^open the conversation to review this captured session\.?$/i,
  /^captured session$/i,
  /^untitled session$/i
];

const sourceWeight = (kind: ThemeSource["kind"]): number =>
  kind === "narrative" ? 3 : 1;

const sanitize = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:^|\s)(?:~|\.{0,2})?\/[\w.@+~/-]+/g, " ")
    .replace(/\b(?:[\w.@+~-]+\/)+[\w.@+~-]+\b/g, " ")
    .replace(/[A-Za-z]:\\[^\s]+/g, " ")
    .replace(/\{[^{}]{0,500}\}/g, " ")
    .replace(/--[\w-]+(?:=[^\s]+)?/g, " ");

const rawTokens = (value: string): string[] =>
  sanitize(value).match(/[\p{L}][\p{L}\p{N}.+#]*/gu) ?? [];

const normalizeToken = (token: string): string =>
  token.replace(/^\.+|\.+$/g, "").toLocaleLowerCase();

const machineShaped = (token: string): boolean => {
  const normalized = normalizeToken(token);
  const uppercaseCount = [...token].filter((character) =>
    /\p{Lu}/u.test(character)
  ).length;
  return (
    normalized.length < 2 ||
    stopWords.has(normalized) ||
    /^[0-9a-f]{7,}$/i.test(normalized) ||
    /^\d+$/.test(normalized) ||
    /\.(?:js|jsx|ts|tsx|json|md|sql|css|html|log|txt|yml|yaml)$/i.test(
      normalized
    ) ||
    (normalized.length >= 16 && uppercaseCount >= 4) ||
    (normalized.length > 32 && !normalized.includes("+"))
  );
};

const identityTokens = (values: readonly string[]): Set<string> =>
  new Set(
    values.flatMap((value) =>
      value
        .normalize("NFKC")
        .split(/[\\/._\-\s]+/)
        .map(normalizeToken)
        .filter(Boolean)
    )
  );

const titleCaseCandidate = (tokens: readonly string[]): string =>
  tokens
    .map((token) => {
      if (/^[A-Z0-9+#.]{2,}$/.test(token)) return token;
      return token;
    })
    .join(" ");

const candidateRuns = (
  source: ThemeSource,
  exclusions: ReadonlySet<string>
): string[][] => {
  if (
    genericSourcePatterns.some((pattern) => pattern.test(source.text.trim()))
  ) {
    return [];
  }
  const runs: string[][] = [];
  for (const segment of sanitize(source.text).split(/[\n!?;:—–]+|\.(?:\s|$)/)) {
    let run: string[] = [];
    for (const token of rawTokens(segment)) {
      const normalized = normalizeToken(token);
      if (machineShaped(token) || exclusions.has(normalized)) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(token);
      }
    }
    if (run.length) runs.push(run);
  }
  return runs;
};

export const rankThemes = ({
  exclusions = [],
  limit = 5,
  sources
}: {
  exclusions?: readonly string[];
  limit?: number;
  sources: readonly ThemeSource[];
}): string[] => {
  const excludedTokens = identityTokens(exclusions);
  const candidates = new Map<string, RankedTheme>();

  sources.forEach((source) => {
    const seenInDocument = new Set<string>();
    const weight = sourceWeight(source.kind);
    const add = (candidateTokens: string[], phraseMultiplier: number) => {
      const normalizedTokens = candidateTokens.map(normalizeToken);
      const key = normalizedTokens.join(" ");
      if (!key) return;
      const current = candidates.get(key);
      const firstInDocument = !seenInDocument.has(key);
      seenInDocument.add(key);
      candidates.set(key, {
        display: current?.display ?? titleCaseCandidate(candidateTokens),
        documentCount:
          (current?.documentCount ?? 0) + (firstInDocument ? 1 : 0),
        key,
        score:
          (current?.score ?? 0) +
          weight * phraseMultiplier * (firstInDocument ? 1 : 0.35),
        tokens: normalizedTokens
      });
    };

    for (const run of candidateRuns(source, excludedTokens)) {
      run.forEach((token) => add([token], 1));
      for (let index = 0; index < run.length - 1; index += 1) {
        add(run.slice(index, index + 2), 1.75);
      }
    }
  });

  const ranked = [...candidates.values()].sort(
    (left, right) =>
      right.documentCount - left.documentCount ||
      right.score - left.score ||
      left.key.localeCompare(right.key)
  );
  const selected: RankedTheme[] = [];
  for (const candidate of ranked) {
    if (
      selected.some((existing) =>
        candidate.tokens.some((token) => existing.tokens.includes(token))
      )
    ) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected.map(({ display }) => display);
};

const projectIdentity = (project: PersonalDesktopProject): string[] => [
  project.id,
  project.name,
  project.path ?? ""
];

export const sessionThemes = (
  project: PersonalDesktopProject,
  thread: PersonalDesktopProjectThread,
  limit = 5
): string[] =>
  rankThemes({
    exclusions: [
      ...projectIdentity(project),
      thread.projectId,
      thread.projectPath ?? ""
    ],
    limit,
    sources: [
      { kind: "generated_title", text: thread.name },
      { kind: "narrative", text: thread.sample }
    ]
  });

export const projectThemes = (
  project: PersonalDesktopProject,
  limit = 5
): string[] => {
  const aggregate = new Map<
    string,
    { display: string; score: number; sessions: number }
  >();
  for (const thread of project.threads) {
    sessionThemes(project, thread, 8).forEach((theme, index) => {
      const key = theme.toLocaleLowerCase();
      const current = aggregate.get(key);
      aggregate.set(key, {
        display: current?.display ?? theme,
        score: (current?.score ?? 0) + 8 - index,
        sessions: (current?.sessions ?? 0) + 1
      });
    });
  }
  return [...aggregate.values()]
    .sort(
      (left, right) =>
        right.sessions - left.sessions ||
        right.score - left.score ||
        left.display.localeCompare(right.display)
    )
    .slice(0, limit)
    .map(({ display }) => display);
};
