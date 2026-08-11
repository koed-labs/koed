import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dump, load } from "js-yaml";

export const PUBLIC_UPDATE_URL = "https://updates.koed.ai/R2/stable/";
export const INTERNAL_UPDATE_URL = "http://127.0.0.1:0/koed-internal/stable/";

export function selectDesktopUpdateFeed({
  mode,
  url = null,
  allowPublicTarget = false
}) {
  if (mode !== "internal" && mode !== "public")
    throw new Error("mode must be internal or public");
  if (mode === "internal") {
    if (url && url !== INTERNAL_UPDATE_URL)
      throw new Error(
        "internal mode accepts only the loopback fail-closed URL"
      );
    return INTERNAL_UPDATE_URL;
  }
  if (!allowPublicTarget || url !== PUBLIC_UPDATE_URL) {
    throw new Error(
      "public mode requires explicit approval and the exact stable public target URL"
    );
  }
  return PUBLIC_UPDATE_URL;
}

export function writeDesktopUpdateConfig({
  mode,
  out,
  url = null,
  allowPublicTarget = false,
  source = "apps/desktop/electron-builder.yml"
}) {
  if (!out) throw new Error("output config path is required");
  const selectedUrl = selectDesktopUpdateFeed({ mode, url, allowPublicTarget });
  const config = load(readFileSync(source, "utf8"));
  config.publish = {
    ...(config.publish ?? {}),
    provider: "generic",
    url: selectedUrl,
    channel: "latest"
  };
  writeFileSync(out, dump(config, { lineWidth: 120 }));
  return { mode, url: selectedUrl, out };
}

if (process.argv[1]?.endsWith("prepare-desktop-update-config.mjs")) {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      out: { type: "string" },
      url: { type: "string" },
      source: { type: "string" },
      "allow-public-target": { type: "boolean", default: false },
      json: { type: "boolean", default: false }
    },
    strict: true
  });
  try {
    const result = writeDesktopUpdateConfig({
      mode: values.mode,
      out: values.out,
      url: values.url ?? null,
      source: values.source ?? "apps/desktop/electron-builder.yml",
      allowPublicTarget: values["allow-public-target"]
    });
    process.stdout.write(
      `${values.json ? JSON.stringify({ ok: true, ...result }) : `Wrote ${result.mode} update config to ${result.out}`}\n`
    );
  } catch (error) {
    process.stderr.write(`Desktop update config failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
