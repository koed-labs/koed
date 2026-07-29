import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  getProjectTeamWorkspaceLink,
  linkProjectTeamWorkspace,
  listProjectTeamWorkspaceLinks,
  removeProjectTeamWorkspaceLink,
  removeProjectTeamWorkspaceLinksForBackend,
  removeProjectTeamWorkspaceLinksForMismatchedBinding
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
  const remotePrincipalId = "33333333-3333-4333-8333-333333333333";
  const deviceCredentialId = "44444444-4444-4444-8444-444444444444";

  it("stores non-secret Project to Team Workspace mapping under config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-ptw-"));
    const paths = pathsFor(directory);
    const projectRoot = path.join(directory, "repo");
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";

    const result = linkProjectTeamWorkspace(paths, {
      projectRoot,
      teamWorkspaceId,
      backendId: "dev_backend",
      remotePrincipalId,
      deviceCredentialId
    });

    expect(result).toMatchObject({
      ok: true,
      state: "linked",
      link: {
        projectRoot: path.resolve(projectRoot),
        teamWorkspaceId,
        backendId: "dev_backend",
        remotePrincipalId,
        deviceCredentialId,
        localProjectId: null
      }
    });
    const raw = fs.readFileSync(paths.projectTeamWorkspaceLinksPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 2 });
    expect(raw).toContain(teamWorkspaceId);
    expect(raw).not.toMatch(/token|secret|password|cookie|authorization/i);
    expect(getProjectTeamWorkspaceLink(paths, projectRoot).link).toMatchObject({
      teamWorkspaceId
    });
    expect(listProjectTeamWorkspaceLinks(paths).links).toHaveLength(1);
    expect(removeProjectTeamWorkspaceLink(paths, projectRoot).ok).toBe(true);
    expect(getProjectTeamWorkspaceLink(paths, projectRoot).ok).toBe(false);
  });

  it("removes only links bound to a disconnected backend", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-ptw-"));
    const paths = pathsFor(directory);
    linkProjectTeamWorkspace(paths, {
      projectRoot: path.join(directory, "first"),
      teamWorkspaceId: "11111111-1111-4111-8111-111111111111",
      backendId: "backend_a",
      remotePrincipalId,
      deviceCredentialId
    });
    linkProjectTeamWorkspace(paths, {
      projectRoot: path.join(directory, "second"),
      teamWorkspaceId: "22222222-2222-4222-8222-222222222222",
      backendId: "backend_b",
      remotePrincipalId,
      deviceCredentialId
    });

    expect(removeProjectTeamWorkspaceLinksForBackend(paths, "backend_a")).toBe(
      1
    );
    expect(listProjectTeamWorkspaceLinks(paths).links).toMatchObject([
      { backendId: "backend_b" }
    ]);
  });

  it("drops links from a replaced remote principal or device", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-ptw-"));
    const paths = pathsFor(directory);
    linkProjectTeamWorkspace(paths, {
      projectRoot: path.join(directory, "stale"),
      teamWorkspaceId: "11111111-1111-4111-8111-111111111111",
      backendId: "backend_a",
      remotePrincipalId,
      deviceCredentialId
    });
    linkProjectTeamWorkspace(paths, {
      projectRoot: path.join(directory, "current"),
      teamWorkspaceId: "22222222-2222-4222-8222-222222222222",
      backendId: "backend_a",
      remotePrincipalId: "55555555-5555-4555-8555-555555555555",
      deviceCredentialId: "66666666-6666-4666-8666-666666666666"
    });

    expect(
      removeProjectTeamWorkspaceLinksForMismatchedBinding(paths, {
        backendId: "backend_a",
        remotePrincipalId: "55555555-5555-4555-8555-555555555555",
        deviceCredentialId: "66666666-6666-4666-8666-666666666666"
      })
    ).toBe(1);
    expect(listProjectTeamWorkspaceLinks(paths).links).toMatchObject([
      {
        remotePrincipalId: "55555555-5555-4555-8555-555555555555",
        deviceCredentialId: "66666666-6666-4666-8666-666666666666"
      }
    ]);
  });
});
