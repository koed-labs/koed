import { describe, expect, it, vi } from "vitest";
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

describe("model command compatibility", () => {
  it.each(["embedding", "privacy"])(
    "reports %s checksum mismatches as failures",
    async (kind) => {
      const stdout = output();
      const status = vi.fn(
        async () =>
          ({
            state: "checksum_mismatch",
            message: "checksum mismatch"
          }) as never
      );
      expect(
        await runKoedServerCli(["models", "status", "--kind", kind, "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => ({ repoRoot: "/fixture" }) as never,
          loadEnvironment: () => ({}),
          collectModelStatus: status,
          collectPrivacyModelStatus: status
        })
      ).toBe(1);
      expect(status).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout.text())).toMatchObject({
        state: "checksum_mismatch"
      });
    }
  );
  it.each([
    ["", "file"],
    ["process", "process"]
  ])(
    "merges model environment with process marker %j",
    async (marker, expected) => {
      const stdout = output();
      const paths = { repoRoot: "/fixture" } as never;
      const installPrivacyModel = vi.fn(
        async () =>
          ({
            ok: true,
            state: "installed",
            message: "privacy installed"
          }) as never
      );
      vi.stubEnv("KOED_CLI_MODEL_FIXTURE_MARKER", marker);
      try {
        expect(
          await runKoedServerCli(
            ["models", "install", "--kind=privacy", "--json"],
            {
              stdout: stdout.stream,
              resolvePaths: () => paths,
              loadEnvironment: () => ({
                KOED_CLI_MODEL_FIXTURE_MARKER: "file"
              }),
              installPrivacyModel
            }
          )
        ).toBe(0);
        expect(installPrivacyModel).toHaveBeenCalledExactlyOnceWith(
          paths,
          expect.objectContaining({ KOED_CLI_MODEL_FIXTURE_MARKER: expected })
        );
        expect(JSON.parse(stdout.text())).toMatchObject({
          ok: true,
          state: "installed"
        });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
  it("preserves a failed privacy installation result", async () => {
    const stdout = output();
    const installPrivacyModel = vi.fn(
      async () =>
        ({
          ok: false,
          state: "missing",
          message: "fixture installation failed"
        }) as never
    );
    expect(
      await runKoedServerCli(
        ["models", "install", "--kind", "privacy", "--json"],
        {
          stdout: stdout.stream,
          resolvePaths: () => ({ repoRoot: "/fixture" }) as never,
          loadEnvironment: () => ({}),
          installPrivacyModel
        }
      )
    ).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      message: "fixture installation failed"
    });
  });
  it("rejects unsupported model kinds before resolving paths", async () => {
    const stdout = output();
    const resolvePaths = vi.fn(() => {
      throw new Error("invalid kind reached model action");
    });
    expect(
      await runKoedServerCli(
        ["models", "status", "--kind", "unsupported", "--json"],
        { stdout: stdout.stream, resolvePaths }
      )
    ).toBe(1);
    expect(resolvePaths).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.text())).toMatchObject({
      error: "--kind must be embedding or privacy."
    });
  });
});
