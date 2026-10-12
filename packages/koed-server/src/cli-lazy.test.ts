import { describe, expect, it, vi } from "vitest";
import { runKoedServerCli } from "./cli.js";

const serviceLoads = vi.hoisted(() => vi.fn());

vi.mock("./start.js", () => {
  serviceLoads();
  throw new Error("service start module loaded");
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

describe("lazy CLI help", () => {
  it.each([[], ["--help"], ["-h"], ["start", "--help"]])(
    "prints general help without loading service startup: %j",
    async (...args) => {
      const stdout = writer();
      expect(await runKoedServerCli(args, { stdout: stdout.stream })).toBe(0);
      expect(stdout.text()).toContain("Usage: koed <command> [options]");
    }
  );

  it("preserves Personal Sync and advanced recovery help without service startup", async () => {
    const ordinary = writer();
    const advanced = writer();
    expect(
      await runKoedServerCli(["personal-sync", "--help"], {
        stdout: ordinary.stream
      })
    ).toBe(0);
    expect(
      await runKoedServerCli(["personal-sync", "--help", "--advanced"], {
        stdout: advanced.stream
      })
    ).toBe(0);
    expect(ordinary.text()).toContain("koed pair");
    expect(ordinary.text()).not.toContain("Advanced compatibility");
    expect(advanced.text()).toContain(
      "Advanced compatibility and recovery commands"
    );
  });

  it("loads the existing implementation for commands", async () => {
    expect(serviceLoads).not.toHaveBeenCalled();
    await expect(runKoedServerCli(["start"])).rejects.toThrow();
    expect(serviceLoads).toHaveBeenCalledOnce();
  });
});
