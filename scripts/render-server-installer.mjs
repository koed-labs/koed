import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const marker = "__KOED_INSTALLER_VERSION__";
export const serverInstallerAssetName = "install-koed-server.sh";
const templateUrl = new URL("./install-server.sh", import.meta.url);
const stableVersion =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

export function renderServerInstaller(template, version) {
  if (
    typeof version !== "string" ||
    !stableVersion.test(version) ||
    version.includes("\n")
  ) {
    throw new Error("Installer version must be stable X.Y.Z");
  }
  if (typeof template !== "string" || template.split(marker).length !== 2) {
    throw new Error(
      "Installer template must contain exactly one version marker"
    );
  }
  return template.replace(marker, version);
}

/** Renders the installer from the template in this checkout. */
export const renderReleaseServerInstaller = (version) =>
  renderServerInstaller(readFileSync(templateUrl, "utf8"), version);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, out] = process.argv.slice(2);
  if (!out) throw new Error("Usage: render-server-installer.mjs VERSION OUT");
  writeFileSync(out, renderReleaseServerInstaller(version), { flag: "wx" });
}
