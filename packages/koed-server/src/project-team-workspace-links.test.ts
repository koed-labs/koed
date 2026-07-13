import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  getProjectTeamWorkspaceLink,
  linkProjectTeamWorkspace,
  listProjectTeamWorkspaceLinks,
  removeProjectTeamWorkspaceLink
} from "./project-team-workspace-links.js";

const pathsFor = (directory: string): KoedServerPaths =>
  ({
    configDir: path.join(directory, "config"),
    projectTeamWorkspaceLinksPath: path.join(
      directory,
      "config",
      "project-team-workspaces.json"
    )
  }) as KoedServerPaths;

describe("Project Team Workspace links", () => {
  it("stores non-secret Project to Team Workspace mapping under config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-ptw-"));
    const paths = pathsFor(directory);
    const projectRoot = path.join(directory, "repo");
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";

    const result = linkProjectTeamWorkspace(paths, {
      projectRoot,
      teamWorkspaceId,
      backendId: "dev_backend"
    });

    expect(result).toMatchObject({
      ok: true,
      state: "linked",
      link: {
        projectRoot: path.resolve(projectRoot),
        teamWorkspaceId,
        backendId: "dev_backend",
        localProjectId: null
      }
    });
    const raw = fs.readFileSync(paths.projectTeamWorkspaceLinksPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 2 });
    expect(raw).toContain(teamWorkspaceId);
    expect(raw).not.toMatch(/token|secret|password|cookie|credential/i);
    expect(getProjectTeamWorkspaceLink(paths, projectRoot).link).toMatchObject({
      teamWorkspaceId
    });
    expect(listProjectTeamWorkspaceLinks(paths).links).toHaveLength(1);
    expect(removeProjectTeamWorkspaceLink(paths, projectRoot).ok).toBe(true);
    expect(getProjectTeamWorkspaceLink(paths, projectRoot).ok).toBe(false);
  });
});
