import { describe, expect, it } from "vitest";
import { uniqueInvitationAgent } from "./managed-text-action-repository.js";

describe("invitation Agent attribution", () => {
  it("does not label a non-Chief execution as Chief on a shared AI Client instance", () => {
    const chief = {
      id: "chief",
      name: "Chief of Staff",
      is_chief_of_staff: true
    };
    const designer = {
      id: "designer",
      name: "Design Agent",
      is_chief_of_staff: false
    };
    expect(uniqueInvitationAgent([chief, designer])).toBeNull();
    expect(uniqueInvitationAgent([designer])).toEqual(designer);
    expect(uniqueInvitationAgent([])).toBeNull();
  });
});
