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

describe("package command compatibility", () => {
  it("preserves package status payloads", async () => {
    const stdout = output();
    const paths = {} as never;
    const collectPackageStatus = vi.fn(
      () =>
        ({
          ok: true,
          state: "installed",
          message: "installed",
          activeVersion: "1.2.3"
        }) as never
    );
    expect(
      await runKoedServerCli(["package", "status", "--json"], {
        stdout: stdout.stream,
        resolvePaths: () => paths,
        collectPackageStatus
      })
    ).toBe(0);
    expect(collectPackageStatus).toHaveBeenCalledExactlyOnceWith(paths);
    expect(JSON.parse(stdout.text())).toMatchObject({ activeVersion: "1.2.3" });
  });
  it.each([["--version", "1.2.3"], ["--version=1.2.3"]])(
    "passes activation version %j and preserves a failed operation result",
    async (...version) => {
      const stdout = output();
      const paths = {} as never;
      const activatePackage = vi.fn(
        () =>
          ({
            ok: false,
            state: "blocked",
            message: "activation denied"
          }) as never
      );
      expect(
        await runKoedServerCli(
          ["package", "activate", ...version, "--allow-downgrade", "--json"],
          { stdout: stdout.stream, resolvePaths: () => paths, activatePackage }
        )
      ).toBe(1);
      expect(activatePackage).toHaveBeenCalledExactlyOnceWith(paths, "1.2.3", {
        allowDowngrade: true
      });
      expect(JSON.parse(stdout.text())).toMatchObject({
        ok: false,
        state: "blocked",
        message: "activation denied"
      });
    }
  );
  it("requires a version before activating a package", async () => {
    const stdout = output();
    const activatePackage = vi.fn(() => {
      throw new Error("invalid activation reached operation");
    });
    expect(
      await runKoedServerCli(["package", "activate", "--json"], {
        stdout: stdout.stream,
        resolvePaths: () => ({}) as never,
        activatePackage
      })
    ).toBe(1);
    expect(activatePackage).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.text())).toMatchObject({
      error: "--version is required."
    });
  });
  it.each<[string[], number]>([
    [[], 1],
    [["--keep", "2"], 2]
  ])("preserves cleanup retention for %j", async (flags, keep) => {
    const stdout = output();
    const paths = {} as never;
    const cleanupPackages = vi.fn(
      () => ({ ok: true, state: "cleaned", message: "cleaned" }) as never
    );
    expect(
      await runKoedServerCli(["package", "cleanup", ...flags, "--json"], {
        stdout: stdout.stream,
        resolvePaths: () => paths,
        cleanupPackages
      })
    ).toBe(0);
    expect(cleanupPackages).toHaveBeenCalledExactlyOnceWith(paths, keep);
  });
  it("rejects invalid trust policy before package installation", async () => {
    const stdout = output();
    const installPackage = vi.fn(async () => {
      throw new Error("invalid trust policy reached installation");
    });
    expect(
      await runKoedServerCli(
        [
          "package",
          "install",
          "--source",
          "/fixture/archive",
          "--trust-policy",
          "unsupported",
          "--json"
        ],
        {
          stdout: stdout.stream,
          resolvePaths: () => ({}) as never,
          installPackage
        }
      )
    ).toBe(1);
    expect(installPackage).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.text())).toMatchObject({
      error:
        "--trust-policy must be sha256-only, require-provenance, or require-signature."
    });
  });
});
