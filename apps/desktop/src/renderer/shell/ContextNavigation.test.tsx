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
          onSelectChannel={vi.fn()}
          projectsSelected
        />
      )
    );
    expect(container.textContent).toContain("Private to you");
    expect(container.textContent).toContain("Ask Memory");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Archived");
    expect(
      container.querySelector('[aria-current="page"]')?.textContent
    ).toContain("Projects");
  });

  it("renders Team, Workspace, channel, DM, People, and Shared Memory hierarchy", async () => {
    const onSelectChannel = vi.fn();
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
              channels: [{ id: "channel", label: "product", selected: true }],
              id: "workspace",
              label: "Engineering",
              selected: true,
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
  });
});
