import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPersonalAgentRoleTemplates,
  matchRoleTemplate,
  parsePersonalAgentRoleTemplates,
  rankRoleTemplates
} from "./personal-agent-role-templates-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const template = (id: string, version: number, title = id) => ({
  id,
  version,
  title,
  role: title,
  soulInstructions: `Instructions ${version}`,
  contentSha256: "a".repeat(64)
});

describe("personal agent role template client", () => {
  it("keeps only the newest published version in deterministic title order", () => {
    expect(
      parsePersonalAgentRoleTemplates({
        templates: [
          template("reviewer", 1, "Code Reviewer"),
          template("researcher", 1, "Researcher"),
          template("reviewer", 2, "Code Reviewer")
        ]
      })
    ).toEqual([
      template("reviewer", 2, "Code Reviewer"),
      template("researcher", 1, "Researcher")
    ]);
  });

  it("rejects malformed catalogues instead of presenting partial records", () => {
    expect(() =>
      parsePersonalAgentRoleTemplates({ templates: [{ id: "broken" }] })
    ).toThrow("invalid data");
  });

  it.each([
    ["backend developer", "backend-engineer"],
    ["frontend engineer", "frontend-engineer"],
    ["code review", "code-reviewer"],
    ["product manager", "product-manager"],
    ["data architecture", "data-architect"],
    ["researcher", "researcher"]
  ])("suggests a stable role match for %s", (role, expectedId) => {
    const templates = [
      template("researcher", 1, "Researcher"),
      template("data-architect", 1, "Data Architect"),
      template("product-manager", 1, "Product Manager"),
      template("code-reviewer", 1, "Code Reviewer"),
      template("frontend-engineer", 1, "Frontend Engineer"),
      template("backend-engineer", 1, "Backend Engineer")
    ];
    expect(rankRoleTemplates(role, templates)[0]?.id).toBe(expectedId);
  });

  it("matches selected canonical roles without claiming free text", () => {
    const backend = template("backend-engineer", 1, "Backend Engineer");
    expect(matchRoleTemplate("  BACKEND ENGINEER ", [backend])).toBe(backend);
    expect(matchRoleTemplate("backend developer", [backend])).toBeUndefined();
    expect(matchRoleTemplate("", [backend])).toBeUndefined();
  });

  it("loads role templates from the hosted same-origin API route", async () => {
    vi.stubGlobal("window", { location: { pathname: "/studio/agents" } });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ templates: [template("researcher", 1, "Researcher")] })
    );

    await expect(
      listPersonalAgentRoleTemplates(undefined, fetcher)
    ).resolves.toEqual([template("researcher", 1, "Researcher")]);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/personal-agent-role-templates",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        redirect: "error",
        headers: { accept: "application/json" }
      })
    );
  });

  it("uses the hosted role-template route at the basePath root without a trailing slash", async () => {
    vi.stubGlobal("window", { location: { pathname: "/studio" } });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ templates: [template("researcher", 1, "Researcher")] })
    );

    await listPersonalAgentRoleTemplates(undefined, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/v1/personal-agent-role-templates",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("keeps local Studio role templates on the gateway route", async () => {
    vi.stubGlobal("window", { location: { pathname: "/agents" } });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ templates: [template("researcher", 1, "Researcher")] })
    );

    await listPersonalAgentRoleTemplates(undefined, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/studio-api/personal-agent-role-templates",
      expect.objectContaining({ credentials: "include" })
    );
  });
});
