import { describe, expect, it } from "vitest";
import {
  aiClientResourceCatalogSchema,
  aiClientResourceDiscoveryOperationSchema,
  managedConversationSelectedResourceIdsSchema
} from "./ai-client-resource-catalog.js";

const scope = {
  version: 1 as const,
  provider: "codex" as const,
  aiClientInstanceId: "codex.work",
  hostedInstanceId: "hosted-computer-client",
  computerLabel: "MacBook Pro",
  projectId: "project-1",
  observedAt: "2026-10-02T10:00:00.000Z",
  expiresAt: "2026-10-02T10:05:00.000Z"
};

describe("AI Client resource catalog contract", () => {
  it("accepts safe scoped resources and native Skill selections", () => {
    const catalog = aiClientResourceCatalogSchema.parse({
      ...scope,
      resources: [
        {
          resourceId: `res_${"a".repeat(64)}`,
          kind: "skill",
          name: "review",
          description: "Review the selected Project.",
          status: "ready",
          source: "project",
          invocation: "native_skill"
        },
        {
          resourceId: `res_${"b".repeat(64)}`,
          kind: "plugin",
          name: "docs",
          status: "disabled",
          source: "user",
          invocation: null
        }
      ]
    });

    expect(catalog.resources.map(({ kind }) => kind)).toEqual([
      "skill",
      "plugin"
    ]);
    expect(
      managedConversationSelectedResourceIdsSchema.parse([
        catalog.resources[0]!.resourceId
      ])
    ).toHaveLength(1);
  });

  it("rejects paths, duplicate IDs, and Skill/non-Skill invocation mismatches", () => {
    const pathLeak = aiClientResourceCatalogSchema.safeParse({
      ...scope,
      resources: [
        {
          resourceId: `res_${"a".repeat(64)}`,
          kind: "skill",
          name: "review",
          path: "/Users/example/.claude/skills/review/SKILL.md",
          status: "ready",
          source: "user",
          invocation: "native_skill"
        }
      ]
    });
    const mismatch = aiClientResourceCatalogSchema.safeParse({
      ...scope,
      resources: [
        {
          resourceId: `res_${"a".repeat(64)}`,
          kind: "plugin",
          name: "docs",
          status: "ready",
          source: "user",
          invocation: "native_skill"
        }
      ]
    });

    expect(pathLeak.success).toBe(false);
    expect(mismatch.success).toBe(false);
  });

  it("binds completed operation catalogs to the requested computer and Project", () => {
    const result = aiClientResourceDiscoveryOperationSchema.safeParse({
      operationId: "00000000-0000-4000-8000-000000000001",
      requestId: "00000000-0000-4000-8000-000000000002",
      hostedInstanceId: "hosted-computer-client",
      projectId: "project-2",
      state: "completed",
      revision: 2,
      createdAt: scope.observedAt,
      updatedAt: scope.observedAt,
      catalog: { ...scope, resources: [] }
    });

    expect(result.success).toBe(false);
  });

  it("bounds and deduplicates selected resource IDs", () => {
    const first = `res_${"a".repeat(64)}`;
    expect(
      managedConversationSelectedResourceIdsSchema.safeParse([first, first])
        .success
    ).toBe(false);
    expect(
      managedConversationSelectedResourceIdsSchema.safeParse(
        Array.from(
          { length: 9 },
          (_, index) => `res_${index.toString(16).padStart(64, "0")}`
        )
      ).success
    ).toBe(false);
  });
});
