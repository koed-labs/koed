import { describe, expect, it } from "vitest";
import type { RepositoryIdentity } from "@koed/shared";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import type { DesktopProject } from "../../project-memory-ui.js";
import { recallProjectLabel } from "./recall-project-label.js";

const repository: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_example",
  originatingDeviceId: "device_one",
  root: "/code/koed",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_one",
  selectedRemote: "origin",
  anchorDisplay: "github.com/koed-labs/koed"
};
const project = (overrides: Partial<DesktopProject> = {}): DesktopProject => ({
  id: repositoryScopeId(repository),
  name: "koed",
  path: "/code/koed",
  repository,
  threads: [],
  eventCount: 0,
  catalogued: true,
  discoveredAt: null,
  lastSeenAt: null,
  localProjectId: "local_one",
  branch: "main",
  remoteDisplay: repository.anchorDisplay,
  isWorktree: false,
  ...overrides
});

describe("Recall project labels", () => {
  it("uses the sidebar inventory name instead of a recorded serialized repository identifier", () => {
    const id = repositoryScopeId(repository);
    expect(
      recallProjectLabel({ projectId: id, projectName: id }, [project()])
    ).toBe("koed");
    expect(
      recallProjectLabel({ projectId: id, projectName: "Old name" }, [
        project({ name: "Renamed project" })
      ])
    ).toBe("Renamed project");
  });

  it("resolves a local checkout alias through its merged project", () => {
    expect(
      recallProjectLabel({ projectId: "local_two", projectName: null }, [
        project({
          checkouts: [
            { localProjectId: "local_two", path: "/worktree/koed", repository }
          ]
        })
      ])
    ).toBe("koed");
  });

  it("resolves repository metadata without treating a Git Anchor as a named Project membership", () => {
    const named = project({
      id: "named_research",
      name: "Research",
      namedProject: {
        projectId: "named_research"
      } as DesktopProject["namedProject"]
    });
    expect(
      recallProjectLabel(
        { projectId: repositoryScopeId(repository), projectName: null },
        [named]
      )
    ).toBe("koed-labs/koed");
    expect(
      recallProjectLabel({ projectId: "named_research", projectName: null }, [
        named
      ])
    ).toBe("Research");
  });

  it("keeps device-local repository identities separate", () => {
    const local = { ...repository, kind: "device_local_repository" as const };
    const elsewhere = { ...local, originatingDeviceId: "device_two" };
    expect(
      recallProjectLabel(
        { projectId: repositoryScopeId(elsewhere), projectName: null },
        [project({ id: repositoryScopeId(local), repository: local })]
      )
    ).toBeNull();
  });

  it("retains meaningful historical names and never exposes an unresolved serialized scope as a label", () => {
    const id = repositoryScopeId(repository);
    expect(
      recallProjectLabel({ projectId: id, projectName: "Archived project" }, [])
    ).toBe("Archived project");
    expect(
      recallProjectLabel({ projectId: id, projectName: id }, [])
    ).toBeNull();
    expect(
      recallProjectLabel({ projectId: null, projectName: null }, [])
    ).toBeNull();
  });
});
