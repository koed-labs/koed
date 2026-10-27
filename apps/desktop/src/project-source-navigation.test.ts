import { describe, expect, it } from "vitest";
import { personalFolderScopeId, repositoryScopeId } from "@koed/shared";
import { mergeProjectSources } from "./project-memory-ui.js";
import { createProjectSourceFixture } from "./project-source-fixture.js";
import {
  filterProjectSourceConversations,
  projectSourceOptions,
  projectExecutionFolders,
  systemConversationViews,
  projectSourceSearchText
} from "./project-source-navigation.js";

describe("Project source navigation", () => {
  it("keeps a named Project separate from its members' Git source even when optional reference metadata is absent", () => {
    const { groups, projectId, git } = createProjectSourceFixture();
    const named = groups.find((group) => group.id === projectId)!;
    delete named.projectReference;
    const source = groups.find((group) => group.id === repositoryScopeId(git))!;
    const before = structuredClone(source);
    const first = mergeProjectSources(groups, []),
      second = mergeProjectSources(groups, []);
    expect(first.find((group) => group.id === projectId)?.threads).toHaveLength(
      4
    );
    expect(
      second.find((group) => group.id === repositoryScopeId(git))?.threads
    ).toHaveLength(3);
    expect(source).toEqual(before);
    expect(source.threads.every((thread) => !thread.membershipReasons)).toBe(
      true
    );
  });

  it("intersects exact Folders with current membership, exclusions and the selected anchor in mixed history", () => {
    const { project, inventory, first, git, threads } =
      createProjectSourceFixture();
    expect(project.threads).toHaveLength(4);
    const exact = {
      kind: "folder" as const,
      key: personalFolderScopeId(first.reference)
    };
    expect(
      filterProjectSourceConversations(project, exact, inventory).map(
        (thread) => thread.id
      )
    ).toEqual([threads.one.id, threads.direct.id]);
    expect(
      filterProjectSourceConversations(
        project,
        { ...exact, gitKey: repositoryScopeId(git) },
        inventory
      ).map((thread) => thread.id)
    ).toEqual([threads.one.id]);
    expect(
      filterProjectSourceConversations(
        project,
        { kind: "direct" },
        inventory
      ).map((thread) => thread.id)
    ).toEqual([threads.direct.id]);
    expect(
      filterProjectSourceConversations(
        project,
        { kind: "folder", key: "missing" },
        inventory
      )
    ).toEqual([]);
    const options = projectSourceOptions(project, inventory);
    expect(
      options.find(
        (source) =>
          source.filter.kind === "git" &&
          source.filter.key === repositoryScopeId(git)
      )?.children
    ).toHaveLength(2);
    expect(projectSourceSearchText(project, inventory)).toContain(
      "/remote/koed"
    );
  });
  it("offers concrete local choices only for matching future source rules, without granting remote, equal-path or direct-only execution", () => {
    const { project, inventory, second } = createProjectSourceFixture();
    expect(
      projectExecutionFolders(project, inventory).map((choice) => choice.path)
    ).toEqual(["/local/koed", "/local/notes"]);
    const remote = {
      ...inventory.folders.find(
        (group) =>
          group.folder?.reference.folderId === second.reference.folderId
      )!
    };
    expect(projectExecutionFolders(remote, inventory)).toEqual([]);
    const equalPath = {
      ...remote,
      folder: { ...remote.folder!, normalizedPath: "/local/koed" }
    };
    expect(projectExecutionFolders(equalPath, inventory)).toEqual([]);
    expect(
      projectExecutionFolders({ ...project, inclusionRules: [] }, inventory)
    ).toEqual([]);
    expect(
      projectExecutionFolders(project, { ...inventory, localFolders: [] })
    ).toEqual([]);
  });
  it("deduplicates overlapping source views while keeping unassigned, independent and unresolved Conversations reachable", () => {
    const { inventory, threads } = createProjectSourceFixture();
    const views = systemConversationViews(inventory);
    expect(new Set(views.available.map((thread) => thread.id))).toEqual(
      new Set([
        threads.excluded.id,
        threads.independent.id,
        threads.unresolved.id
      ])
    );
    expect(views.independent.map((thread) => thread.id)).toEqual([
      threads.independent.id
    ]);
    expect(views.unresolved.map((thread) => thread.id)).toEqual([
      threads.unresolved.id
    ]);
  });
});
