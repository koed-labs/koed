import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const platformDirectory = (platform) =>
  platform === "macos" ? "darwin" : platform === "windows" ? "win32" : platform;

export const prunePrivacyRuntimeForTarget = ({
  repoRoot,
  runtimeRoot,
  platform,
  architecture
}) => {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const policy = readJson(
    resolve(repoRoot, "config/privacy-runtime-package-policy.json")
  );
  for (const [name, version] of Object.entries(policy.packages)) {
    const manifest = resolve(nodeModules, name, "package.json");
    const packageManifest = existsSync(manifest) ? readJson(manifest) : null;
    if (!packageManifest || packageManifest.version !== version) {
      throw new Error(
        `Privacy runtime dependency shape changed for ${name}; review target-pruning policy.`
      );
    }
    const expectedLicense = policy.licenses?.[name];
    if (
      typeof expectedLicense !== "string" ||
      packageManifest.license !== expectedLicense
    ) {
      throw new Error(
        `Privacy runtime licence changed for ${name}; review target-pruning policy and third-party notices.`
      );
    }
  }

  const selectedPlatform = platformDirectory(platform);
  const nativeRoot = resolve(nodeModules, "onnxruntime-node/bin/napi-v6");
  const selectedNative = resolve(nativeRoot, selectedPlatform, architecture);
  if (!existsSync(selectedNative)) {
    throw new Error(
      `onnxruntime-node does not contain ${selectedPlatform}/${architecture}.`
    );
  }
  const targetKey = `${platform}-${architecture}`;
  const expectedNativeFiles = policy.onnxNativeFiles?.[targetKey];
  if (!Array.isArray(expectedNativeFiles)) {
    throw new Error(
      `Privacy runtime dependency shape has no reviewed ONNX file policy for ${targetKey}.`
    );
  }
  const actualNativeFiles = readdirSync(selectedNative, {
    withFileTypes: true
  })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (
    JSON.stringify(actualNativeFiles) !==
    JSON.stringify([...expectedNativeFiles].sort())
  ) {
    throw new Error(
      `Privacy runtime ONNX file shape changed for ${targetKey}; review target-pruning policy.`
    );
  }
  for (const platformEntry of readdirSync(nativeRoot, {
    withFileTypes: true
  })) {
    const platformPath = resolve(nativeRoot, platformEntry.name);
    if (platformEntry.name !== selectedPlatform) {
      rmSync(platformPath, { recursive: true, force: true });
      continue;
    }
    for (const archEntry of readdirSync(platformPath, {
      withFileTypes: true
    })) {
      if (archEntry.name !== architecture) {
        rmSync(resolve(platformPath, archEntry.name), {
          recursive: true,
          force: true
        });
      }
    }
  }

  const sharpRoot = resolve(nodeModules, "@img");
  if (existsSync(sharpRoot)) {
    for (const entry of readdirSync(sharpRoot, { withFileTypes: true })) {
      if (
        entry.name !== "colour" &&
        !entry.name.endsWith(`${selectedPlatform}-${architecture}`)
      ) {
        rmSync(resolve(sharpRoot, entry.name), {
          recursive: true,
          force: true
        });
      }
    }
  }
  const argonPrebuilds = resolve(nodeModules, "argon2", "prebuilds");
  const selectedArgonTarget = `${selectedPlatform}-${architecture}`;
  if (!existsSync(resolve(argonPrebuilds, selectedArgonTarget))) {
    throw new Error(`argon2 does not contain ${selectedArgonTarget}.`);
  }
  for (const entry of readdirSync(argonPrebuilds, { withFileTypes: true })) {
    if (entry.name !== selectedArgonTarget) {
      rmSync(resolve(argonPrebuilds, entry.name), {
        recursive: true,
        force: true
      });
    }
  }
  if (policy.removeStandaloneOnnxruntimeWeb) {
    rmSync(resolve(nodeModules, "onnxruntime-web"), {
      recursive: true,
      force: true
    });
  }
  for (const directory of ["src", "types"]) {
    rmSync(resolve(nodeModules, "@huggingface/transformers", directory), {
      recursive: true,
      force: true
    });
  }
  return {
    platform: selectedPlatform,
    architecture,
    nativeRoot: selectedNative,
    nativeFiles: actualNativeFiles,
    executionProviderFiles: policy.executionProviderFiles?.[targetKey] ?? {},
    standaloneOnnxruntimeWeb: false
  };
};
