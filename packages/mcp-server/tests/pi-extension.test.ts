import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Koed Pi extension package", () => {
  it("packages supported tools and session-scoped lifecycle handlers", () => {
    const source = readFileSync(
      new URL("../integrations/pi/extensions/koed.mjs", import.meta.url),
      "utf8"
    );
    expect(source).toContain('"memory_answer"');
    expect(source).toContain('"memory_intake_propose"');
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("session_shutdown"');
    expect(source).toContain('pi.on("agent_settled"');
    expect(source).not.toContain("KOED_API_TOKEN");
    expect(source).not.toContain("ANTHROPIC_API_KEY");
    expect(source).not.toContain("OPENAI_API_KEY");
  });

  it("declares only Koed-owned extension as installed package resource", () => {
    const parsed: unknown = JSON.parse(
      readFileSync(
        new URL("../integrations/pi/package.json", import.meta.url),
        "utf8"
      )
    );
    expect(parsed).toMatchObject({
      pi: { extensions: ["./extensions/koed.mjs"] }
    });
    expect(
      parsed && typeof parsed === "object" && "dependencies" in parsed
    ).toBe(false);
  });
});
