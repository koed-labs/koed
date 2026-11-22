import { beforeEach, describe, expect, it, vi } from "vitest";
import { hintsForConversation } from "@koed-labs/server";
import {
  createProjectCommands,
  type ProjectCommandsDeps
} from "./project-commands.js";
import {
  createProjectManagementValidationApi,
  validationId,
  validationOwner
} from "../project-management-validation-api.js";

vi.mock("@koed-labs/server", async (original) => ({
  ...(await original<typeof import("@koed-labs/server")>()),
  hintsForConversation: vi.fn()
}));

const sessionId = validationId(108);
const folder = {
  ownerUserId: validationOwner,
  folderId: "same-id",
  originatingDeploymentId: "deployment",
  originatingDeviceId: "device",
  originatingProfileId: "profile",
  directoryIncarnationId: "reviewed"
};
const input = { sessionId, kind: "worktree-parent", folder };
const candidate = {
  tier: "medium",
  kind: "worktree-parent",
  folder,
  score: 4,
  reasons: []
} satisfies NonNullable<
  Awaited<ReturnType<typeof hintsForConversation>>
>[number];
const score = vi.mocked(hintsForConversation);

function setup() {
  const { contexts } = createProjectManagementValidationApi();
  const request = vi.fn(async () => ({
    ownerUserId: validationOwner,
    evidence: [
      {
        sessionId,
        folderAssignment: contexts.get(sessionId)!.folder,
        recordedCwd: "/work/branch",
        firstConversationAt: null,
        recordedRemoteFingerprint: null,
        capturedOnThisDevice: true
      }
    ]
  }));
  const commands = createProjectCommands({
    personalRequest: request,
    lookup: {}
  } as unknown as ProjectCommandsDeps);
  return { request, confirm: commands.confirmFolderHint };
}

beforeEach(() => score.mockReset());

describe("Folder hint confirmation", () => {
  it("rejects a fresh same-kind candidate with a different directory incarnation", async () => {
    const { confirm, request } = setup();
    score.mockResolvedValue([
      {
        ...candidate,
        reasons: [],
        folder: { ...folder, directoryIncarnationId: "replacement" }
      }
    ]);
    await expect(confirm(input)).rejects.toThrow("no longer matches");
    expect(request).toHaveBeenCalledTimes(1);
    expect(score).toHaveBeenCalledOnce();
  });

  it("rejects another kind even when its full Folder reference matches", async () => {
    const { confirm } = setup();
    score.mockResolvedValue([
      { ...candidate, reasons: [], kind: "registered" }
    ]);
    await expect(confirm(input)).rejects.toThrow("no longer matches");
  });

  it("confirms the exact reference without calling any write endpoint", async () => {
    const { confirm, request } = setup();
    score.mockResolvedValue([{ ...candidate, reasons: [] }]);
    await expect(confirm(input)).resolves.toEqual({ folder });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/v1/personal/sessions/folder-hint-evidence",
      expect.anything()
    );
  });
});
