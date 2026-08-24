import { describe, expect, it } from "vitest";

import { managedConversationFileOperationSchema } from "./managed-conversation-files.js";

describe("managed Conversation file contract", () => {
  it("accepts bounded normalized root-relative operations", () => {
    expect(
      managedConversationFileOperationSchema.parse({
        kind: "browse",
        path: "src/components"
      })
    ).toMatchObject({
      kind: "browse",
      path: "src/components",
      offset: 0,
      limit: 200,
      revision: null
    });
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src\\secret",
    "src//secret",
    "src:secret",
    "src/./secret",
    "src/e\u0301.ts",
    "file:///etc/passwd",
    "src/CON.txt",
    "src/trailing.",
    "src/trailing ",
    "src/control\u0001.ts",
    `src/${"a".repeat(256)}`
  ])("rejects an unsafe or ambiguous path: %s", (path) => {
    expect(() =>
      managedConversationFileOperationSchema.parse({ kind: "read", path })
    ).toThrow();
  });
});
