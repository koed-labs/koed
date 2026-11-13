import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  BACKGROUND_AGENT_PLIST_NAME,
  backgroundAgentBuildIsEligible
} from "./background-agent-package.mjs";

const assertCodesign = (args, description) => {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${description} failed: ${result.stderr || result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
};

const assertTeamIdentifier = (path, expectedTeamId) => {
  const output = assertCodesign(
    ["--display", "--verbose=4", path],
    `Inspecting code signature for ${path}`
  );
  const actualTeamId = output.match(/^TeamIdentifier=(.+)$/mu)?.[1];
  if (actualTeamId !== expectedTeamId)
    throw new Error(
      `Background Agent signature Team ID mismatch for ${path}: expected ${expectedTeamId}, received ${actualTeamId ?? "none"}.`
    );
};

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (!backgroundAgentBuildIsEligible(process.env)) return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const expectedTeamId = process.env.DESKTOP_MACOS_APPLE_TEAM_ID;
  const plistPath = join(
    appPath,
    "Contents",
    "Library",
    "LaunchAgents",
    BACKGROUND_AGENT_PLIST_NAME
  );
  const nativeAddonPath = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist-electron",
    "background-agent",
    "native",
    "koed_background_xpc.node"
  );
  if (!existsSync(plistPath) || !existsSync(nativeAddonPath))
    throw new Error("Qualified Background Agent bundle assets are missing.");

  assertCodesign(
    ["--verify", "--deep", "--strict", appPath],
    "Verifying signed Koed app"
  );
  assertTeamIdentifier(appPath, expectedTeamId);
  assertTeamIdentifier(nativeAddonPath, expectedTeamId);
  const plistResult = spawnSync("plutil", ["-lint", plistPath], {
    encoding: "utf8"
  });
  if (plistResult.error) throw plistResult.error;
  if (plistResult.status !== 0)
    throw new Error(`Invalid Background Agent plist: ${plistResult.stderr}`);
}
