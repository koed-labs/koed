import { describe, expect, it } from "vitest";

import { graphThreadIndexResponseSchema } from "./graph-schemas.js";

describe("graph thread index response schema", () => {
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
                parentSessionId: null
              }
            ]
          }
        ]
      })
    ).not.toThrow();
  });
});
