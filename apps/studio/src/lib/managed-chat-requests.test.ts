import { describe, expect, it } from "vitest";
import { pendingChatRequests } from "./managed-chat-requests";
import type { RuntimeSnapshot, RuntimeItem } from "./managed-agent-chat";

const item: RuntimeItem = {
  id: "request",
  executionGeneration: 1,
  itemKind: "command_approval",
  state: "pending",
  payload: {
    command: ["git", "status"],
    cwd: "/project",
    unrelatedSecret: "do-not-render"
  },
  presentation: { mode: "expanded", renderer: "approval" },
  answered: false
};
const snapshot = (items: RuntimeItem[]) => ({ items }) as RuntimeSnapshot;
describe("managed chat requests", () => {
  it("renders only authorized pending requests and known detail fields", () => {
    const requests = pendingChatRequests(snapshot([item]));
    expect(requests[0].details).toEqual([
      { label: "Command", text: "git status" },
      { label: "Working directory", text: "/project" }
    ]);
    expect(JSON.stringify(requests)).not.toContain("do-not-render");
  });
  it("does not revive hidden, answered, or missing-policy items", () => {
    expect(
      pendingChatRequests(
        snapshot([
          { ...item, presentation: { mode: "hidden", renderer: "approval" } },
          { ...item, answered: true },
          { ...item, state: "resolved" },
          { ...item, presentation: undefined }
        ])
      )
    ).toEqual([]);
  });
  it("does not display arbitrary tool arguments", () => {
    const requests = pendingChatRequests(
      snapshot([
        {
          ...item,
          payload: {
            toolName: "shell",
            input: { command: "git status", apiKey: "do-not-render" }
          }
        }
      ])
    );
    expect(JSON.stringify(requests)).toContain("git status");
    expect(JSON.stringify(requests)).not.toContain("do-not-render");
  });
  it("preserves secret and freeform input semantics", () => {
    const requests = pendingChatRequests(
      snapshot([
        {
          ...item,
          itemKind: "user_input",
          presentation: { mode: "expanded", renderer: "user_input" },
          payload: {
            questions: [
              {
                id: "key",
                question: "Enter key",
                required: false,
                isSecret: true,
                isOther: true,
                options: [{ label: "Skip" }]
              }
            ]
          }
        }
      ])
    );
    expect(requests[0].questions?.[0]).toMatchObject({
      id: "key",
      required: false,
      isSecret: true,
      isOther: true,
      options: [{ label: "Skip" }]
    });
  });
});
