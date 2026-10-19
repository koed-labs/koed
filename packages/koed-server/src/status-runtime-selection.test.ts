import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const selected = vi.hoisted(() => ({
  runtime: {
    kind: "packaged",
    root: "/verified",
    mcpCli: "/verified/mcp/cli.js",
    missing: [],
    privacyServiceEntry: "/verified/privacy/index.js"
  },
  resolve: vi.fn(),
  health: vi.fn(),
  status: vi.fn()
}));
vi.mock("./app-runtime.js", async (original) => ({
  ...(await original<typeof import("./app-runtime.js")>()),
  resolveKoedAppRuntimeExecution: () => "packaged"
}));
vi.mock("./service-runtime-selection.js", () => ({
  resolveVerifiedPackagedRuntime: selected.resolve
}));
vi.mock("./local-privacy-runtime.js", async (original) => ({
  ...(await original<typeof import("./local-privacy-runtime.js")>()),
  collectLocalPrivacyRuntimeHealthStatus: selected.health,
  collectLocalPrivacyRuntimeStatus: selected.status
}));
import {
  collectKoedServerStartupStatus,
  collectKoedServerStatus
} from "./status.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe("request-scoped authenticated status runtime", () => {
  it("retains the verified Privacy entry for both collectors and reselects on the next poll", async () => {
    selected.resolve.mockResolvedValue(selected.runtime);
    selected.health.mockResolvedValue({
      state: "healthy",
      message: "Privacy ready"
    });
    selected.status.mockResolvedValue({
      state: "healthy",
      message: "Privacy ready"
    });
    const home = mkdtempSync(resolve(tmpdir(), "koed-status-selection-"));
    roots.push(home);
    const environment = {
      KOED_HOME: home,
      KOED_TEAM_COLLABORATION_ENABLED: "true",
      KOED_DEPENDENCY_MODE: "bundled-local"
    };
    const deps = {
      existsSync: () => false,
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok", checks: [] }), {
            status: 200
          })
      ),
      resolveClaudeExecutable: () => {
        throw new Error("absent");
      },
      resolveCodexExecutable: () => {
        throw new Error("absent");
      },
      resolvePiExecutable: () => {
        throw new Error("absent");
      }
    };
    const startup = await collectKoedServerStartupStatus(environment, deps);
    expect(startup.privacyService.state).toBe("healthy");
    expect(selected.health).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ appRuntime: selected.runtime })
    );
    expect(selected.resolve).toHaveBeenCalledTimes(1);
    const full = await collectKoedServerStatus(environment, deps);
    expect(full.privacyService.state).toBe("healthy");
    expect(selected.status).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ appRuntime: selected.runtime })
    );
    // Full status selects for MCP and Privacy once, despite separate inspectors.
    expect(selected.resolve).toHaveBeenCalledTimes(2);
  });
});
