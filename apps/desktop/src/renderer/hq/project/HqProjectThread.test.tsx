// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { SharedProjectStore } from "../shared-project/shared-project-store.js";
import { HqProjectThread } from "./HqProjectThread.js";

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const teamId = id("7051");
const workspaceId = id("7052");
const threadFor = (project: string) => ({
  id: project === id("7053") ? id("7055") : id("7056"),
  teamId,
  workspaceId,
  workspaceProjectId: project,
  version: 1,
  lifecycle: "active" as const,
  latestSequence: 0,
  lastReadSequence: 0,
  unreadCount: 0,
  people: [{ userId: id("7057"), displayName: "Maya" }]
});
const identityFor = (profileKey: string, workspaceProjectId: string) => ({
  ownerId: id("7058"),
  profileKey,
  personalProjectId: id("7059"),
  workspaceProjectId,
  teamBackendId: "backend-a"
});
const storeFor = (identity: ReturnType<typeof identityFor>) => {
  const snapshot = {
    identity,
    state: {
      project: { id: identity.workspaceProjectId, teamId, lifecycle: "active" }
    }
  };
  return {
    subscribe: () => () => undefined,
    current: () => snapshot
  } as unknown as SharedProjectStore;
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

it("discards late Project responses, resets profile drafts, refreshes while hidden, and clears on revocation", async () => {
  const firstProject = id("7053");
  const secondProject = id("7054");
  let completeFirst!: (value: ReturnType<typeof threadFor>) => void;
  const firstOpen = new Promise<ReturnType<typeof threadFor>>((resolve) => {
    completeFirst = resolve;
  });
  const openProjectThreadV2 = vi.fn(
    async ({ workspaceProjectId }: { workspaceProjectId: string }) =>
      workspaceProjectId === firstProject
        ? firstOpen
        : threadFor(workspaceProjectId)
  );
  const subscribeProjectThreadV2 = vi.fn(
    async (input: unknown, listener: (event: unknown) => void) => {
      expect(input).toBeDefined();
      expect(listener).toBeTypeOf("function");
      return () => undefined;
    }
  );
  const client = {
    current: () => null,
    subscribe: () => () => undefined,
    openProjectThreadV2,
    loadProjectThreadMessagesV2: vi.fn(
      async ({ threadId }: { threadId: string }) => ({
        threadId,
        items: [],
        hasOlder: false,
        olderCursor: null
      })
    ),
    subscribeProjectThreadV2,
    markProjectThreadReadV2: vi.fn()
  } as unknown as CollaborationRendererClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (profileKey: string, project: string, active = true) => {
    await act(async () => {
      root.render(
        <HqProjectThread
          client={client}
          sharedProjectStore={storeFor(identityFor(profileKey, project))}
          identity={identityFor(profileKey, project)}
          active={active}
        />
      );
    });
  };
  await render("profile-a", firstProject);
  await render("profile-b", secondProject);
  await act(async () => {
    await Promise.resolve();
  });
  const composer = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(composer).not.toBeNull();
  await act(async () => {
    composer!.value = "draft for the second profile";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    completeFirst(threadFor(firstProject));
    await firstOpen;
  });
  expect(
    container.querySelector(".hq-project-thread__people")?.textContent
  ).toContain("Maya");
  expect(subscribeProjectThreadV2).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceProjectId: secondProject,
      threadId: id("7056")
    }),
    expect.any(Function)
  );
  expect(subscribeProjectThreadV2).not.toHaveBeenCalledWith(
    expect.objectContaining({ workspaceProjectId: firstProject }),
    expect.any(Function)
  );
  const setText = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setText?.call(container.querySelector("textarea"), "second profile draft");
    container
      .querySelector("textarea")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "second profile draft"
  );
  await render("profile-c", secondProject, false);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    ""
  );
  const countBeforeUpdate = openProjectThreadV2.mock.calls.length;
  const onRealtime = subscribeProjectThreadV2.mock.calls.at(-1)?.[1] as (
    event: unknown
  ) => void;
  await act(async () => {
    onRealtime({ type: "project_thread_v2_update", threadId: id("7056") });
    await Promise.resolve();
  });
  expect(openProjectThreadV2.mock.calls.length).toBeGreaterThan(
    countBeforeUpdate
  );
  await act(async () => {
    onRealtime({
      type: "project_thread_v2_control",
      threadId: id("7056"),
      reason: "access_revoked"
    });
  });
  expect(container.querySelector(".hq-project-thread__people")).toBeNull();
  expect(container.textContent).toContain(
    "Project Thread access is unavailable."
  );
  await act(async () => root.unmount());
});

it("reuses a message key after a lost response and changes it when the draft changes", async () => {
  const project = id("7054");
  const serverMessages = new Map<string, string>();
  let loseResponse = true;
  const sendProjectThreadMessageV2 = vi.fn(
    async ({
      clientMessageId,
      body
    }: {
      clientMessageId: string;
      body: string;
    }) => {
      serverMessages.set(clientMessageId, body);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Response lost after commit");
      }
      return { id: id("7060") };
    }
  );
  const client = {
    current: () => null,
    subscribe: () => () => undefined,
    openProjectThreadV2: vi.fn(async () => threadFor(project)),
    loadProjectThreadMessagesV2: vi.fn(async () => ({
      threadId: id("7056"),
      items: [],
      hasOlder: false,
      olderCursor: null
    })),
    subscribeProjectThreadV2: vi.fn(async () => () => undefined),
    markProjectThreadReadV2: vi.fn(),
    sendProjectThreadMessageV2
  } as unknown as CollaborationRendererClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <HqProjectThread
        client={client}
        sharedProjectStore={storeFor(identityFor("profile-a", project))}
        identity={identityFor("profile-a", project)}
        active={false}
      />
    );
  });
  const setText = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  const edit = async (body: string) => {
    await act(async () => {
      setText?.call(container.querySelector("textarea"), body);
      container
        .querySelector("textarea")
        ?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const send = async () => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".hq-project-thread__send")
        ?.click();
    });
  };
  await edit("Message delivered once");
  await send();
  expect(container.textContent).toContain("Response lost after commit");
  await send();
  expect(sendProjectThreadMessageV2).toHaveBeenCalledTimes(2);
  expect(sendProjectThreadMessageV2.mock.calls[1]?.[0].clientMessageId).toBe(
    sendProjectThreadMessageV2.mock.calls[0]?.[0].clientMessageId
  );
  expect(serverMessages.size).toBe(1);

  await edit("A changed message");
  await send();
  expect(
    sendProjectThreadMessageV2.mock.calls[2]?.[0].clientMessageId
  ).not.toBe(sendProjectThreadMessageV2.mock.calls[0]?.[0].clientMessageId);
  expect(serverMessages.size).toBe(2);
  await act(async () => root.unmount());
});
