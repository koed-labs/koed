import { createRequire } from "node:module";
import { resolve } from "node:path";

export const resolveElectronExecutable = (repoRoot) =>
  createRequire(resolve(repoRoot, "apps/desktop/package.json"))("electron");
