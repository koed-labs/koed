import { describe, expect, it } from "vitest";
import {
  canSubmitAgentIdentity,
  initialAgentIdentityEditorValues
} from "./agentIdentityEditor";

describe("agent identity editor", () => {
  it("loads name, optional title, and Pixelkin appearance only", () => {
    const avatar = { seed: 1, spec: {}, image: "data:image/png;base64,avatar" };
    expect(
      initialAgentIdentityEditorValues({
        definition: {
          id: "agent-1",
          ownerId: "you",
          name: "Bob",
          role: "reviewer",
          identity: "Legacy instructions remain in storage",
          createdAt: 1,
          avatar
        },
        initialValues: {
          name: "Robert",
          role: "",
          avatar
        }
      })
    ).toEqual({ name: "Robert", role: "", avatar });
  });

  it("allows saving without a job title and requires a name", () => {
    expect(canSubmitAgentIdentity({ name: " Bob " })).toBe(true);
    expect(canSubmitAgentIdentity({ name: " " })).toBe(false);
  });
});
