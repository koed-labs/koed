import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runKoedServerCli } from "./cli.js";

const output = () => {
  let text = "";
  return {
    stream: {
      write: (chunk: unknown) => {
        text += String(chunk);
        return true;
      }
    },
    text: () => text
  };
};

describe("Commander help and lightweight actions", () => {
  it.each(["--version", "-V"])(
    "prints the Changesets-managed package version for %s without invoking actions",
    async (flag) => {
      const stdout = output();
      const stderr = output();
      const resolvePaths = vi.fn(() => {
        throw new Error("version resolved runtime paths");
      });
      const manifest = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8")
      ) as { version: string };
      expect(
        await runKoedServerCli([flag], {
          stdout: stdout.stream,
          stderr: stderr.stream,
          resolvePaths
        })
      ).toBe(0);
      expect(stdout.text()).toBe(`${manifest.version}\n`);
      expect(stderr.text()).toBe("");
      expect(resolvePaths).not.toHaveBeenCalled();
    }
  );
  it.each<[string[], string, string]>([
    [[], "Manage Koed services", "--dependency-mode"],
    [["runtime"], "install", "--kind"],
    [["runtime", "--help"], "status", "--kind"],
    [["runtime", "install", "-h"], "--dependency-mode", "--kind"],
    [["help", "runtime"], "install", "--kind"],
    [["models", "install", "--help"], "--kind", "--provider"],
    [["package", "install", "--help"], "--source", "--kind"],
    [
      ["team", "workspace", "link", "--help"],
      "--upstream-backend-id",
      "--provider"
    ],
    [["project", "anchor", "--help"], "--checkout-id", "--kind"],
    [
      ["setup", "codex", "--help"],
      "--without-memory-guidance",
      "--background-recall"
    ],
    [["remote", "login", "--help"], "--backend", "--kind"],
    [
      ["upstream", "enroll", "start", "--help"],
      "--enable-memory-answers",
      "--kind"
    ],
    [["pair", "--help"], "--detach", "--kind"],
    [["personal-sync", "--help"], "status", "group bootstrap"],
    [
      ["personal-sync", "recovery-kit", "verify", "--help"],
      "--password-fd",
      "--provider"
    ],
    [["components", "install", "--help"], "--manifest-url", "--password"]
  ])(
    "shows scoped help without invoking actions for %j",
    async (args, included, excluded) => {
      const stdout = output();
      const resolvePaths = vi.fn(() => {
        throw new Error("help resolved runtime paths");
      });
      const installRuntime = vi.fn(() => {
        throw new Error("help installed a runtime");
      });
      const installModel = vi.fn(() => {
        throw new Error("help installed a model");
      });
      expect(
        await runKoedServerCli(args, {
          stdout: stdout.stream,
          resolvePaths,
          installRuntime,
          installModel
        })
      ).toBe(0);
      expect(stdout.text()).toContain(included);
      expect(stdout.text()).not.toContain(excluded);
      expect(resolvePaths).not.toHaveBeenCalled();
      expect(installRuntime).not.toHaveBeenCalled();
      expect(installModel).not.toHaveBeenCalled();
    }
  );

  it("rejects unknown options before action execution and emits one redacted JSON error", async () => {
    const stdout = output();
    const stderr = output();
    const installRuntime = vi.fn(() => {
      throw new Error("must not install");
    });
    expect(
      await runKoedServerCli(
        ["runtime", "install", "--password=secret-value", "--json"],
        { stdout: stdout.stream, stderr: stderr.stream, installRuntime }
      )
    ).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
    expect(stdout.text()).not.toContain("secret-value");
    expect(stderr.text()).toBe("");
    expect(installRuntime).not.toHaveBeenCalled();
  });

  it("keeps parser output and option state separate between invocations", async () => {
    const first = output();
    const second = output();
    await runKoedServerCli(["runtime", "install", "--help"], {
      stdout: first.stream
    });
    const firstText = first.text();
    await runKoedServerCli(["models", "status", "--help"], {
      stdout: second.stream
    });
    expect(first.text()).toBe(firstText);
    expect(second.text()).toContain("--kind");
    expect(second.text()).not.toContain("--provider");
  });
  it("keeps internal commands out of public help and rejects excess secret arguments before reading input", async () => {
    const stdout = output();
    await runKoedServerCli(["--help"], { stdout: stdout.stream });
    expect(stdout.text()).not.toContain("secret-provider");
    expect(stdout.text()).not.toContain("collaboration-broker");
    const invalid = output();
    expect(
      await runKoedServerCli(["secret-provider", "put", "reference", "extra"], {
        stdout: invalid.stream
      })
    ).toBe(1);
    expect(invalid.text()).toBe(
      "Usage: koed secret-provider <get|put|delete> <reference>\n"
    );
  });

  it("returns a failed internal broker invocation without rejecting the callable CLI", async () => {
    const stderr = output();
    vi.stubEnv("KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN", "");
    try {
      await expect(
        runKoedServerCli(["desktop", "collaboration-broker"], {
          stderr: stderr.stream
        })
      ).resolves.toBe(1);
      expect(stderr.text()).toContain(
        "KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN is required."
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps the first repeated value after replacing an option default", async () => {
    const stdout = output();
    const collectPrivacyModelStatus = vi.fn(
      async () => ({ state: "missing", message: "privacy model" }) as never
    );
    expect(
      await runKoedServerCli(
        [
          "models",
          "status",
          "--kind",
          "privacy",
          "--kind",
          "invalid",
          "--json"
        ],
        {
          stdout: stdout.stream,
          resolvePaths: () => ({ repoRoot: "/fixture" }) as never,
          loadEnvironment: () => ({}),
          collectPrivacyModelStatus
        }
      )
    ).toBe(0);
    expect(collectPrivacyModelStatus).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.text())).toMatchObject({
      message: "privacy model"
    });
  });

  it.each([
    [["--json"], "--json"],
    [["--component", "base", "--component", "privacy"], "--component"]
  ] as [string[], string][])(
    "rejects duplicate component options before resolving paths for %j",
    async (flags, flag) => {
      const stdout = output();
      const resolvePaths = vi.fn(() => {
        throw new Error("duplicate reached component action");
      });
      expect(
        await runKoedServerCli(["components", "install", "--json", ...flags], {
          stdout: stdout.stream,
          resolvePaths
        })
      ).toBe(1);
      expect(JSON.parse(stdout.text())).toMatchObject({
        error: `Duplicate components option: ${flag}`
      });
      expect(resolvePaths).not.toHaveBeenCalled();
    }
  );

  it("rejects an empty secret reference before protected stdin is read", async () => {
    const stdout = output();
    expect(
      await runKoedServerCli(["secret-provider", "put", ""], {
        stdout: stdout.stream
      })
    ).toBe(1);
    expect(stdout.text()).toBe(
      "Usage: koed secret-provider <get|put|delete> <reference>\n"
    );
  });
});
