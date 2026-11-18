import { extractFile, uncache } from "@electron/asar";
import { isDeepStrictEqual } from "node:util";
import {
  desktopAccountBuildConfig,
  parsePublicAccountConfig
} from "./prepare-account-config.mjs";

/** Inspect the packaged bytes, rather than trusting the generated source file. */
export function verifyPackagedAccountConfig(asarPath, options = {}) {
  const expected = desktopAccountBuildConfig({ ...options, release: true });
  uncache(asarPath);
  const actual = parsePublicAccountConfig(
    extractFile(asarPath, "account-config.json").toString("utf8")
  );
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(
      "Packaged Desktop account settings do not match the release configuration."
    );
  return actual;
}
