import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  resolveHqCitationMessageTarget,
  type HqCitationMessageTarget
} from "./hq-citation-message-target.js";

const target: HqCitationMessageTarget = {
  messageId: "message-1",
  sessionId: "session-1",
  projectId: "project-1",
  threadId: "thread-1"
};
const projects = [
  {
    id: "project-1",
    threads: [
      {
        id: "thread-1",
        sessionId: "session-1",
        projectId: "project-1",
        conversationTrashedAt: null
      }
    ]
  }
] as DesktopProject[];

describe("Personal citation message target", () => {
  it("opens only the exact visible captured Project, thread, and Session", () => {
    expect(resolveHqCitationMessageTarget(target, projects, new Set())).toEqual(
      {
        kind: "conversation",
        projectId: "project-1",
        sessionId: "session-1"
      }
    );
    for (const changed of [
      { projectId: "another-project" },
      { threadId: "another-thread" },
      { sessionId: "another-session" },
      { messageId: "" }
    ])
      expect(
        resolveHqCitationMessageTarget(
          { ...target, ...changed },
          projects,
          new Set()
        )
      ).toBeNull();
  });

  it("rejects blocked, trashed, absent, and ambiguous captured destinations", () => {
    expect(
      resolveHqCitationMessageTarget(
        target,
        projects,
        new Set(["project-1\u0000session-1"])
      )
    ).toBeNull();
    expect(resolveHqCitationMessageTarget(target, [], new Set())).toBeNull();
    expect(
      resolveHqCitationMessageTarget(
        target,
        [
          {
            ...projects[0]!,
            threads: [
              { ...projects[0]!.threads[0]!, conversationTrashedAt: "now" }
            ]
          }
        ],
        new Set()
      )
    ).toBeNull();
    expect(
      resolveHqCitationMessageTarget(
        target,
        [...projects, ...projects],
        new Set()
      )
    ).toBeNull();
  });
});
