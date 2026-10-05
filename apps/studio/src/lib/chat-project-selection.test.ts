import { expect, it } from "vitest";
import { newChatProjectId } from "./chat-project-selection";

it("keeps No folder explicit even when the sidebar has a selected Project", () => {
  expect(
    newChatProjectId(null, "old-project", new Set(["old-project"]))
  ).toBeNull();
});
it("uses a newly selected folder instead of the sidebar selection", () => {
  expect(
    newChatProjectId("new-project", "old-project", new Set(["old-project"]))
  ).toBe("new-project");
});
it("only inherits a still-available sidebar Project when the choice is omitted", () => {
  expect(
    newChatProjectId(undefined, "old-project", new Set(["old-project"]))
  ).toBe("old-project");
  expect(
    newChatProjectId(undefined, "removed", new Set(["old-project"]))
  ).toBeNull();
});
