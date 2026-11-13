import { resolve } from "node:path";

export const createNativeBuildPlan = ({
  platform,
  electronVersion,
  arch,
  desktopRoot
}) => {
  if (platform !== "darwin") return undefined;
  if (!/^\d+\.\d+\.\d+$/u.test(electronVersion))
    throw new Error("Electron version must be an exact version.");
  if (arch !== "arm64" && arch !== "x64")
    throw new Error("architecture must be arm64 or x64.");

  const root = resolve(desktopRoot);
  const buildRoot = resolve(
    root,
    "../../scratch/macos-background-native-build"
  );
  return {
    configureArgs: [
      "configure",
      `--target=${electronVersion}`,
      "--dist-url=https://electronjs.org/headers",
      `--arch=${arch}`
    ],
    buildArgs: ["build"],
    desktopRoot: root,
    buildRoot,
    sourcePath: resolve(buildRoot, "build/Release/koed_background_xpc.node"),
    destinationPath: resolve(
      root,
      "dist-electron/background-agent/native/koed_background_xpc.node"
    )
  };
};
