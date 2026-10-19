import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  readProjectFolderFilter,
  writeProjectFolderFilter
} from "./project-folder-filters.js";
it("remembers hidden folders per Project and removes a restored default", () => {
  const home = mkdtempSync(join(tmpdir(), "koed-folder-filter-"));
  try {
    expect(readProjectFolderFilter(home, "a").hiddenFolderIds).toEqual([]);
    writeProjectFolderFilter(home, {
      projectId: "a",
      hiddenFolderIds: ["one", "one"]
    });
    writeProjectFolderFilter(home, {
      projectId: "b",
      hiddenFolderIds: ["two"]
    });
    expect(readProjectFolderFilter(home, "a").hiddenFolderIds).toEqual(["one"]);
    expect(readProjectFolderFilter(home, "b").hiddenFolderIds).toEqual(["two"]);
    writeProjectFolderFilter(home, { projectId: "a", hiddenFolderIds: [] });
    expect(readProjectFolderFilter(home, "a").hiddenFolderIds).toEqual([]);
    expect(
      JSON.parse(
        readFileSync(join(home, "config/project-folder-filters.json"), "utf8")
      ).projects
    ).toHaveLength(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it("does not overwrite malformed preferences", () => {
  const home = mkdtempSync(join(tmpdir(), "koed-folder-filter-"));
  try {
    writeProjectFolderFilter(home, {
      projectId: "a",
      hiddenFolderIds: ["one"]
    });
    const path = join(home, "config/project-folder-filters.json");
    writeFileSync(path, "invalid");
    expect(() =>
      writeProjectFolderFilter(home, { projectId: "b", hiddenFolderIds: [] })
    ).toThrow("unavailable");
    expect(readFileSync(path, "utf8")).toBe("invalid");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
