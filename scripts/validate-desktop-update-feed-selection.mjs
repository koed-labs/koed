import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { load } from "js-yaml";
import {
  INTERNAL_UPDATE_URL,
  PUBLIC_UPDATE_URL
} from "./prepare-desktop-update-config.mjs";

export function validateDesktopUpdateFeedSelection({ app, mode }) {
  if (!app) throw new Error("packaged app path is required");
  if (mode !== "internal" && mode !== "public")
    throw new Error("mode must be internal or public");
  const path = `${app.replace(/[\\/]$/, "")}/Contents/Resources/app-update.yml`;
  const config = load(readFileSync(path, "utf8"));
  const expectedUrl =
    mode === "public" ? PUBLIC_UPDATE_URL : INTERNAL_UPDATE_URL;
  if (
    config?.provider !== "generic" ||
    config?.url !== expectedUrl ||
    config?.channel !== "latest"
  ) {
    throw new Error(
      `app-update.yml feed selection does not match ${mode} mode`
    );
  }
  return {
    mode,
    provider: config.provider,
    url: config.url,
    channel: config.channel,
    path
  };
}

if (process.argv[1]?.endsWith("validate-desktop-update-feed-selection.mjs")) {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      mode: { type: "string" },
      json: { type: "boolean", default: false }
    },
    strict: true
  });
  try {
    const result = validateDesktopUpdateFeedSelection(values);
    process.stdout.write(
      `${values.json ? JSON.stringify({ ok: true, ...result }) : `Validated ${result.mode} feed selection`}\n`
    );
  } catch (error) {
    process.stderr.write(
      `Desktop update feed selection failed: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}
