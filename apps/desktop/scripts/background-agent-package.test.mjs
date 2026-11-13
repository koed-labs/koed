import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundAgentBuildIsEligible,
  createBackgroundAgentLaunchAgentPlist,
  writeBackgroundAgentLaunchAgentPlist
} from "./background-agent-package.mjs";

const signedEnvironment = {
  DESKTOP_MACOS_APPLE_TEAM_ID: "ABCDE12345",
  KOED_ADHOC_SIGN_MACOS_APP: "false",
  CSC_IDENTITY_AUTO_DISCOVERY: "true"
};

test("signed Developer ID build configs are eligible without a qualification flag", () => {
  assert.equal(backgroundAgentBuildIsEligible({}), false);
  assert.equal(
    backgroundAgentBuildIsEligible({
      ...signedEnvironment,
      KOED_ADHOC_SIGN_MACOS_APP: "true"
    }),
    false
  );
  assert.equal(backgroundAgentBuildIsEligible(signedEnvironment), true);
});

test("LaunchAgent plist uses bundle-relative executable and XPC Mach service", () => {
  const plist = createBackgroundAgentLaunchAgentPlist("Koed");

  assert.match(
    plist,
    /<key>BundleProgram<\/key>\s*<string>Contents\/MacOS\/Koed<\/string>/u
  );
  assert.match(
    plist,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>--koed-background-agent<\/string>/u
  );
  assert.match(
    plist,
    /<key>MachServices<\/key>\s*<dict>\s*<key>ai\.koed\.desktop\.background-agent<\/key>\s*<true\s*\/>/u
  );
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\s*\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\s*\/>/u);
});

test("plist writer includes signed builds and removes stale assets from unsupported builds", () => {
  const root = mkdtempSync(join(tmpdir(), "koed-agent-package-"));
  const appPath = join(root, "Koed.app");
  try {
    const installed = writeBackgroundAgentLaunchAgentPlist({
      appPath,
      productFilename: "Koed",
      environment: signedEnvironment
    });
    assert.equal(installed.included, true);
    assert.equal(statSync(installed.plistPath).mode & 0o777, 0o644);
    assert.match(
      readFileSync(installed.plistPath, "utf8"),
      /--koed-background-agent/u
    );

    const removed = writeBackgroundAgentLaunchAgentPlist({
      appPath,
      productFilename: "Koed",
      environment: {}
    });
    assert.equal(removed.included, false);
    assert.equal(
      statSync(installed.plistPath, { throwIfNoEntry: false }),
      undefined
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
