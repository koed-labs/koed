// @vitest-environment happy-dom

import type {
  CollaborationSnapshot,
  CollaborationThread
} from "@koed/shared/collaboration";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxModelFromSnapshot } from "./inbox-model.js";
import { InboxView } from "./InboxView.js";

const thread = (
  id: string,
  scope: "personal" | "team",
  kind: string,
  name: string | null,
  unreadCount: number
) =>
  ({
    id,
    scope,
    kind,
    name,
    unreadCount,
    participants: [{ id: "person-a", displayName: "Ari" }]
  }) as unknown as CollaborationThread;

const snapshotFixture = (): CollaborationSnapshot =>
  ({
    connection: {
      state: "unavailable",
      backendId: "backend-a",
      connectedAt: null,
      retryAt: null,
      reconnectAttempt: 2,
      protocolVersion: 1
    },
    navigation: {
      personalOwner: { id: "personal-a", displayName: "Personal" },
      teamPrincipal: { id: "team-user-a", displayName: "Ari" },
      personal: {
        notesToSelf: {
          ...thread("notes", "personal", "notes_to_self", null, 0),
          ownerUserId: "personal-a"
        },
        channels: [
          {
            ...thread(
              "personal-thread",
              "personal",
              "personal_channel",
              "Ideas",
              2
            ),
            ownerUserId: "personal-a"
          }
        ],
        memory: []
      },
      teams: [
        {
          id: "team-a",
          name: "Design",
          directMessages: [
            {
              ...thread("dm-thread", "team", "dm", null, 1),
              teamId: "team-a"
            }
          ],
          workspaces: [
            {
              id: "workspace-a",
              name: "Desktop",
              channels: [
                {
                  ...thread(
                    "channel-thread",
                    "team",
                    "workspace_channel",
                    "ship-room",
                    4
                  ),
                  teamId: "team-a",
                  workspaceId: "workspace-a"
                }
              ],
              sharedMemory: [
                {
                  id: "shared-a",
                  title: "UI review",
                  teamId: "team-a",
                  workspaceId: "workspace-a",
                  companionThreadId: "companion-a",
                  unreadCompanionCount: 3,
                  maximumFidelity: "memory_events",
                  includeCuratedMemory: false,
                  sourceState: "unavailable"
                },
                {
                  id: "pending-a",
                  title: "Pending sync",
                  teamId: "team-a",
                  workspaceId: "workspace-a",
                  companionThreadId: "companion-pending",
                  unreadCompanionCount: 0,
                  maximumFidelity: "lcm_leaves",
                  includeCuratedMemory: false,
                  sourceState: "loading"
                }
              ]
            }
          ]
        }
      ]
    },
    outbox: [
      {
        clientMessageId: "queued-a",
        authority: {
          scope: "personal",
          ownerUserId: "personal-a",
          threadId: "personal-thread"
        },
        body: "Authorized but not shown as an Inbox preview",
        state: "queued",
        retryable: true,
        removalSupported: false,
        failure: null
      },
      {
        clientMessageId: "failed-a",
        authority: {
          scope: "team",
          backendId: "backend-a",
          principalUserId: "team-user-a",
          teamId: "team-a",
          workspaceId: "workspace-a",
          threadId: "channel-thread"
        },
        body: "Failed body",
        state: "manual_retry",
        retryable: true,
        removalSupported: false,
        failure: { userMessage: "Connection unavailable" }
      },
      {
        clientMessageId: "stale-authority",
        authority: {
          scope: "team",
          backendId: "another-backend",
          principalUserId: "team-user-a",
          teamId: "team-a",
          workspaceId: "workspace-a",
          threadId: "channel-thread"
        },
        body: "Must be purged",
        state: "queued",
        retryable: true,
        removalSupported: false,
        failure: null
      }
    ]
  }) as unknown as CollaborationSnapshot;

describe("InboxView", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("derives only authorized unread, durable outbox, faults, and conflicts", () => {
    const model = inboxModelFromSnapshot(snapshotFixture());

    expect(model.unread.map(({ title }) => title)).toEqual([
      "Ideas",
      "Ari",
      "ship-room",
      "UI review discussion"
    ]);
    expect(model.queuedOutbox).toHaveLength(1);
    expect(model.failedOutbox).toHaveLength(1);
    expect(model.connectionFaults).toHaveLength(1);
    expect(model.sharedMemoryConflicts.map(({ title }) => title)).toEqual([
      "UI review"
    ]);
  });

  it("does not claim mentions, tasks, or manufacture message previews", async () => {
    await act(async () =>
      root.render(
        <InboxView
          onOpenPreferences={vi.fn()}
          onOpenSelection={vi.fn()}
          snapshot={snapshotFixture()}
        />
      )
    );

    expect(container.textContent).not.toContain("mention");
    expect(container.textContent).not.toContain("task");
    expect(container.textContent).not.toContain(
      "Authorized but not shown as an Inbox preview"
    );
    expect(container.textContent).not.toContain("Must be purged");
    expect(container.textContent).toContain("Message needs retry in ship-room");
  });

  it("copies outbox text through the trusted callback without rendering it", async () => {
    const onCopyOutbox = vi.fn();
    await act(async () =>
      root.render(
        <InboxView
          onCopyOutbox={onCopyOutbox}
          onOpenPreferences={vi.fn()}
          onOpenSelection={vi.fn()}
          snapshot={snapshotFixture()}
        />
      )
    );
    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy message text"]'
    );
    expect(copy).not.toBeNull();
    await act(async () => copy!.click());
    expect(onCopyOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: "failed-a" })
    );
    expect(container.textContent).not.toContain("Failed body");
    expect(container.textContent).toContain(
      "retained until delivered or authority is lost"
    );
  });

  it("renders explicit loading and unavailable states", async () => {
    await act(async () =>
      root.render(
        <InboxView
          loading
          onOpenPreferences={vi.fn()}
          onOpenSelection={vi.fn()}
          snapshot={null}
        />
      )
    );
    expect(container.textContent).toContain("Loading authorized Inbox state");

    await act(async () =>
      root.render(
        <InboxView
          error="Authorization state could not be loaded."
          onOpenPreferences={vi.fn()}
          onOpenSelection={vi.fn()}
          onRefresh={vi.fn()}
          snapshot={null}
        />
      )
    );
    expect(container.textContent).toContain("Inbox unavailable");
    expect(container.textContent).toContain(
      "Authorization state could not be loaded."
    );
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).not.toContain("Try again");
    expect(container.querySelector("button svg")).toBeNull();
  });
});
