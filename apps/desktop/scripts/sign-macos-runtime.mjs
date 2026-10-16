import { signAsync } from "@electron/osx-sign";
import { createRequire } from "node:module";
import { join } from "node:path";
import { finalizeRuntimeManifests } from "./finalize-runtime-manifests.mjs";

const require = createRequire(import.meta.url);

export const signMacosRuntime = async (opts, { sign = signAsync } = {}) => {
  if (require("@electron/osx-sign/package.json").version !== "1.3.3") {
    throw new Error("Runtime signing order requires @electron/osx-sign 1.3.3");
  }
  let outerCalls = 0;
  const optionsForFile = (filePath) => {
    const options = opts.optionsForFile?.(filePath);
    if (filePath === opts.app) {
      if (++outerCalls !== 1)
        throw new Error("Repeated outer app signing callback");
      finalizeRuntimeManifests(
        join(opts.app, "Contents", "Resources", "koed-runtime")
      );
    }
    return options;
  };
  // One pass, no automatic retries: failures abort this release job. The pinned
  // signer invokes this synchronous callback after children, before outer seal.
  await sign({ ...opts, optionsForFile });
  if (outerCalls !== 1)
    throw new Error("Signer omitted outer app signing callback");
};

// electron-builder supplies MacPackager as argument two; never interpret that
// object (which also has a `sign` method) as test dependencies.
export const createMacosSignHook =
  (sign = signAsync) =>
  (opts) =>
    signMacosRuntime(opts, { sign });

export default createMacosSignHook();
