import { describe, expect, it } from "vitest";
import {
  nodeCliInvocation,
  nodeCliProcessEnvironment
} from "./node-cli-invocation.js";

describe("Node CLI invocation", () => {
  it.each(["cli.js", "cli.mjs", "cli.cjs"])(
    "runs a canonical %s entry through the trusted Node executable",
    (entry) => {
      expect(
        nodeCliInvocation(`/opt/client/${entry}`, ["--version"], "/node")
      ).toEqual({
        command: "/node",
        args: [`/opt/client/${entry}`, "--version"]
      });
    }
  );

  it("runs a native executable directly", () => {
    expect(
      nodeCliInvocation("/opt/client/bin", ["--version"], "/node")
    ).toEqual({
      command: "/opt/client/bin",
      args: ["--version"]
    });
  });

  it("preserves Electron Node mode only for trusted runtime invocations", () => {
    const runtimeEnvironment = { ELECTRON_RUN_AS_NODE: "1" };
    const childEnvironment = { PATH: "/usr/bin:/bin" };

    expect(
      nodeCliProcessEnvironment(
        nodeCliInvocation("/opt/client/cli.js", [], "/electron"),
        childEnvironment,
        runtimeEnvironment,
        "/electron"
      )
    ).toEqual({
      PATH: "/usr/bin:/bin",
      ELECTRON_RUN_AS_NODE: "1"
    });
    expect(
      nodeCliProcessEnvironment(
        nodeCliInvocation("/opt/client/bin", [], "/electron"),
        childEnvironment,
        runtimeEnvironment,
        "/electron"
      )
    ).toBe(childEnvironment);
  });
});
