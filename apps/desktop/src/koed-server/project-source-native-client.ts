import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import {
  projectSourceReadSchema,
  projectSourceRemovalReviewReservationSchema,
  projectSourceRemovalStatusSchema,
  projectSourceSchema,
  type ProjectSource
} from "@koed/shared/project-source-contract";
import type { ProjectsAuthority } from "./projects-client.js";

const MAX_BYTES = 25 * 1024 * 1024;
const sameAuthority = (a: ProjectsAuthority, b: ProjectsAuthority) =>
  a.key === b.key && a.ownerId === b.ownerId;
const path = (projectId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}/sources`;

export const createProjectSourceNativeClient = (input: {
  authority: () => Promise<ProjectsAuthority>;
  requestJson: (
    path: string,
    init: RequestInit,
    authority: ProjectsAuthority
  ) => Promise<Record<string, unknown>>;
}) => ({
  async prepareReview(
    projectId: string,
    sourceId: string,
    batchId: string,
    actionGrantId: string
  ) {
    const bound = await input.authority();
    const reservation = projectSourceRemovalReviewReservationSchema.parse(
      await input.requestJson(
        `${path(projectId)}/${encodeURIComponent(sourceId)}/removal/reviews/${encodeURIComponent(actionGrantId)}`,
        { method: "GET" },
        bound
      )
    );
    if (
      !sameAuthority(bound, await input.authority()) ||
      reservation.sourceId !== sourceId ||
      reservation.batchId !== batchId ||
      reservation.actionGrantId !== actionGrantId
    )
      throw new Error("Project Source review identity changed.");
    return { reservation, authorityKey: bound.key, ownerId: bound.ownerId };
  },
  async assertReviewAuthority(authorityKey: string, ownerId: string) {
    const current = await input.authority();
    if (current.key !== authorityKey || current.ownerId !== ownerId)
      throw new Error("Project Source review profile changed.");
  },
  async upload(
    projectId: string,
    selectFile: () => Promise<string | null>
  ): Promise<
    | { canceled: true; source: null }
    | { canceled: false; source: ProjectSource }
  > {
    const bound = await input.authority();
    if (!bound.canWrite)
      throw new Error("Project Sources write authority is unavailable.");
    const selected = await selectFile();
    if (!selected) return { canceled: true, source: null };
    if (!sameAuthority(bound, await input.authority()))
      throw new Error("Projects profile changed during file selection.");
    const handle = await open(selected, "r");
    let bytes: Buffer;
    try {
      const file = await handle.stat();
      if (!file.isFile())
        throw new Error("Selected Project Source is not a file.");
      if (file.size > MAX_BYTES)
        throw new Error("Project Source exceeds 25 MB.");
      const bounded = Buffer.allocUnsafe(MAX_BYTES + 1);
      let length = 0;
      while (length < bounded.length) {
        const { bytesRead } = await handle.read(
          bounded,
          length,
          bounded.length - length,
          length
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("Project Source exceeds 25 MB.");
      bytes = bounded.subarray(0, length);
    } finally {
      await handle.close();
    }
    if (!sameAuthority(bound, await input.authority()))
      throw new Error("Projects profile changed before upload.");
    const source = projectSourceSchema.parse(
      await input.requestJson(
        `${path(projectId)}/upload`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: basename(selected),
            mediaType: "application/octet-stream",
            bytesBase64: bytes.toString("base64"),
            idempotencyKey: randomUUID()
          })
        },
        bound
      )
    );
    if (
      !sameAuthority(bound, await input.authority()) ||
      source.projectId !== projectId
    )
      throw new Error("Project Source profile or Project identity changed.");
    return { canceled: false, source };
  },
  async read(
    projectId: string,
    sourceId: string,
    expectedNoteRevisionId: string
  ) {
    const bound = await input.authority();
    const result = projectSourceReadSchema.parse(
      await input.requestJson(
        `${path(projectId)}/${encodeURIComponent(sourceId)}/content`,
        { method: "GET" },
        bound
      )
    );
    if (
      !sameAuthority(bound, await input.authority()) ||
      result.sourceId !== sourceId ||
      result.noteRevisionId !== expectedNoteRevisionId
    )
      throw new Error("Project Source read identity changed.");
    return result;
  },
  async remove(projectId: string, sourceId: string) {
    const bound = await input.authority();
    if (!bound.canWrite)
      throw new Error("Project Sources write authority is unavailable.");
    const result = projectSourceRemovalStatusSchema.parse(
      await input.requestJson(
        `${path(projectId)}/${encodeURIComponent(sourceId)}/removal`,
        { method: "POST" },
        bound
      )
    );
    if (!sameAuthority(bound, await input.authority()))
      throw new Error("Project Source removal profile changed.");
    return result;
  }
});
