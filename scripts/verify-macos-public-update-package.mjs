import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}: ${output.trim()}`
    );
  }
  return output;
};

export function verifyMacosPublicUpdatePackage({ app, dmg }) {
  if (!app || !existsSync(app)) throw new Error(`Missing macOS app: ${app}`);
  if (!dmg || !existsSync(dmg)) throw new Error(`Missing macOS DMG: ${dmg}`);

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const signature = run("codesign", ["-dv", "--verbose=4", app]);
  if (!/^Authority=Developer ID Application:/m.test(signature)) {
    throw new Error(
      "Koed.app is not signed by a Developer ID Application identity."
    );
  }
  if (!/^TeamIdentifier=(?!not set$).+/m.test(signature)) {
    throw new Error("Koed.app does not contain a Developer ID TeamIdentifier.");
  }

  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  run("xcrun", ["stapler", "validate", dmg]);
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmg
  ]);

  return { app, dmg, trust: "developer-id-notarized-stapled" };
}

if (process.argv[1]?.endsWith("verify-macos-public-update-package.mjs")) {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      dmg: { type: "string" },
      json: { type: "boolean", default: false }
    },
    strict: true
  });
  try {
    const result = verifyMacosPublicUpdatePackage({
      app: values.app,
      dmg: values.dmg
    });
    process.stdout.write(
      `${values.json ? JSON.stringify({ ok: true, ...result }) : `Verified public macOS update package ${result.app}`}\n`
    );
  } catch (error) {
    process.stderr.write(
      `Public macOS trust verification failed: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}
