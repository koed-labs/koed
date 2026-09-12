import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { relative, resolve } from "node:path";

export const nodePtyVersion = "1.1.0";

const prebuildFiles = new Map([
  ["darwin-arm64", ["pty.node", "spawn-helper"]],
  ["darwin-x64", ["pty.node", "spawn-helper"]],
  [
    "win32-arm64",
    [
      "conpty.node",
      "conpty.pdb",
      "conpty/OpenConsole.exe",
      "conpty/conpty.dll",
      "conpty_console_list.node",
      "conpty_console_list.pdb",
      "pty.node",
      "pty.pdb",
      "winpty-agent.exe",
      "winpty-agent.pdb",
      "winpty.dll",
      "winpty.pdb"
    ]
  ],
  [
    "win32-x64",
    [
      "conpty.node",
      "conpty.pdb",
      "conpty/OpenConsole.exe",
      "conpty/conpty.dll",
      "conpty_console_list.node",
      "conpty_console_list.pdb",
      "pty.node",
      "pty.pdb",
      "winpty-agent.exe",
      "winpty-agent.pdb",
      "winpty.dll",
      "winpty.pdb"
    ]
  ]
]);

const thirdPartyFiles = [
  "conpty/1.23.251008001/win10-arm64/OpenConsole.exe",
  "conpty/1.23.251008001/win10-arm64/conpty.dll",
  "conpty/1.23.251008001/win10-x64/OpenConsole.exe",
  "conpty/1.23.251008001/win10-x64/conpty.dll"
];

const platformDirectory = (platform) =>
  platform === "macos" ? "darwin" : platform === "windows" ? "win32" : platform;

const filesBelow = (root, directory = root, files = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) filesBelow(root, path, files);
    else if (entry.isFile())
      files.push(relative(root, path).replaceAll("\\", "/"));
    else throw new Error(`node-pty contains an unsupported entry: ${path}`);
  }
  return files.sort();
};

const assertFiles = (root, expected, label) => {
  const actual = filesBelow(root);
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((value, index) => value !== wanted[index])
  ) {
    throw new Error(
      `${label} shape changed; review target-pruning policy. Expected ${wanted.join(", ")}; found ${actual.join(", ")}.`
    );
  }
};

const linuxBinaryArchitecture = (path) => {
  const header = readFileSync(path).subarray(0, 20);
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46
  ) {
    return null;
  }
  const machine =
    header[5] === 1
      ? header.readUInt16LE(18)
      : header[5] === 2
        ? header.readUInt16BE(18)
        : null;
  return machine === 62 ? "x64" : machine === 183 ? "arm64" : null;
};

/**
 * Keep one target-appropriate node-pty native runtime. macOS and Windows use
 * their reviewed prebuild; Linux uses the native build produced during deploy.
 */
export const pruneTerminalRuntimeForTarget = ({
  runtimeRoot,
  platform,
  architecture
}) => {
  const packageRoot = resolve(runtimeRoot, "node_modules", "node-pty");
  const manifestPath = resolve(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Staged app runtime is missing node-pty.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.name !== "node-pty" ||
    manifest.version !== nodePtyVersion ||
    manifest.license !== "MIT"
  ) {
    throw new Error(
      "node-pty dependency metadata changed; review target-pruning policy."
    );
  }

  const prebuildsRoot = resolve(packageRoot, "prebuilds");
  const actualTargets = readdirSync(prebuildsRoot, { withFileTypes: true });
  for (const entry of actualTargets) {
    if (!entry.isDirectory() || !prebuildFiles.has(entry.name)) {
      throw new Error(
        `Unknown node-pty prebuild target: ${entry.name}; review target-pruning policy.`
      );
    }
    assertFiles(
      resolve(prebuildsRoot, entry.name),
      prebuildFiles.get(entry.name),
      `node-pty ${entry.name} prebuild`
    );
  }
  if (actualTargets.length !== prebuildFiles.size) {
    throw new Error(
      "node-pty prebuild target set changed; review target-pruning policy."
    );
  }
  assertFiles(
    resolve(packageRoot, "third_party"),
    thirdPartyFiles,
    "node-pty third-party runtime"
  );

  const target = `${platformDirectory(platform)}-${architecture}`;
  const selectedPrebuild = resolve(prebuildsRoot, target);
  const buildRoot = resolve(packageRoot, "build");
  if (!prebuildFiles.has(target)) {
    const nativeBuild = resolve(buildRoot, "Release", "pty.node");
    if (
      platform !== "linux" ||
      !existsSync(nativeBuild) ||
      !lstatSync(nativeBuild).isFile() ||
      linuxBinaryArchitecture(nativeBuild) !== architecture
    ) {
      throw new Error(`node-pty does not contain a usable ${target} runtime.`);
    }
  }

  if (platform === "macos") {
    chmodSync(resolve(selectedPrebuild, "spawn-helper"), 0o755);
  }

  for (const entry of actualTargets) {
    if (entry.name !== target) {
      rmSync(resolve(prebuildsRoot, entry.name), {
        recursive: true,
        force: true
      });
    }
  }
  if (!existsSync(selectedPrebuild)) {
    rmSync(prebuildsRoot, { recursive: true, force: true });
  } else {
    rmSync(buildRoot, { recursive: true, force: true });
  }
  rmSync(resolve(packageRoot, "third_party"), {
    recursive: true,
    force: true
  });

  return {
    platform: platformDirectory(platform),
    architecture,
    runtime: existsSync(selectedPrebuild) ? "prebuild" : "native-build"
  };
};
