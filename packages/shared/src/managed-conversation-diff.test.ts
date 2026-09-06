import { describe, expect, it } from "vitest";

import { managedConversationDiffSchema } from "./managed-conversation-diff.js";

describe("managed Conversation diff contract", () => {
  const value = {
    executionId: "11111111-1111-4111-8111-111111111111",
    executionGeneration: 2,
    scope: "full" as const,
    scopeKey: "full",
    fromCheckpointId: "11111111-1111-4111-8111-111111111111",
    toCheckpointId: "22222222-2222-4222-8222-222222222222",
    revisionDigest: "a".repeat(64),
    complete: true,
    truncated: false,
    fileCount: 1,
    byteCount: 42,
    diff: {
      fromCommitObjectId: "1".repeat(40),
      toCommitObjectId: "2".repeat(40),
      complete: true,
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          binary: false,
          patch: "@@ -1 +1 @@",
          patchTruncated: false
        }
      ],
      fileCount: 1,
      returnedFileCount: 1,
      byteCount: 42,
      truncated: false,
      continuation: null,
      revisionDigest: "a".repeat(64)
    }
  };

  it("accepts bounded exact diffs and rejects hidden path additions", () => {
    expect(managedConversationDiffSchema.parse(value)).toEqual(value);
    expect(() =>
      managedConversationDiffSchema.parse({
        ...value,
        workspacePath: "/private/repo"
      })
    ).toThrow();
    expect(() =>
      managedConversationDiffSchema.parse({
        ...value,
        diff: {
          ...value.diff,
          files: [{ ...value.diff.files[0], path: "../secret" }]
        }
      })
    ).toThrow();
  });
});
