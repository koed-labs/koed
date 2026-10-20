import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveInstalledKoedHome } from "../integrations/pi/koed-home.mjs";

describe("Koed Pi extension package", () => {
  it("gates native completion registration and returns a request-only result", async () => {
    const source = readFileSync(
      new URL("../integrations/pi/extensions/koed.mjs", import.meta.url),
      "utf8"
    );
    expect(source).toContain(
      'process.env.KOED_MANAGED_WORK_ITEM_COMPLETION === "1"'
    );
    expect(source).toContain('name: "work_item_complete"');
    expect(source).toContain('process.env.KOED_MANAGED_MERGE_PROPOSAL === "1"');
    expect(source).toContain('name: "review_request_merge_propose"');
    expect(source).toContain("return workItemCompletionRequest()");
    const { workItemCompletionRequest } =
      await import("../integrations/pi/work-item-completion-request.mjs");
    const receipt = workItemCompletionRequest();
    expect(receipt.details).toEqual({ status: "requested" });
    expect(receipt.content[0]?.type).toBe("text");
    expect(receipt.content[0]?.text).toContain("will verify");
  });
  it("packages supported tools and session-scoped lifecycle handlers", () => {
    const source = readFileSync(
      new URL("../integrations/pi/extensions/koed.mjs", import.meta.url),
      "utf8"
    );
    expect(source).toContain('"memory_answer"');
    expect(source).toContain('"memory_workspaces"');
    expect(source).toContain("team_backend_id: Type.Optional");
    expect(source).toContain('"memory_intake_propose"');
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("session_shutdown"');
    expect(source).toContain('pi.on("agent_settled"');
    expect(source).toContain("resolveInstalledKoedHome");
    expect(source).not.toContain("KOED_API_TOKEN");
    expect(source).not.toContain("ANTHROPIC_API_KEY");
    expect(source).not.toContain("OPENAI_API_KEY");
  });

  it("derives custom KOED_HOME from the stable installed package path", () => {
    expect(
      resolveInstalledKoedHome(
        {},
        new URL(
          "file:///custom/koed/integrations/pi/extensions/koed.mjs"
        ).toString(),
        "/fallback-home"
      )
    ).toBe("/custom/koed");
    expect(
      resolveInstalledKoedHome(
        {},
        new URL(
          "file:///repo/packages/mcp-server/extensions/koed.mjs"
        ).toString(),
        "/fallback-home"
      )
    ).toBe("/fallback-home/.koed");
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
