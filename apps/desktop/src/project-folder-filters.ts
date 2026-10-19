import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  projectFolderFilterSchema,
  type ProjectFolderFilter
} from "./ipc/project-folder-filter.js";

const fileSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(projectFolderFilterSchema).max(512)
  })
  .strict();
const maxBytes = 1024 * 1024;
const filePath = (koedHome: string) =>
  join(koedHome, "config", "project-folder-filters.json");
function read(koedHome: string): z.infer<typeof fileSchema> {
  const path = filePath(koedHome);
  try {
    if (statSync(path).size > maxBytes)
      throw new Error("Folder filter file is too large.");
    return fileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, projects: [] };
    throw new Error("Saved folder filters are unavailable.", { cause: error });
  }
}
export function readProjectFolderFilter(
  koedHome: string,
  projectId: string
): ProjectFolderFilter {
  return (
    read(koedHome).projects.find((entry) => entry.projectId === projectId) ?? {
      projectId,
      hiddenFolderIds: []
    }
  );
}
export function writeProjectFolderFilter(
  koedHome: string,
  input: ProjectFolderFilter
): ProjectFolderFilter {
  const value = projectFolderFilterSchema.parse({
    ...input,
    hiddenFolderIds: [...new Set(input.hiddenFolderIds)]
  });
  const file = read(koedHome);
  file.projects = file.projects.filter(
    (entry) => entry.projectId !== value.projectId
  );
  if (value.hiddenFolderIds.length) file.projects.push(value);
  fileSchema.parse(file);
  const content = JSON.stringify(file);
  if (Buffer.byteLength(content, "utf8") > maxBytes)
    throw new Error("Folder filter file is too large.");
  const directory = join(koedHome, "config");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.project-folder-filters-${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, filePath(koedHome));
  } finally {
    rmSync(temporary, { force: true });
  }
  return value;
}
