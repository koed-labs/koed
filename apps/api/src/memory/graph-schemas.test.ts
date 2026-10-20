import { describe, expect, it } from "vitest";

import {
  graphThreadIndexResponseSchema,
  graphQuerySchema,
  graphNodesQuerySchema,
  graphEventDetailQuerySchema,
  memoryBrowserQuerySchema,
  expandMemoryNodeQuerySchema
} from "./graph-schemas.js";

describe("graph thread index response schema", () => {
  it("carries an exact Personal selection through expansion and rejects Team or malformed copies", () => {
    const selection = {
      version: 0,
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      target: { kind: "global" },
      callerRepositoryContext: null
    };
    expect(
      expandMemoryNodeQuerySchema.parse({
        personal_selection: JSON.stringify(selection)
      }).personal_selection
    ).toEqual(selection);
    expect(() =>
      expandMemoryNodeQuerySchema.parse({
        personal_selection: JSON.stringify(selection),
        team_workspace_id: "00000000-0000-4000-8000-000000000002"
      })
    ).toThrow("Personal selection cannot");
    for (const value of [
      "{",
      JSON.stringify({ ...selection, version: 99 }),
      "x".repeat(32769)
    ])
      expect(() =>
        expandMemoryNodeQuerySchema.parse({ personal_selection: value })
      ).toThrow();
    expect(() =>
      expandMemoryNodeQuerySchema.parse({ recall_target: { kind: "folder" } })
    ).toThrow();
    expect(() =>
      expandMemoryNodeQuerySchema.parse({ personalSelection: selection })
    ).toThrow();
  });
  it("preserves inspection selections and rejects malformed or unsupported selector keys", () => {
    const selection = {
      version: 0,
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      target: { kind: "global" },
      callerRepositoryContext: null
    };
    for (const schema of [
      graphQuerySchema,
      graphNodesQuerySchema,
      graphEventDetailQuerySchema,
      memoryBrowserQuerySchema
    ]) {
      expect(
        schema.parse({ personalSelection: JSON.stringify(selection) })
          .personalSelection
      ).toEqual(selection);
      for (const invalid of [
        { personalSelection: "{" },
        { personalSelection: { ...selection, version: 99 } },
        { personal_selection: selection },
        { recall_target: { kind: "global" } }
      ])
        expect(() => schema.parse(invalid)).toThrow();
    }
  });
  it("retains direct inclusions even when the selected Conversation list is empty", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const membership = {
      inclusionId: id,
      projectId: id,
      logicalSessionId: id,
      sourceReference: null,
      version: 1,
      headRevisionId: id,
      removedAt: null
    };
    const result = graphThreadIndexResponseSchema.parse({
      projects: [
        {
          id,
          name: "Release",
          path: null,
          eventCount: 0,
          threads: [],
          directInclusions: [membership]
        }
      ]
    });
    expect(result.projects[0]!.directInclusions).toEqual([membership]);
  });
  it("accepts Pi as the source AI Client for captured threads", () => {
    expect(() =>
      graphThreadIndexResponseSchema.parse({
        projects: [
          {
            id: "project-1",
            name: "Project",
            path: "/tmp/project",
            eventCount: 2,
            threads: [
              {
                id: "thread-1",
                name: "Pi Conversation",
                sessionId: "00000000-0000-4000-8000-000000000001",
                sourceAiClient: "pi",
                projectId: "project-1",
                projectName: "Project",
                projectPath: "/tmp/project",
                projectAssignmentSource: "detected",
                capturedProjectProvenance: {},
                eventCount: 2,
                invalidatedCount: 0,
                latestAt: "2026-08-18T10:34:59.308Z",
                sample: "Captured from Pi",
                threadKind: "conversation",
                parentThreadId: null,
                parentSessionId: null,
                presentation: null
              }
            ]
          }
        ]
      })
    ).not.toThrow();
  });
});
