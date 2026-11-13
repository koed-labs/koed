import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BACKGROUND_AGENT_PLIST_NAME =
  "ai.koed.desktop.background-agent.plist";
export const BACKGROUND_AGENT_MACH_SERVICE_NAME =
  "ai.koed.desktop.background-agent";

export const backgroundAgentBuildIsQualified = (environment) =>
  environment.KOED_MACOS_BACKGROUND_AGENT_QUALIFIED === "true" &&
  /^[A-Z0-9]{10}$/u.test(environment.DESKTOP_MACOS_APPLE_TEAM_ID ?? "") &&
  environment.KOED_ADHOC_SIGN_MACOS_APP !== "true" &&
  environment.CSC_IDENTITY_AUTO_DISCOVERY !== "false";

export const createBackgroundAgentLaunchAgentPlist = (productFilename) => {
  if (!/^[A-Za-z0-9._-]+$/u.test(productFilename))
    throw new Error("Invalid macOS app executable name for Background Agent.");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.koed.desktop.background-agent</string>
  <key>BundleProgram</key>
  <string>Contents/MacOS/${productFilename}</string>
  <key>ProgramArguments</key>
  <array>
    <string>--koed-background-agent</string>
  </array>
  <key>MachServices</key>
  <dict>
    <key>${BACKGROUND_AGENT_MACH_SERVICE_NAME}</key>
    <true/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
};

export const writeBackgroundAgentLaunchAgentPlist = (input) => {
  const plistPath = join(
    input.appPath,
    "Contents",
    "Library",
    "LaunchAgents",
    BACKGROUND_AGENT_PLIST_NAME
  );
  rmSync(plistPath, { force: true });
  if (!backgroundAgentBuildIsQualified(input.environment))
    return { included: false, plistPath };

  const directory = dirname(plistPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${plistPath}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      createBackgroundAgentLaunchAgentPlist(input.productFilename),
      { encoding: "utf8", mode: 0o644 }
    );
    renameSync(temporaryPath, plistPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { included: true, plistPath };
};
