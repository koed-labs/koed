"use client";

export type PersonalAgentRoleTemplate = Readonly<{
  id: string;
  version: number;
  title: string;
  role: string;
  soulInstructions: string;
  contentSha256: string;
}>;

const ROLE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(back[ -]?end|server|api|service)\b/i, "backend-engineer"],
  [/\b(front[ -]?end|ui|interface|web)\b/i, "frontend-engineer"],
  [/\b(review|reviewer|audit|quality)\b/i, "code-reviewer"],
  [/\b(product|roadmap|priorit)\b/i, "product-manager"],
  [/\b(data|schema|database|analytics)\b/i, "data-architect"],
  [/\b(research|researcher|sources|evidence)\b/i, "researcher"]
];

export function rankRoleTemplates(
  role: string,
  templates: readonly PersonalAgentRoleTemplate[]
): PersonalAgentRoleTemplate[] {
  const normalized = role.trim().toLocaleLowerCase("en");
  const matchedIds = ROLE_ALIASES.filter(([pattern]) =>
    pattern.test(normalized)
  )
    .map(([, id]) => id)
    .filter((id, index, values) => values.indexOf(id) === index);
  const score = (template: PersonalAgentRoleTemplate) => {
    if (matchedIds.includes(template.id)) return 2;
    const words = `${template.title} ${template.role}`
      .toLocaleLowerCase("en")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);
    return words.some((word) => normalized.includes(word)) ? 1 : 0;
  };
  return [...templates]
    .map((template) => ({ template, score: score(template) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.template.title.localeCompare(right.template.title, "en") ||
        left.template.id.localeCompare(right.template.id, "en")
    )
    .map(({ template }) => template);
}

export function matchRoleTemplate(
  role: string,
  templates: readonly PersonalAgentRoleTemplate[]
): PersonalAgentRoleTemplate | undefined {
  const normalized = role.trim().toLocaleLowerCase("en");
  if (!normalized) return undefined;
  return templates.find(
    (template) => template.role.trim().toLocaleLowerCase("en") === normalized
  );
}

export function parsePersonalAgentRoleTemplates(
  value: unknown
): PersonalAgentRoleTemplate[] {
  if (!value || typeof value !== "object") {
    throw new Error("Role templates are unavailable.");
  }
  const records = value as Record<string, unknown>;
  if (!Array.isArray(records.templates)) {
    throw new Error("Role templates are unavailable.");
  }
  const templates: PersonalAgentRoleTemplate[] = records.templates.flatMap(
    (entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        typeof item.version !== "number" ||
        !Number.isSafeInteger(item.version) ||
        item.version < 1 ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(item.id) ||
        typeof item.title !== "string" ||
        !item.title.trim() ||
        item.title.length > 128 ||
        typeof item.role !== "string" ||
        !item.role.trim() ||
        item.role.length > 160 ||
        typeof item.soulInstructions !== "string" ||
        !item.soulInstructions.trim() ||
        item.soulInstructions.length > 65_536 ||
        typeof item.contentSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(item.contentSha256)
      ) {
        throw new Error("The role template service returned invalid data.");
      }
      return [item as PersonalAgentRoleTemplate];
    }
  );
  templates.sort(
    (left, right) =>
      left.id.localeCompare(right.id, "en") || right.version - left.version
  );
  const newest = new Map<string, PersonalAgentRoleTemplate>();
  for (const template of templates) {
    if (!newest.has(template.id)) newest.set(template.id, template);
  }
  return [...newest.values()].sort(
    (left, right) =>
      left.title.localeCompare(right.title, "en") ||
      left.id.localeCompare(right.id, "en")
  );
}

export async function listPersonalAgentRoleTemplates(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<PersonalAgentRoleTemplate[]> {
  const pathname =
    typeof window !== "undefined" ? window.location.pathname : "";
  const path =
    pathname === "/studio" || pathname.startsWith("/studio/")
      ? "/v1/personal-agent-role-templates"
      : "/studio-api/personal-agent-role-templates";
  const response = await fetchImpl(path, {
    signal,
    cache: "no-store",
    credentials: "include",
    redirect: "error",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error("Role templates are unavailable.");
  return parsePersonalAgentRoleTemplates(await response.json());
}
