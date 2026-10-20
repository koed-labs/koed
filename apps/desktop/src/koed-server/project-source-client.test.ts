import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectSourceClient } from "./project-source-client.js";
import type { ProjectsAuthority } from "./projects-client.js";

const projectId = randomUUID();
const authority: ProjectsAuthority = {
  key: "owner-a",
  ownerId: randomUUID(),
  apiOrigin: "http://127.0.0.1:4000",
  authorization: "desktop",
  canWrite: true
};
const hq = {
  project: {
    id: projectId,
    name: "Atlas",
    key: "ATLAS",
    folderPath: "/atlas",
    lifecycle: "active",
    deletionPhase: null,
    deleteBatchId: null,
    deletedAt: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    version: 1
  },
  sections: Object.fromEntries(
    ["conversations", "workItems", "sources", "decks", "scheduledJobs"].map(
      (key) => [key, { availability: "not_implemented" }]
    )
  )
};

describe("trusted Project Source client", () => {
  it("offers only sanitized local Git remotes and rejects a caller-invented repo", async () => {
    const request = vi.fn(async () => hq);
    const discover = vi.fn(async () => [
      { name: "example.org/team/repo", uri: "example.org/team/repo" }
    ]);
    const client = createProjectSourceClient(
      request,
      async () => authority,
      discover
    );
    await expect(
      client({ operation: "sourceDiscoverRepos", projectId })
    ).resolves.toEqual({
      operation: "sourceDiscoverRepos",
      value: {
        repos: [{ name: "example.org/team/repo", uri: "example.org/team/repo" }]
      }
    });
    expect(discover).toHaveBeenCalledWith("/atlas");
    await expect(
      client({
        operation: "sourceCreate",
        projectId,
        value: {
          kind: "repo",
          name: "evil/repo",
          uri: "example.org/evil/repo"
        }
      })
    ).rejects.toThrow("not a discovered remote");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed profile after a source read", async () => {
    const read = vi.fn(async () => ({ sources: [] }));
    const keys = [authority, authority, { ...authority, key: "owner-b" }];
    const client = createProjectSourceClient(
      read,
      async () => keys.shift() ?? authority,
      async () => []
    );
    await expect(
      client({ operation: "sourceList", projectId })
    ).rejects.toThrow("profile changed");
  });
});
