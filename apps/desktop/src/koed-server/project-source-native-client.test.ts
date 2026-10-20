import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSourceNativeClient } from "./project-source-native-client.js";
import type { ProjectsAuthority } from "./projects-client.js";

const ownerId = randomUUID();
const projectId = randomUUID();
const sourceId = randomUUID();
const revisionId = randomUUID();
const authority = (key = "profile-a"): ProjectsAuthority => ({
  key,
  ownerId,
  apiOrigin: "http://127.0.0.1:4000",
  authorization: "test",
  canWrite: true
});
const source = () => ({
  id: sourceId,
  projectId,
  kind: "doc",
  name: "Plan.txt",
  uri: null,
  currentRevisionId: null,
  status: "extracting",
  failureReason: null,
  addedBy: ownerId,
  uses: 0,
  deletedAt: null,
  createdAt: "2026-10-20T00:00:00.000Z"
});
const roots: string[] = [];
const file = async (body = "Keep the original and preserve provenance.") => {
  const scratch = fileURLToPath(
    new URL("../../../../scratch/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(resolve(scratch, "hq209-native-source-"));
  roots.push(directory);
  const path = resolve(directory, "Plan.txt");
  await writeFile(path, body);
  return path;
};
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("Project Source native boundary", () => {
  it("does not dispatch on picker cancellation or read-only authority", async () => {
    const requestJson = vi.fn(async () => source());
    const select = vi.fn(async () => null);
    const client = createProjectSourceNativeClient({
      authority: async () => authority(),
      requestJson
    });
    await expect(client.upload(projectId, select)).resolves.toEqual({
      canceled: true,
      source: null
    });
    const readOnly = createProjectSourceNativeClient({
      authority: async () => ({ ...authority(), canWrite: false }),
      requestJson
    });
    await expect(readOnly.upload(projectId, select)).rejects.toThrow(
      "write authority"
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("uploads selected bytes with captured authority and never sends the filesystem path", async () => {
    const path = await file();
    const bound = authority();
    const requestJson = vi.fn(
      async (
        _path: string,
        _init: RequestInit,
        captured: ProjectsAuthority
      ) => {
        expect(captured).toBe(bound);
        return source();
      }
    );
    const client = createProjectSourceNativeClient({
      authority: async () => bound,
      requestJson
    });
    await expect(
      client.upload(projectId, async () => path)
    ).resolves.toMatchObject({ canceled: false, source: { id: sourceId } });
    const [requestPath, init] = requestJson.mock.calls[0]!;
    expect(requestPath).toBe(`/v1/projects/${projectId}/sources/upload`);
    expect(init.method).toBe("POST");
    const payload = JSON.parse(String(init.body)) as Record<string, string>;
    expect(payload.name).toBe("Plan.txt");
    expect(Buffer.from(payload.bytesBase64!, "base64").toString("utf8")).toBe(
      "Keep the original and preserve provenance."
    );
    expect(String(init.body)).not.toContain(path);
    expect(payload).not.toHaveProperty("path");
  });

  it("rejects profile changes while the native picker is open before sending bytes", async () => {
    const readAuthority = vi
      .fn()
      .mockResolvedValueOnce(authority())
      .mockResolvedValueOnce(authority("profile-b"));
    const requestJson = vi.fn(async () => source());
    const client = createProjectSourceNativeClient({
      authority: readAuthority,
      requestJson
    });
    await expect(
      client.upload(projectId, async () => "/never/open/Plan.txt")
    ).rejects.toThrow("profile changed");
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("rejects an oversized selected file before upload", async () => {
    const path = await file("");
    await truncate(path, 25 * 1024 * 1024 + 1);
    const requestJson = vi.fn(async () => source());
    const client = createProjectSourceNativeClient({
      authority: async () => authority(),
      requestJson
    });
    await expect(client.upload(projectId, async () => path)).rejects.toThrow(
      "25 MB"
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("withholds mismatched Note revisions and removal batch reservations", async () => {
    const batchId = randomUUID();
    const actionGrantId = randomUUID();
    const requestJson = vi
      .fn<
        Parameters<typeof createProjectSourceNativeClient>[0]["requestJson"]
      >()
      .mockResolvedValueOnce({
        sourceId,
        sourceRevisionId: randomUUID(),
        noteId: randomUUID(),
        noteRevisionId: randomUUID(),
        name: "Plan.txt",
        text: "Owner document."
      })
      .mockResolvedValueOnce({
        batchId: randomUUID(),
        sourceId,
        backendId: "team-backend",
        shareGrantId: randomUUID(),
        actionGrantId,
        reviewedGrantVersion: 1
      });
    const client = createProjectSourceNativeClient({
      authority: async () => authority(),
      requestJson
    });
    await expect(client.read(projectId, sourceId, revisionId)).rejects.toThrow(
      "read identity changed"
    );
    await expect(
      client.prepareReview(projectId, sourceId, batchId, actionGrantId)
    ).rejects.toThrow("review identity changed");
  });
});
