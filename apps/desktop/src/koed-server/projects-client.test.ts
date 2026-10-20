import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectsClient } from "./projects-client.js";

const now = "2026-10-20T00:00:00.000Z";
const project = (id: string) => ({
  id,
  name: "Atlas",
  key: "ATLAS",
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1
});

describe("Projects main client", () => {
  it("reads every owner page and rejects a profile change during pagination", async () => {
    const first = project(randomUUID());
    const second = project(randomUUID());
    const read = vi.fn(async (path: string) =>
      path.includes("cursor=next")
        ? { projects: [second], nextCursor: null }
        : { projects: [first], nextCursor: "next" }
    );
    const authority = vi.fn(async () => "owner-profile-a");
    const client = createProjectsClient(read, authority);
    await expect(client({ operation: "list" })).resolves.toEqual({
      operation: "list",
      projects: [first, second]
    });
    expect(read).toHaveBeenCalledTimes(2);
    authority
      .mockResolvedValueOnce("owner-profile-a")
      .mockResolvedValueOnce("owner-profile-b");
    await expect(client({ operation: "list" })).rejects.toThrow(
      "profile changed"
    );
  });

  it("validates Project HQ identity and read responses", async () => {
    const id = randomUUID();
    const sections = Object.fromEntries(
      ["conversations", "workItems", "sources", "decks", "scheduledJobs"].map(
        (key) => [key, { availability: "not_implemented" }]
      )
    );
    const read = vi.fn(async () => ({
      project: project(randomUUID()),
      sections
    }));
    const client = createProjectsClient(read, async () => "owner-profile-a");
    await expect(client({ operation: "hq", projectId: id })).rejects.toThrow(
      "identity mismatch"
    );
    read.mockResolvedValueOnce({ project: project(id), sections });
    await expect(
      client({ operation: "hq", projectId: id })
    ).resolves.toMatchObject({ operation: "hq", value: { project: { id } } });
  });
});
