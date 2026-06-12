import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const upsertEnvFileValue = (filePath, key, value) => {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing === "" ? [] : existing.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!replaced) {
    nextLines.push(`${key}=${value}`);
  }

  const rendered = `${nextLines.join("\n")}${nextLines.length > 0 ? "\n" : ""}`;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, rendered, { mode: 0o600 });
};
