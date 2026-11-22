import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { projectNamesForFolder } from "./folder-project.js";

const folder = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  folderId: "main",
  originatingDeploymentId: "deployment",
  originatingDeviceId: "device",
  originatingProfileId: "profile",
  directoryIncarnationId: "lifetime"
};
const rule = (target: unknown, removedAt: string | null = null) => ({
  inclusionId: "00000000-0000-4000-8000-000000000010",
  projectId: "00000000-0000-4000-8000-000000000020",
  target,
  version: 1,
  headRevisionId: "00000000-0000-4000-8000-000000000030",
  removedAt
});
const project = (name: string | null, rules: unknown[]) =>
  ({
    id: name ?? "auto",
    name: name ?? "auto",
    ...(name ? { namedProject: { projectId: "p", name, version: 1 } } : {}),
    inclusionRules: rules
  }) as unknown as DesktopProject;

describe("projectNamesForFolder", () => {
  it("returns the named Projects with an active rule for exactly this Folder", () => {
    const projects = [
      project("Koed", [rule({ kind: "folder", folder })]),
      project("Other", [
        rule({ kind: "folder", folder: { ...folder, folderId: "other" } })
      ])
    ];
    expect(projectNamesForFolder(projects, folder)).toEqual(["Koed"]);
  });

  it("also names a Project built on the Folder itself, and only that exact Folder", () => {
    const own = {
      id: "koed",
      name: "koed",
      folder: { reference: folder },
      inclusionRules: []
    } as unknown as DesktopProject;
    const other = {
      id: "other",
      name: "other",
      folder: { reference: { ...folder, folderId: "other" } },
      inclusionRules: []
    } as unknown as DesktopProject;
    expect(projectNamesForFolder([own, other], folder)).toEqual(["koed"]);
  });

  it("ignores removed rules, repository rules, and unnamed groups", () => {
    const projects = [
      project("Gone", [
        rule({ kind: "folder", folder }, "2026-11-01T00:00:00.000Z")
      ]),
      project("Repo", [rule({ kind: "repository", repository: {} })]),
      project(null, [rule({ kind: "folder", folder })])
    ];
    expect(projectNamesForFolder(projects, folder)).toEqual([]);
  });

  it("lists each Project once, in order", () => {
    const both = [
      project("A", [rule({ kind: "folder", folder })]),
      project("B", [rule({ kind: "folder", folder })]),
      project("A", [rule({ kind: "folder", folder })])
    ];
    expect(projectNamesForFolder(both, folder)).toEqual(["A", "B"]);
  });
});
