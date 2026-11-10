import { resolve } from "node:path";

export function selectDesktopRuntimeProvider(options: {
  platform: NodeJS.Platform;
  koedHome: string;
  packagedManifest: string | null;
  exists: (path: string) => boolean;
}): "release" | "packaged" | "homebrew" {
  if (options.platform === "linux") {
    const cache = resolve(options.koedHome, "cache");
    // Existing providers retain their own admission and update paths. Unknown
    // entries reach release admission, which refuses to migrate them implicitly.
    if (options.exists(resolve(options.koedHome, "runtime", "native")))
      return "release";
    if (options.exists(resolve(cache, "runtime-homebrew.json")))
      return "homebrew";
    if (options.exists(resolve(cache, "runtime-packaged.json")))
      return "packaged";
    return "release";
  }
  return options.packagedManifest && options.exists(options.packagedManifest)
    ? "packaged"
    : "homebrew";
}
