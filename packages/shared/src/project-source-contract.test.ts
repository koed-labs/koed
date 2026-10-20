import { describe, expect, it } from "vitest";
import { createProjectSourceSchema } from "./project-source-contract.js";

describe("Project Source create references", () => {
  it("requires absolute local folders and canonical credential-free remote names", () => {
    const validFolder = createProjectSourceSchema.safeParse({
      kind: "folder",
      name: "notes",
      uri: "/Users/me/notes"
    });
    const validRepo = createProjectSourceSchema.safeParse({
      kind: "repo",
      name: "github.com/team/repo",
      uri: "github.com/team/repo"
    });
    expect(validFolder.success).toBe(true);
    expect(validRepo.success).toBe(true);
    for (const uri of [
      undefined,
      "notes",
      "file:///tmp/notes",
      "https://example.org/notes"
    ]) {
      expect(
        createProjectSourceSchema.safeParse({
          kind: "folder",
          name: "notes",
          uri
        }).success
      ).toBe(false);
    }
    for (const uri of [
      undefined,
      "https://token:secret@github.com/team/repo.git",
      "github.com/team/repo?token=secret",
      "github.com/team/../repo"
    ]) {
      expect(
        createProjectSourceSchema.safeParse({
          kind: "repo",
          name: "github.com/team/repo",
          uri
        }).success
      ).toBe(false);
    }
  });
});
