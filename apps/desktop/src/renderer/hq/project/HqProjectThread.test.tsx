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
  const navigation = { teams: [{ id: teamId, name: "Koed team", people: [] }] };
  const collaboration = { navigation };
  const client = {
    current: () => collaboration,
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
  expect(
    container.querySelector(".hq-project-thread__notice")?.textContent
  ).toContain("Visible to Koed team");
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

it("sends a quoted reply, dismisses it with Escape or ×, and jumps to an older original", async () => {
  const project = id("7054");
  const originalId = id("7071");
  const replyId = id("7072");
  const message = (
    messageId: string,
    sequence: number,
    body: string,
    replyToMessageId: string | null
  ) => ({
    id: messageId,
    threadId: id("7056"),
    scope: "team",
    teamId,
    sequence,
    sender: { id: id("7057"), displayName: "Maya", membershipState: "enabled" },
    senderKind: "user",
    body,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    delivery: "sent",
    recipientStatus: "sent",
    failure: null,
    replyToMessageId,
    mentionsUserIds: []
  });
  const original = message(originalId, 1, "First line\nsecond line", null);
  const reply = message(replyId, 2, "Reply body", originalId);
  const loadProjectThreadMessagesV2 = vi.fn(
    async ({ cursor }: { cursor: string | null }) =>
      cursor
        ? {
            threadId: id("7056"),
            items: [original],
            hasOlder: false,
            olderCursor: null
          }
        : {
            threadId: id("7056"),
            items: [reply],
            hasOlder: true,
            olderCursor: "older-page"
          }
  );
  const sendProjectThreadMessageV2 = vi.fn(async () => ({ id: id("7073") }));
  let onRealtime!: (event: unknown) => void;
  const client = {
    current: () => null,
    subscribe: () => () => undefined,
    openProjectThreadV2: vi.fn(async () => threadFor(project)),
    loadProjectThreadMessagesV2,
    subscribeProjectThreadV2: vi.fn(
      async (_input: unknown, listener: (event: unknown) => void) => {
        onRealtime = listener;
        return () => undefined;
      }
    ),
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
        active
        portalHost={container}
      />
    );
  });
  const replyButton = () =>
    container.querySelector<HTMLButtonElement>(".hq-project-thread__reply");
  const chip = () =>
    container.querySelector<HTMLElement>(".hq-project-thread__reply-chip");
  await act(async () => replyButton()?.click());
  expect(chip()?.textContent).toContain("Replying to Maya: Reply body");
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  expect(chip()).toBeNull();
  await act(async () => replyButton()?.click());
  await act(async () => chip()?.querySelector("button")?.click());
  expect(chip()).toBeNull();
  await act(async () => replyButton()?.click());
  const setText = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setText?.call(container.querySelector("textarea"), "Answer to Maya");
    container
      .querySelector("textarea")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".hq-project-thread__send")
      ?.click()
  );
  expect(sendProjectThreadMessageV2).toHaveBeenCalledWith(
    expect.objectContaining({
      teamId,
      workspaceProjectId: project,
      threadId: id("7056"),
      replyToMessageId: replyId,
      body: "Answer to Maya"
    })
  );
  expect(chip()).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".hq-project-thread__quote")
      ?.click()
  );
  expect(loadProjectThreadMessagesV2).toHaveBeenCalledWith(
    expect.objectContaining({
      teamId,
      workspaceProjectId: project,
      threadId: id("7056"),
      cursor: "older-page"
    })
  );
  expect(
    container.querySelector<HTMLElement>(`[data-message-id="${originalId}"]`)
  ).toBe(document.activeElement);
  expect(
    container.querySelector(".hq-project-thread__quote")?.textContent
  ).toContain("First line second line");
  await act(async () => replyButton()?.click());
  await act(async () =>
    onRealtime({
      type: "project_thread_v2_control",
      threadId: id("7056"),
      reason: "access_revoked"
    })
  );
  expect(chip()).toBeNull();
  expect(container.querySelector(".hq-project-thread__message")).toBeNull();
  await act(async () => root.unmount());
});

it("keeps a newly selected reply when an earlier send completes", async () => {
  const project = id("7054");
  const firstId = id("7074");
  const secondId = id("7075");
  let finishSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => {
    finishSend = resolve;
  });
  const client = {
    current: () => null,
    subscribe: () => () => undefined,
    openProjectThreadV2: vi.fn(async () => threadFor(project)),
    loadProjectThreadMessagesV2: vi.fn(async () => ({
      threadId: id("7056"),
      items: [firstId, secondId].map((messageId, index) => ({
        id: messageId,
        threadId: id("7056"),
        scope: "team",
        teamId,
        sequence: index + 1,
        sender: {
          id: id("7057"),
          displayName: index ? "Lee" : "Maya",
          membershipState: "enabled"
        },
        senderKind: "user",
        body: index ? "Second message" : "First message",
        createdAt: "2026-10-20T12:00:00.000Z",
        updatedAt: "2026-10-20T12:00:00.000Z",
        editedAt: null,
        deletedAt: null,
        delivery: "sent",
        recipientStatus: "sent",
        failure: null,
        replyToMessageId: null,
        mentionsUserIds: []
      })),
      hasOlder: false,
      olderCursor: null
    })),
    subscribeProjectThreadV2: vi.fn(async () => () => undefined),
    markProjectThreadReadV2: vi.fn(),
    sendProjectThreadMessageV2: vi.fn(async () => {
      await pendingSend;
    })
  } as unknown as CollaborationRendererClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <HqProjectThread
        client={client}
        sharedProjectStore={storeFor(identityFor("profile-a", project))}
        identity={identityFor("profile-a", project)}
        active
        portalHost={container}
      />
    )
  );
  const replyButtons = () =>
    container.querySelectorAll<HTMLButtonElement>(".hq-project-thread__reply");
  await act(async () => replyButtons()[0]?.click());
  const setText = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setText?.call(
      container.querySelector("textarea"),
      "Draft stays while target changes"
    );
    container
      .querySelector("textarea")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(".hq-project-thread__send")
      ?.click();
  });
  await act(async () => replyButtons()[1]?.click());
  await act(async () => {
    finishSend();
    await pendingSend;
  });
  expect(
    container.querySelector(".hq-project-thread__reply-chip")?.textContent
  ).toContain("Replying to Lee");
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "Draft stays while target changes"
  );
  await act(async () => root.unmount());
});

