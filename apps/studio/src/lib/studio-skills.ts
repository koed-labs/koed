import { createId } from "./id";

export type StudioSkillScope = "personal" | "system" | "koed";
export type StudioSkillIcon =
  | "terminal"
  | "browser"
  | "game"
  | "web"
  | "shield"
  | "image"
  | "docs"
  | "playwright"
  | "team"
  | "memory";

export type StudioSkillCatalogEntry = {
  id: string;
  title: string;
  description: string;
  icon: StudioSkillIcon;
};

export type StudioSkillPreview = {
  id: string;
  title: string;
  description: string;
  source: "catalog" | "custom" | "folder";
  path?: string;
};

export const STUDIO_SKILL_PREVIEW_STORAGE_KEY = "koed:studio:skill-previews:v1";

export const STUDIO_SKILL_CATALOG: Record<
  StudioSkillScope,
  StudioSkillCatalogEntry[]
> = {
  personal: [
    {
      id: "chrome-devtools",
      title: "Chrome DevTools",
      description: "Use Chrome DevTools for debugging and inspection",
      icon: "browser"
    },
    {
      id: "develop-web-game",
      title: "Develop Web Game",
      description: "Build web games with a Playwright test loop",
      icon: "game"
    },
    {
      id: "frontend-skill",
      title: "Frontend Skill",
      description: "Design visually strong websites, apps, and demos",
      icon: "web"
    },
    {
      id: "gacha-design-review",
      title: "Gacha Design Review",
      description: "Assess gacha risk and safer game design patterns",
      icon: "shield"
    },
    {
      id: "imagegen",
      title: "Image Gen",
      description: "Generate or edit images for product surfaces",
      icon: "image"
    },
    {
      id: "openai-docs",
      title: "OpenAI Docs",
      description: "Reference official OpenAI developer documentation",
      icon: "docs"
    },
    {
      id: "playwright-cli",
      title: "Playwright CLI Skill",
      description: "Drive a real browser from the terminal with Playwright",
      icon: "playwright"
    },
    {
      id: "ralphing-setup",
      title: "Ralphing Setup",
      description: "Create a human-in-the-loop checklist workflow",
      icon: "terminal"
    }
  ],
  system: [
    {
      id: "playwright-cli",
      title: "Playwright CLI Skill",
      description: "Drive a real browser from the terminal with Playwright",
      icon: "playwright"
    },
    {
      id: "screenshot",
      title: "Screenshot",
      description: "Capture a desktop, window, or pixel region",
      icon: "image"
    },
    {
      id: "security-best-practices",
      title: "Security Best Practices",
      description: "Review supported code for secure-by-default patterns",
      icon: "shield"
    },
    {
      id: "ralphing-setup",
      title: "Ralphing Setup",
      description: "Create a human-in-the-loop checklist workflow",
      icon: "terminal"
    }
  ],
  koed: [
    {
      id: "koed-team-fixture-testing",
      title: "Koed Team Fixture Testing",
      description:
        "Validate Team Workspace flows against deterministic fixtures",
      icon: "team"
    },
    {
      id: "koed-memory",
      title: "Koed Memory",
      description: "Recall project, task, and review context from Koed Memory",
      icon: "memory"
    },
    {
      id: "openai-docs",
      title: "OpenAI Docs",
      description: "Reference official OpenAI developer documentation",
      icon: "docs"
    }
  ]
};

export function parseStudioSkillPreviews(
  raw: string | null
): StudioSkillPreview[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StudioSkillPreview => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Partial<StudioSkillPreview>;
      return (
        typeof value.id === "string" &&
        typeof value.title === "string" &&
        typeof value.description === "string" &&
        (value.source === "catalog" ||
          value.source === "custom" ||
          value.source === "folder") &&
        (value.path === undefined || typeof value.path === "string")
      );
    });
  } catch {
    return [];
  }
}

export function filterStudioSkillCatalog(
  catalog: StudioSkillCatalogEntry[],
  query: string
): StudioSkillCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return catalog;
  return catalog.filter(
    (skill) =>
      skill.title.toLowerCase().includes(normalized) ||
      skill.description.toLowerCase().includes(normalized)
  );
}

export function hasStudioSkillName(
  skills: Array<{ title: string }>,
  name: string
): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return (
    normalized.length > 0 &&
    skills.some(
      (skill) => skill.title.trim().toLocaleLowerCase() === normalized
    )
  );
}

export function slugifyStudioSkillName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untitled-skill"
  );
}

export function createStudioSkillPreview(
  input: Omit<StudioSkillPreview, "id">
): StudioSkillPreview {
  return { ...input, id: createId("skill-preview") };
}
