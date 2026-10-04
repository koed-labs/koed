import { resolve } from "node:path";
import { verifyPreloadBundles } from "./verify-preload-bundle.mjs";

export default async function beforePack(context) {
  // TypeScript emits unbundled preloads. Reject them even when packaging is
  // invoked directly instead of through the normal build:package command.
  await verifyPreloadBundles(
    resolve(context.packager.projectDir, "dist-electron")
  );
}
