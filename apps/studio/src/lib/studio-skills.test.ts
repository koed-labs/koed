import { describe, expect, it } from "vitest";
import {
  filterStudioSkillCatalog,
  hasStudioSkillName,
  parseStudioSkillPreviews,
  slugifyStudioSkillName,
  STUDIO_SKILL_CATALOG
} from "./studio-skills";

describe("Studio skill preview helpers", () => {
  it("provides separate Personal, System, and Koed catalogs", () => {
    expect(STUDIO_SKILL_CATALOG.personal.length).toBeGreaterThan(0);
    expect(STUDIO_SKILL_CATALOG.system.length).toBeGreaterThan(0);
    expect(STUDIO_SKILL_CATALOG.koed.length).toBeGreaterThan(0);
  });

  it("filters the selected scope by title or description", () => {
    const catalog = STUDIO_SKILL_CATALOG.personal;
    expect(
      filterStudioSkillCatalog(catalog, "FRONTEND").map((item) => item.id)
    ).toEqual(["frontend-skill"]);
    expect(
      filterStudioSkillCatalog(catalog, "debugging").map((item) => item.id)
    ).toEqual(["chrome-devtools"]);
    expect(filterStudioSkillCatalog(catalog, "  ")).toBe(catalog);
  });

  it("accepts only well-formed local preview records", () => {
    expect(
      parseStudioSkillPreviews(
        JSON.stringify([
          { id: "one", title: "One", description: "Local", source: "custom" },
          {
            id: "bad",
            title: "Bad",
            description: "Invalid",
            source: "installed"
          },
          null
        ])
      )
    ).toEqual([
      { id: "one", title: "One", description: "Local", source: "custom" }
    ]);
    expect(parseStudioSkillPreviews("not-json")).toEqual([]);
  });

  it("compares names case-insensitively and creates safe folder labels", () => {
    expect(
      hasStudioSkillName([{ title: "Frontend Skill" }], " frontend skill ")
    ).toBe(true);
    expect(hasStudioSkillName([{ title: "Frontend Skill" }], "Security")).toBe(
      false
    );
    expect(slugifyStudioSkillName("Image Generation / Review")).toBe(
      "image-generation-review"
    );
    expect(slugifyStudioSkillName("---")).toBe("untitled-skill");
  });
});
