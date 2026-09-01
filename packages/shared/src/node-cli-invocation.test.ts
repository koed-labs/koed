import { describe, expect, it } from "vitest";
import { nodeCliInvocation } from "./node-cli-invocation.js";

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
});
