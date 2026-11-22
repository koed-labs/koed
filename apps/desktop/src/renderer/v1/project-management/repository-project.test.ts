import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  projectNamesForRepository,
  repositoryTargetFor
} from "./repository-project.js";

const repository = {
  kind: "portable_repository",
  key: "gr_lyons",
  root: null,
  branch: null,
  reason: "origin",
  checkoutId: null,
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "github.com/diffhq/lyons-mouth"
};
const group = (extra: Record<string, unknown>) =>
  ({
    id: "g",
    name: "lyons-mouth",
    path: null,
    eventCount: 1,
    threads: [],
    ...extra
  }) as unknown as DesktopProject;

describe("repository Projects", () => {
  it("finds the Git Anchor a Project uses by its portable key", () => {
    const projects = [group({ repository })];
    expect(repositoryTargetFor(projects, "gr_lyons")?.repository.key).toBe(
      "gr_lyons"
    );
    expect(projectNamesForRepository(projects, "gr_lyons")).toEqual([
      "lyons-mouth"
    ]);
  });

  it("returns nothing for a key no Project uses, so there is nothing to select", () => {
    const projects = [group({ repository })];
    expect(repositoryTargetFor(projects, "gr_other")).toBeUndefined();
    expect(projectNamesForRepository(projects, "gr_other")).toEqual([]);
    expect(projectNamesForRepository([], "gr_lyons")).toEqual([]);
  });

  it("names one destination when a Project is built on the anchor's address and another uses it by name", () => {
    const projects = [
      group({ id: "a", name: "github.com/diffhq/lyons-mouth", repository }),
      group({
        id: "b",
        name: "lyons-mouth",
        namedProject: { projectId: "p", name: "lyons-mouth", version: 1 },
        inclusionRules: [
          {
            inclusionId: "r",
            projectId: "p",
            target: { kind: "repository", repository },
            version: 1,
            headRevisionId: "h",
            removedAt: null
          }
        ]
      })
    ];
    expect(projectNamesForRepository(projects, "gr_lyons")).toEqual([
      "lyons-mouth"
    ]);
    // Only the address is known: keep it rather than show nothing.
    expect(projectNamesForRepository([projects[0]!], "gr_lyons")).toEqual([
      "github.com/diffhq/lyons-mouth"
    ]);
  });
});
