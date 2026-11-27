import { describe, expect, it } from "vitest";
import { createInstalledAgentCommand } from "./installed-client.js";

describe("installed Agent control client", () => {
  it("sends automatic Start through the verified installed entrypoint", async () => {
    const calls: string[][] = [];
    const command = createInstalledAgentCommand({
      executable: "/app/Koed",
      entrypoint: "/app/cli.js",
      environment: {},
      run: async (_executable, args) => {
        calls.push(args);
        return JSON.stringify({ ok: true });
      }
    });
    expect(await command("start-automatic")).toEqual({ ok: true });
    expect(calls).toEqual([
      ["/app/cli.js", "__control-plane-start-automatic", "--daemon", "--json"]
    ]);
  });
  it("sends a menu Start as an explicit start, not an automatic resume", async () => {
    const calls: string[][] = [];
    const command = createInstalledAgentCommand({
      executable: "/app/Koed",
      entrypoint: "/app/cli.js",
      environment: {},
      run: async (_executable, args) => {
        calls.push(args);
        return JSON.stringify({ ok: true });
      }
    });
    await command("start");
    expect(calls).toEqual([
      ["/app/cli.js", "__control-plane-start-agent", "--daemon", "--json"]
    ]);
  });
  it("treats malformed output as failure rather than accepting it", async () => {
    const command = createInstalledAgentCommand({
      executable: "/app/Koed",
      entrypoint: "/app/cli.js",
      environment: {},
      run: async () => "{}"
    });
    expect(await command("agent-status")).toMatchObject({ ok: false });
  });
});
