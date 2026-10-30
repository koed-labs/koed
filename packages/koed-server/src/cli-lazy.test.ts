import { beforeEach, describe, expect, it, vi } from "vitest";
import { runKoedServerCli } from "./cli.js";

const serviceLoads = vi.hoisted(() => vi.fn());

vi.mock("./start.js", () => {
  serviceLoads();
  throw new Error("service start module loaded by lightweight CLI path");
});

const writer = () => {
  let value = "";
  return {
    stream: {
      write: (chunk: unknown) => {
        value += String(chunk);
        return true;
      }
    } satisfies Pick<NodeJS.WriteStream, "write">,
    text: () => value
  };
};

describe("lightweight CLI dispatch", () => {
  beforeEach(() => serviceLoads.mockClear());
  it("does not fetch artifacts from help or lightweight status commands", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await runKoedServerCli(["--help"], { stdout: writer().stream });
      await runKoedServerCli(["--version"], { stdout: writer().stream });
      expect(serviceLoads).not.toHaveBeenCalled();
      await runKoedServerCli(["models", "status", "--json"], {
        stdout: writer().stream
      });
      await runKoedServerCli(["runtime", "status", "--json"], {
        stdout: writer().stream
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prints help without loading service start module", async () => {
    const stdout = writer();
    expect(await runKoedServerCli(["--help"], { stdout: stdout.stream })).toBe(
      0
    );
    expect(stdout.text()).toContain("components");
  });

  it("returns actionable provisioning guidance when service imports are missing", async () => {
    const stdout = writer();
    const stderr = writer();
    expect(
      await runKoedServerCli(["start", "--json"], {
        stdout: stdout.stream,
        stderr: stderr.stream
      })
    ).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      action: "components install --component base"
    });
    expect(stdout.text()).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(serviceLoads).toHaveBeenCalledOnce();
  });

  it.each([
    ["models", "status", "--json"],
    ["runtime", "status", "--json"]
  ])("keeps %s status independent of service start module", async (...args) => {
    const stdout = writer();
    await runKoedServerCli(args, { stdout: stdout.stream });
    expect(stdout.text()).not.toContain("service start module loaded");
  });

  it("prints remote authorization and helper commands without service startup", async () => {
    const stdout = writer();
    expect(
      await runKoedServerCli(["remote", "--help"], { stdout: stdout.stream })
    ).toBe(0);
    expect(stdout.text()).toContain("login");
    expect(stdout.text()).toContain("start");
    expect(stdout.text()).toContain("logout");
    expect(stdout.text()).not.toContain("--backend");
    expect(serviceLoads).not.toHaveBeenCalled();
  });
});
