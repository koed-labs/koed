import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const resolveInstalledKoedHome = (
  environment = process.env,
  moduleUrl,
  fallbackHome = homedir()
) => {
  if (environment.KOED_HOME) return resolve(environment.KOED_HOME);
  const extensionDirectory = dirname(fileURLToPath(moduleUrl));
  const integrationsDirectory = resolve(extensionDirectory, "..", "..");
  return basename(integrationsDirectory) === "integrations"
    ? resolve(integrationsDirectory, "..")
    : resolve(join(fallbackHome, ".koed"));
};
