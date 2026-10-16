import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyMacosPackage } from "./verify-macos-package.mjs";

function fixture(
  t,
  failure = () => false,
  signature = "Authority=Developer ID Application: Koed\nTeamIdentifier=TEAM123\n"
) {
  const root = mkdtempSync(join(tmpdir(), "koed-trust-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const calls = [];
  function app(path) {
    mkdirSync(join(path, "Contents/Resources/app-dist"), { recursive: true });
    writeFileSync(
      join(path, "Contents/Resources/app-dist/koed-release-version.json"),
      JSON.stringify({ version: "1.2.3" })
    );
    return path;
  }
  const appPath = app(join(root, "Koed.app"));
  const runCommand = (command, args) => {
    calls.push([command, args]);
    if (command === "hdiutil" && args[0] === "attach")
      app(join(args[args.indexOf("-mountpoint") + 1], "Koed.app"));
    if (failure(command, args, calls))
      return { status: 1, stdout: "", stderr: "denied" };
    return {
      status: 0,
      stdout: command.endsWith("PlistBuddy") ? "1.2.3\n" : "",
      stderr: command === "codesign" && args.includes("-dv") ? signature : ""
    };
  };
  return {
    calls,
    options: {
      appPath,
      dmgPath: join(root, "Koed.dmg"),
      expectedVersion: "1.2.3",
      expectedTeamId: "TEAM123",
      runCommand
    }
  };
}
test("verifies Developer ID, team, Gatekeeper and staple for app and mounted copy", (t) => {
  const { options, calls } = fixture(t);
  verifyMacosPackage(options);
  for (const name of ["codesign", "spctl", "xcrun"])
    assert.equal(
      calls.filter(([command]) => command === name).length,
      name === "codesign" ? 4 : 2
    );
  assert.equal(calls.at(-1)[1][0], "detach");
});
for (const signature of [
  "Signature=adhoc\n",
  "Authority=Apple Distribution: Koed\nTeamIdentifier=TEAM123",
  "Authority=Developer ID Application: Koed\nTeamIdentifier=OTHER",
  "Authority=Developer ID Application: Koed\n"
]) {
  test(`rejects untrusted signature ${signature}`, (t) => {
    const { options } = fixture(t, undefined, signature);
    assert.throws(() => verifyMacosPackage(options), /Developer ID|team/);
  });
}
for (const command of ["codesign", "spctl", "xcrun"]) {
  for (const copy of [1, 2]) {
    test(`rejects ${command} failure on copy ${copy} and detaches mounted image`, (t) => {
      const { options, calls } = fixture(
        t,
        (name, args, all) =>
          name === command &&
          (command !== "codesign" || args.includes("--verify")) &&
          all.filter(
            ([n, a]) =>
              n === command &&
              (command !== "codesign" || a.includes("--verify"))
          ).length === copy
      );
      assert.throws(() => verifyMacosPackage(options), /failed/);
      if (copy === 2) assert.equal(calls.at(-1)[1][0], "detach");
    });
  }
}
test("internal verification omits release trust checks", (t) => {
  const { options, calls } = fixture(t);
  delete options.expectedTeamId;
  verifyMacosPackage(options);
  assert.equal(
    calls.some(([command]) => command === "spctl" || command === "xcrun"),
    false
  );
});
test("rejects mismatched package versions", (t) => {
  const { options } = fixture(t);
  options.expectedVersion = "9.9.9";
  assert.throws(() => verifyMacosPackage(options), /version mismatch/);
});
test("surfaces command spawn errors", (t) => {
  const { options } = fixture(t);
  options.runCommand = () => ({ error: new Error("spawn denied") });
  assert.throws(() => verifyMacosPackage(options), /spawn denied/);
});
test("surfaces detach failures", (t) => {
  const { options } = fixture(
    t,
    (command, args) => command === "hdiutil" && args[0] === "detach"
  );
  assert.throws(() => verifyMacosPackage(options), /detach.*failed/);
});