it("ignores an older quote page after the Project identity changes", async () => {
  const firstProject = id("7053");
  const secondProject = id("7054");
  const originalId = id("7076");
  let finishOlder!: (page: unknown) => void;
  const olderPage = new Promise((resolve) => {
    finishOlder = resolve;
  });
  const reply = {
    id: id("7077"),
    threadId: id("7055"),
    scope: "team",
    teamId,
    sequence: 2,
    sender: { id: id("7057"), displayName: "Maya", membershipState: "enabled" },
    senderKind: "user",
    body: "Reply to an earlier message",
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    delivery: "sent",
    recipientStatus: "sent",
    failure: null,
    replyToMessageId: originalId,
    mentionsUserIds: []
  };
  const client = {
    current: () => null,
    subscribe: () => () => undefined,
    openProjectThreadV2: vi.fn(
      async ({ workspaceProjectId }: { workspaceProjectId: string }) =>
        threadFor(workspaceProjectId)
    ),
    loadProjectThreadMessagesV2: vi.fn(
      async ({
        workspaceProjectId,
        threadId,
        cursor
      }: {
        workspaceProjectId: string;
        threadId: string;
        cursor: string | null;
      }) =>
        cursor
          ? olderPage
          : {
              threadId,
              items: workspaceProjectId === firstProject ? [reply] : [],
              hasOlder: workspaceProjectId === firstProject,
              olderCursor:
                workspaceProjectId === firstProject ? "earlier" : null
            }
    ),
    subscribeProjectThreadV2: vi.fn(async () => () => undefined),
    markProjectThreadReadV2: vi.fn()
  } as unknown as CollaborationRendererClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (project: string) =>
    act(async () =>
      root.render(
        <HqProjectThread
          client={client}
          sharedProjectStore={storeFor(identityFor("profile-a", project))}
          identity={identityFor("profile-a", project)}
          active
          portalHost={container}
        />
      )
    );
  await render(firstProject);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".hq-project-thread__quote")
      ?.click()
  );
  await render(secondProject);
  await act(async () =>
    finishOlder({
      threadId: id("7055"),
      items: [{ ...reply, id: originalId, sequence: 1 }],
      hasOlder: false,
      olderCursor: null
    })
  );
  expect(
    container.querySelector(`[data-message-id="${originalId}"]`)
  ).toBeNull();
  expect(container.querySelector(".hq-project-thread__quote")).toBeNull();
  await act(async () => root.unmount());
});

it("labels the enrolled Team principal as yourself when Personal and Team IDs differ", async () => {
  const project = id("7054");
  const teamUserId = id("7078");
  const ownMessageId = id("7079");
  const messages = [
    {
      id: ownMessageId,
      sequence: 1,
      body: "My original message",
      replyToMessageId: null
    },
    {
      id: id("7080"),
      sequence: 2,
      body: "A reply",
      replyToMessageId: ownMessageId
    }
  ].map((message) => ({
    ...message,
    threadId: id("7056"),
    scope: "team",
    teamId,
    sender: {
      id: teamUserId,
      displayName: "Alex",
      membershipState: "enabled"
    },
    senderKind: "user",
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    delivery: "sent",
    recipientStatus: "sent",
    failure: null,
    mentionsUserIds: []
  }));
  const collaboration = {
    navigation: {
      personalOwner: { id: id("7058") },
      teamPrincipal: { id: teamUserId },
      teams: [
        {
          id: teamId,
          people: [
            {
              id: teamUserId,
              displayName: "Alex",
              membershipState: "enabled"
            }
          ]
        }
      ]
    }
  };
  const client = {
    current: () => collaboration,
    subscribe: () => () => undefined,
    openProjectThreadV2: vi.fn(async () => threadFor(project)),
    loadProjectThreadMessagesV2: vi.fn(async () => ({
      threadId: id("7056"),
      items: messages,
      hasOlder: false,
      olderCursor: null
    })),
    subscribeProjectThreadV2: vi.fn(async () => () => undefined),
    markProjectThreadReadV2: vi.fn()
  } as unknown as CollaborationRendererClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <HqProjectThread
        client={client}
        sharedProjectStore={storeFor(identityFor("profile-a", project))}
        identity={identityFor("profile-a", project)}
        active
        portalHost={container}
      />
    )
  );
  expect(
    container.querySelector(".hq-project-thread__quote strong")?.textContent
  ).toBe("You");
  const replyButton = container.querySelector<HTMLButtonElement>(
    `[data-message-id="${ownMessageId}"] .hq-project-thread__reply`
  );
  expect(replyButton?.getAttribute("aria-label")).toBe("Reply to your message");
  await act(async () => replyButton?.click());
  expect(
    container.querySelector(".hq-project-thread__reply-chip")?.textContent
  ).toContain("Replying to yourself");
  await act(async () => root.unmount());
});
