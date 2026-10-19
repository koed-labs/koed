import { describe, expect, it } from "vitest";
import { mergeProjectSources } from "../../project-memory-ui.js";
import { reconcileHqRoute, type HqRoute } from "./hq-navigation.js";

const project = (id: string, sessions: string[]) =>
  mergeProjectSources(
    [
      {
        id,
        name: id,
        path: null,
        eventCount: 0,
        threads: sessions.map((sessionId) => ({
          id: sessionId,
          sessionId,
          name: sessionId,
          projectId: id,
          projectName: id,
          eventCount: 0,
          invalidatedCount: 0,
          latestAt: "2026-10-19T10:00:00Z",
          sample: ""
        }))
      }
    ],
    []
  )[0]!;

describe("HQ selection reconciliation", () => {
  it.each(["project", "conversation"] as const)(
    "does not guess a %s successor when the retained sessions are ambiguous or missing",
    (kind) => {
      const retained = project("old", ["same-session"]);
      const route: HqRoute =
        kind === "project"
          ? { kind, projectId: "old" }
          : { kind, projectId: "old", sessionId: "same-session" };
      expect(
        reconcileHqRoute(route, retained, [
          project("one", ["same-session"]),
          project("two", ["same-session"])
        ])
      ).toBe(route);
      expect(
        reconcileHqRoute(route, retained, [
          project("unrelated", ["different-session"])
        ])
      ).toBe(route);
      expect(reconcileHqRoute(route, retained, [])).toBe(route);
    }
  );
  it("does not choose a partial successor after a Project splits", () => {
    const route = { kind: "project", projectId: "old" } as const;
    expect(
      reconcileHqRoute(route, project("old", ["one", "two"]), [
        project("first", ["one"]),
        project("second", ["two"])
      ])
    ).toBe(route);
  });
});
