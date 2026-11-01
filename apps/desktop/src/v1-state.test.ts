import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createV1State, v1OwnerScope } from "./v1-state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "koed-v1-state-"));
  roots.push(path);
  return path;
};
const owner = (path: string, id: string, backend = "https://koed.example") =>
  createV1State({
    userDataPath: path,
    ownerIdentity: async () => ({
      ownerId: id,
      scopeKey: v1OwnerScope(backend, id)
    })
  });
const uuid = (number: number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

describe("V1 state", () => {
  it("serializes concurrent intent writes and survives a new store instance", async () => {
    const path = root();
    const values = new Map<string, string>();
    const store = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        values.set(key, value);
      }
    };
    const identity = async () => ({
      ownerId: uuid(1),
      scopeKey: v1OwnerScope("https://koed.example", uuid(1))
    });
    const state = createV1State({ store, ownerIdentity: identity });
    await Promise.all(
      Array.from({ length: 510 }, (_, n) =>
        state.request({
          operation: "project_intent_put",
          intent: {
            requestId: uuid(n + 10),
            name: `Project ${n}`,
            createdAt: new Date().toISOString()
          }
        })
      )
    );
    const recovered = createV1State({ store, ownerIdentity: identity });
    const read = await recovered.request({ operation: "provenance_read" });
    expect(read.operation).toBe("provenance_read");
    if (read.operation !== "provenance_read") return;
    expect(Object.keys(read.provenance.projects)).toHaveLength(510);
    await recovered.request({
      operation: "project_ack",
      requestId: uuid(10),
      projectId: uuid(900)
    });
    const again = await createV1State({
      store,
      ownerIdentity: identity
    }).request({ operation: "provenance_read" });
    const disk = owner(path, uuid(1));
    await disk.request({
      operation: "project_intent_put",
      intent: {
        requestId: uuid(1),
        name: "Persistent",
        createdAt: new Date().toISOString()
      }
    });
    const diskRead = await owner(path, uuid(1)).request({
      operation: "provenance_read"
    });
    expect(
      diskRead.operation === "provenance_read" &&
        diskRead.provenance.projects[uuid(1)]?.name
    ).toBe("Persistent");
    expect(
      again.operation === "provenance_read" &&
        again.provenance.projects[uuid(10)]?.projectId
    ).toBe(uuid(900));
  });

  it("scopes provenance by verified backend and owner while allowing local profile before access", async () => {
    const path = root();
    const a = owner(path, uuid(1));
    await a.request({
      operation: "profile_write",
      profile: {
        agentName: "Ada",
        agentLook: "pixel",
        onboarding: { selections: { client: "codex" }, completed: false }
      }
    });
    await a.request({
      operation: "project_intent_put",
      intent: {
        requestId: uuid(2),
        name: "Only A",
        createdAt: new Date().toISOString()
      }
    });
    for (const other of [
      owner(path, uuid(3)),
      owner(path, uuid(1), "https://other.example")
    ]) {
      const result = await other.request({ operation: "provenance_read" });
      expect(
        result.operation === "provenance_read" &&
          Object.keys(result.provenance.projects)
      ).toHaveLength(0);
    }
    const profile = await owner(path, uuid(3)).request({
      operation: "profile_read"
    });
    expect(
      profile.operation === "profile_read" && profile.profile.agentName
    ).toBe("Ada");
  });

  it("marks initial Folder setup complete so later removal is not replayed", async () => {
    const state = owner(root(), uuid(1));
    const requestId = uuid(20);
    const folder = {
      ownerUserId: uuid(1),
      originatingDeploymentId: uuid(2),
      originatingDeviceId: uuid(3),
      originatingProfileId: uuid(4),
      folderId: uuid(5),
      directoryIncarnationId: uuid(6)
    };
    await state.request({
      operation: "project_intent_put",
      intent: {
        requestId,
        name: "Project",
        folder,
        createdAt: new Date().toISOString()
      }
    });
    await state.request({
      operation: "project_ack",
      requestId,
      projectId: uuid(21)
    });
    const result = await state.request({
      operation: "project_folder_ack",
      requestId
    });
    expect(
      result.operation === "project_folder_ack" && result.intent.folderAttached
    ).toBe(true);
    const recovered = await state.request({ operation: "provenance_read" });
    expect(
      recovered.operation === "provenance_read" &&
        recovered.provenance.projects[requestId]?.folderAttached
    ).toBe(true);
  });

  it("recovers one first-prompt identity after an uncertain send", async () => {
    const path = root();
    const state = owner(path, uuid(1));
    const intent = {
      idempotencyKey: "launch-one",
      projectId: uuid(2),
      aiClientDriverId: "codex" as const,
      aiClientInstanceId: "client-one",
      model: "model-one",
      reasoningEffort: null,
      permissionMode: "supervised" as const,
      runnerKind: "local_device" as const,
      createdAt: new Date().toISOString()
    };
    await state.request({ operation: "conversation_intent_put", intent });
    await state.request({
      operation: "conversation_ack",
      idempotencyKey: intent.idempotencyKey,
      executionId: uuid(3)
    });
    const initialPrompt = {
      clientUserMessageId: uuid(4),
      prompt: "Hello",
      status: "reconciling" as const,
      message: "Response uncertain"
    };
    await state.request({
      operation: "conversation_prompt",
      idempotencyKey: intent.idempotencyKey,
      initialPrompt
    });
    const recovered = await owner(path, uuid(1)).request({
      operation: "provenance_read"
    });
    expect(
      recovered.operation === "provenance_read" &&
        recovered.provenance.conversations[intent.idempotencyKey]?.initialPrompt
    ).toEqual(initialPrompt);
    await expect(
      owner(path, uuid(1)).request({
        operation: "conversation_prompt",
        idempotencyKey: intent.idempotencyKey,
        initialPrompt: { ...initialPrompt, clientUserMessageId: uuid(5) }
      })
    ).rejects.toThrow("conflicts");
  });

  it("does not acknowledge an unrecorded request or replace a conflicting intent", async () => {
    const state = owner(root(), uuid(1));
    await expect(
      state.request({
        operation: "project_ack",
        requestId: uuid(10),
        projectId: uuid(11)
      })
    ).rejects.toThrow("missing");
    const intent = {
      requestId: uuid(10),
      name: "One",
      createdAt: new Date().toISOString()
    };
    await state.request({ operation: "project_intent_put", intent });
    await expect(
      state.request({
        operation: "project_intent_put",
        intent: { ...intent, name: "Other" }
      })
    ).rejects.toThrow("conflicts");
  });
});
