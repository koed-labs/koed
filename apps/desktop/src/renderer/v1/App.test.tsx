// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { V1Profile } from "../../ipc/v1-state-protocol.js";
import { createV1ProfileWriter, shouldShowV1Onboarding } from "./App.js";

const profile = (): V1Profile => ({
  onboarding: { selections: {}, completed: false }
});
describe("V1 app state", () => {
  it("serializes onboarding saves and keeps completion after a late draft", async () => {
    let current = profile();
    const writes: V1Profile[] = [];
    const save = createV1ProfileWriter(
      () => current,
      async (next) => {
        await Promise.resolve();
        writes.push(next);
        return next;
      },
      (next) => {
        current = next;
      }
    );
    const draft = save((value) => ({
      ...value,
      onboarding: { ...value.onboarding, step: "memory" }
    }));
    const agent = save((value) => ({ ...value, agentName: "Ada" }));
    const complete = save((value) => ({
      ...value,
      onboarding: { ...value.onboarding, completed: true }
    }));
    await Promise.all([draft, agent, complete]);
    await save((value) =>
      value.onboarding.completed
        ? value
        : { ...value, onboarding: { ...value.onboarding, step: "intro" } }
    );
    expect(writes).toHaveLength(3);
    expect(current.agentName).toBe("Ada");
    expect(current.onboarding).toMatchObject({
      step: "memory",
      completed: true
    });
    expect(shouldShowV1Onboarding(current, true)).toBe(false);
    expect(shouldShowV1Onboarding(current, false)).toBe(true);
  });
});
