// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PersonalContextNavigation,
  TeamContextNavigation
} from "./ContextNavigation.js";

describe("context navigation", () => {
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

  it("labels Personal trust and keeps unsupported Memory actions honest", async () => {
    await act(async () =>
      root.render(
        <PersonalContextNavigation
          channels={[
            {
              id: "active",
              label: "scratch",
              selected: false,
              unreadCount: 2
            },
            {
              archived: true,
              id: "archived",
              label: "old",
              selected: false
            }
          ]}
          notesSelected={false}
          onCreateChannel={vi.fn()}
          onOpenNotes={vi.fn()}
          onOpenProjects={vi.fn()}
          onOpenShares={vi.fn()}
          onSelectChannel={vi.fn()}
          projectsSelected
          sharesSelected={false}
        />
      )
    );
    expect(container.textContent).toContain("Private to you");
    expect(container.textContent).toContain("Ask Memory");
    expect(container.textContent).toContain("Shares");
    expect(container.textContent).not.toContain("Unavailable");
    expect(container.textContent).toContain("Channels");
    expect(container.textContent).toContain("Archived");
    expect(
      container.querySelector('[aria-current="page"]')?.textContent
    ).toContain("Projects");
  });

  it("mutes unavailable Shares without disabling navigation", async () => {
    const onOpenShares = vi.fn();
    await act(async () =>
      root.render(
        <PersonalContextNavigation
          channels={[]}
          notesSelected={false}
          onCreateChannel={vi.fn()}
          onOpenNotes={vi.fn()}
          onOpenProjects={vi.fn()}
          onOpenShares={onOpenShares}
          onSelectChannel={vi.fn()}
          projectsSelected={false}
          sharesSelected
          sharesUnavailable
        />
      )
    );

    const shares = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Shares"
    ) as HTMLButtonElement;
    expect(shares.dataset.unavailable).toBe("true");
    expect(shares.disabled).toBe(false);

    await act(async () => shares.click());
    expect(onOpenShares).toHaveBeenCalledOnce();
  });

  it("renders Team, Workspace, channel, DM, People, and Shared Memory hierarchy", async () => {
    const onSelectChannel = vi.fn();
    const onCreateChannel = vi.fn();
    const onCreateWorkspace = vi.fn();
    await act(async () =>
      root.render(
        <TeamContextNavigation
          directMessages={[
            {
              id: "dm",
              label: "Alice",
              selected: false,
              unreadCount: 1
            }
          ]}
          onCreateChannel={onCreateChannel}
          onCreateWorkspace={onCreateWorkspace}
          onOpenPeople={vi.fn()}
          onOpenSharedMemory={vi.fn()}
          onSelectChannel={onSelectChannel}
          onSelectDirectMessage={vi.fn()}
          onStartDirectMessage={vi.fn()}
          peopleSelected={false}
          role="Member"
          teamName="Koed Labs"
          workspaces={[
            {
              canCreateChannel: true,
              channels: [{ id: "channel", label: "product", selected: true }],
              id: "workspace",
              label: "Engineering",
              selected: true,
              sharedMemorySelected: false
            },
            {
              canCreateChannel: false,
              channels: [],
              id: "read-only-workspace",
              label: "Read only",
              selected: false,
              sharedMemorySelected: false
            }
          ]}
        />
      )
    );
    expect(container.textContent).toContain("Koed Labs");
    expect(container.textContent).toContain("People");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).toContain("product");
    expect(container.textContent).toContain("Shared Memory");

    await act(async () => {
      (
        [...container.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("product")
        ) as HTMLButtonElement
      ).click();
    });
    expect(onSelectChannel).toHaveBeenCalledWith("workspace", "channel");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Create Workspace"]')
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Create channel in Engineering"]'
        )
        ?.click();
    });
    expect(onCreateWorkspace).toHaveBeenCalledOnce();
    expect(onCreateChannel).toHaveBeenCalledWith("workspace");
    expect(
      container.querySelector('[aria-label="Create channel in Read only"]')
    ).toBeNull();
  });

  it("shows why a Team member cannot create a Workspace", async () => {
    await act(async () =>
      root.render(
        <TeamContextNavigation
          directMessages={[]}
          onOpenPeople={vi.fn()}
          onOpenSharedMemory={vi.fn()}
          onSelectChannel={vi.fn()}
          onSelectDirectMessage={vi.fn()}
          onStartDirectMessage={vi.fn()}
          peopleSelected={false}
          role="member"
          teamName="Koed Labs"
          workspaces={[]}
        />
      )
    );
    const createWorkspace = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create Workspace"]'
    );
    expect(
      container.querySelector(".desktop-sidebar-header small")?.textContent
    ).toBe("Member");
    expect(createWorkspace?.disabled).toBe(true);
    expect(createWorkspace?.title).toContain("owners and administrators");
  });
});
