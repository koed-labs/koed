#!/usr/bin/env node
// Candidate production only. This does not run device discovery or inference.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256File } from "./manifest-lib.mjs";
import { verifyFrozenCore } from "./core-artifact.mjs";
import {
  assertCudaCoreCompatibility,
  freezeCuda,
  packageFrozenCuda,
  verifyFrozenCuda
} from "./cuda-artifact.mjs";
import {
  pruneNativeRuntimeBuildArtifacts,
  stripNativeRuntimeBinaries
} from "./content-policy.mjs";

const repo = resolve(import.meta.dirname, "../..");
const buildRoot = "/tmp/koed-native-cuda-v1";
const toolkitRoot = "/usr/local/cuda-12.4";
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.stderr || result.error?.message || result.stdout}`
    );
  return result.stdout?.trim() ?? "";
};
const filesUnder = (root) =>
  readdirSync(root, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = resolve(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
const toolkitIdentity = () => {
  const root = realpathSync(toolkitRoot);
  return filesUnder(root).map((path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Unsupported toolkit input: ${path}`);
    const real = realpathSync(path);
    const target = lstatSync(real);
    if (target.isDirectory() && !inside(root, real))
      throw new Error(`Toolkit directory link escapes its root: ${path}`);
    return {
      path: relative(root, path),
      mode: stat.mode & 0o777,
      ...(stat.isSymbolicLink() ? { target: readlinkSync(path) } : {}),
      ...(target.isFile()
        ? { bytes: target.size, sha256: sha256File(real) }
        : {})
    };
  });
};
const identifyToolchain = () => ({
  osRelease: readFileSync("/etc/os-release", "utf8"),
  packages: run("dpkg-query", ["-W", "-f=${binary:Package}=${Version}\n"])
    .split("\n")
    .sort(),
  node: { version: process.version, sha256: sha256File(process.execPath) },
  tools: Object.fromEntries(
    [
      "gcc",
      "g++",
      "ld",
      "as",
      "ar",
      "make",
      "cmake",
      "strip",
      "readelf",
      "tar",
      "curl"
    ].map((name) => {
      const path = realpathSync(`/usr/bin/${name}`);
      return [
        name,
        { sha256: sha256File(path), version: run(path, ["--version"]) }
      ];
    })
  ),
  nvcc: {
    version: run(`${toolkitRoot}/bin/nvcc`, ["--version"]),
    sha256: sha256File(realpathSync(`${toolkitRoot}/bin/nvcc`))
  },
  toolkit: toolkitIdentity(),
  hostLibraries: Object.fromEntries(
    ["libstdc++.so.6", "libgcc_s.so.1", "libgomp.so.1"].map((name) => {
      const path = realpathSync(run("g++", [`-print-file-name=${name}`]));
      return [name, sha256File(path)];
    })
  )
});

// Inspect ELF metadata instead of executing a payload or invoking its loader.
const neededLibraries = (path) =>
  run("readelf", ["-d", path])
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/\(NEEDED\).*\[([^\]]+)\]/);
      return match ? [match[1]] : [];
    });
const stageRuntime = (binaryRoot, destination, sourceRoot) => {
  const files = filesUnder(binaryRoot).filter(
    (path) =>
      basename(path) === "llama-server" ||
      /\.so(?:\.\d+)*$/.test(basename(path))
  );
  const cudaRoot = realpathSync(toolkitRoot);
  const extra = new Map();
  for (let index = 0; index < files.length; index += 1) {
    const path = files[index];
    for (const name of neededLibraries(path)) {
      if (/^libcuda\.so(?:\.\d+)*$/.test(name)) continue; // The host driver is never bundled.
      if (!/^libcu/.test(name)) continue;
      if (!/^(libcudart|libcublas|libcublasLt)\.so(?:\.\d+)*$/.test(name))
        throw new Error(`Unreviewed CUDA runtime dependency: ${name}`);
      const library = ["targets/x86_64-linux/lib", "lib64"]
        .map((dir) => resolve(cudaRoot, dir, name))
        .find(existsSync);
      if (!library || !inside(cudaRoot, realpathSync(library)))
        throw new Error(
          `CUDA toolkit dependency is missing or external: ${name}`
        );
      if (!extra.has(name)) {
        extra.set(name, library);
        files.push(library);
      }
    }
  }
  // Flatten direct aliases to one physical file, without duplicate library bytes
  // or archive link chains. Retain the toolkit's real versioned filename.
  const physical = new Map(),
    names = new Map();
  for (const path of files) {
    const real = realpathSync(path);
    if (!lstatSync(real).isFile())
      throw new Error(`Invalid CUDA runtime file: ${path}`);
    const canonical = basename(real);
    const prior = physical.get(canonical);
    if (prior && prior !== real)
      throw new Error(`CUDA runtime filename collision: ${canonical}`);
    physical.set(canonical, real);
    for (const name of [basename(path), canonical]) {
      const priorName = names.get(name);
      if (priorName && priorName !== canonical)
        throw new Error(`CUDA alias collision: ${name}`);
      names.set(name, canonical);
    }
  }
  mkdirSync(destination, { recursive: true });
  for (const [name, path] of physical)
    copyFileSync(path, resolve(destination, name));
  for (const [name, canonical] of names)
    if (name !== canonical) symlinkSync(canonical, resolve(destination, name));
  copyFileSync(resolve(sourceRoot, "LICENSE"), resolve(destination, "LICENSE"));
  copyFileSync(
    resolve(cudaRoot, "EULA.txt"),
    resolve(destination, "CUDA-EULA.txt")
  );
};

export const buildCudaAddon = ({ coreDir, outDir, sourceDir }) => {
  const coreRoot = realpathSync(coreDir);
  const core = verifyFrozenCore(coreRoot);
  const out = resolve(realpathSync(dirname(resolve(outDir))), basename(outDir));
  if (
    inside(coreRoot, out) ||
    (sourceDir && inside(realpathSync(sourceDir), out))
  )
    throw new Error("Candidate output must be outside both frozen payloads.");
  mkdirSync(out);
  const runtimeRoot = resolve(out, "koed-runtime");
  if (sourceDir) {
    const manifest = verifyFrozenCuda(sourceDir);
    assertCudaCoreCompatibility(core, manifest);
    cpSync(realpathSync(sourceDir), runtimeRoot, {
      recursive: true,
      verbatimSymlinks: true
    });
    return packageFrozenCuda({ runtimeRoot, outDir: out });
  }
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.getuid?.() === 0 ||
    !/^VERSION_ID="22\.04"$/m.test(readFileSync("/etc/os-release", "utf8")) ||
    !/\b2\.35\b/.test(run("ldd", ["--version"]))
  )
    throw new Error(
      "Cold CUDA builds require an unprivileged Linux x64 user on Ubuntu 22.04 / glibc 2.35 with CUDA toolkit 12.4."
    );
  const configuration = JSON.parse(
    readFileSync(new URL("./cuda.linux-x64.json", import.meta.url), "utf8")
  );
  assertCudaCoreCompatibility(core, {
    kind: "cuda",
    target: configuration.target,
    contracts: configuration.contracts,
    llamaCpp: configuration.llamaCpp
  });
  mkdirSync(buildRoot);
  const previousEnvironment = { ...process.env },
    previousUmask = process.umask();
  try {
    const environment = {
      PATH: `${toolkitRoot}/bin:/usr/bin:/bin`,
      HOME: resolve(buildRoot, "home"),
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: "0",
      CC: "/usr/bin/gcc",
      CXX: "/usr/bin/g++",
      CUDACXX: `${toolkitRoot}/bin/nvcc`,
      CUDAHOSTCXX: "/usr/bin/g++",
      CUDA_HOME: toolkitRoot,
      CFLAGS: `-O2 -march=x86-64 -mtune=generic -ffile-prefix-map=${buildRoot}=/usr/src/koed-native-cuda`,
      CXXFLAGS: `-O2 -march=x86-64 -mtune=generic -ffile-prefix-map=${buildRoot}=/usr/src/koed-native-cuda`,
      LDFLAGS: "",
      MAKEFLAGS: ""
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    process.umask(0o022);
    mkdirSync(environment.HOME);
    const toolchain = identifyToolchain();
    if (!/release 12\.4\b/.test(toolchain.nvcc.version))
      throw new Error(
        "CUDA toolkit 12.4 is required; unpinned-toolkit overrides are not accepted."
      );
    const source = resolve(buildRoot, "source"),
      build = resolve(buildRoot, "build");
    const flags = [
      "-G",
      "Unix Makefiles",
      "-DGGML_CUDA=ON",
      "-DGGML_NATIVE=OFF",
      "-DLLAMA_CURL=OFF",
      "-DLLAMA_BUILD_TESTS=OFF",
      "-DLLAMA_BUILD_EXAMPLES=OFF",
      "-DLLAMA_BUILD_SERVER=ON",
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON",
      "-DCMAKE_BUILD_RPATH=$ORIGIN",
      "-DCMAKE_INSTALL_RPATH=$ORIGIN",
      `-DCMAKE_CUDA_ARCHITECTURES=${configuration.cuda.architectures.join(";")}`
    ];
    const recipe = {
      schemaVersion: 1,
      kind: "cuda",
      configuration,
      toolchain,
      environment,
      build: { configure: flags, target: "llama-server", jobs: 2 },
      logic: Object.fromEntries(
        [
          "scripts/native-runtime/build-cuda-addon-linux-x64.mjs",
          "scripts/native-runtime/cuda-artifact.mjs",
          "scripts/native-runtime/content-policy.mjs",
          "scripts/native-runtime/loader-validation-lib.mjs",
          "scripts/native-runtime/manifest-lib.mjs",
          "scripts/deterministic-tar-gzip.mjs",
          "packages/koed-server/src/artifact-canonical-json.mjs"
        ].map((path) => [path, sha256File(resolve(repo, path))])
      ),
      packaging: {
        format: "ustar-pax-gzip",
        root: "koed-runtime",
        epoch: 0,
        uid: 0,
        gid: 0,
        compression: "node:zlib createGzip, default level, mtime 0",
        strip: "--strip-unneeded",
        links: "direct-contained-files",
        hostDriver: "excluded"
      }
    };
    const archive = resolve(buildRoot, "llama-source.tar.gz");
    run(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--max-time",
        "600",
        "--output",
        archive,
        configuration.llamaCpp.url
      ],
      { timeout: 660_000, stdio: "inherit" }
    );
    if (sha256File(archive) !== configuration.llamaCpp.sha256)
      throw new Error(
        "CUDA source archive digest differs from its reviewed pin."
      );
    mkdirSync(source);
    run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    run("cmake", ["-S", source, "-B", build, ...flags], {
      timeout: 300_000,
      stdio: "inherit"
    });
    run(
      "cmake",
      [
        "--build",
        build,
        "--config",
        "Release",
        "--target",
        "llama-server",
        "-j",
        "2"
      ],
      { timeout: 7_200_000, stdio: "inherit" }
    );
    stageRuntime(
      resolve(build, "bin"),
      resolve(runtimeRoot, "llama.cpp/cuda"),
      source
    );
    pruneNativeRuntimeBuildArtifacts(runtimeRoot);
    stripNativeRuntimeBinaries({ runtimeRoot, platform: "linux" });
    freezeCuda({ runtimeRoot, configuration, recipe });
    return packageFrozenCuda({ runtimeRoot, outDir: out });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    process.umask(previousUmask);
    rmSync(buildRoot, { recursive: true, force: true });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "core-dir": { type: "string" },
      "out-dir": { type: "string" },
      "source-dir": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help)
    console.log(
      "Usage: node scripts/native-runtime/build-cuda-addon-linux-x64.mjs --core-dir <frozen-core> --out-dir <new-directory> [--source-dir <frozen-cuda>] [--json]"
    );
  else {
    if (!values["core-dir"] || !values["out-dir"])
      throw new Error("Provide --core-dir and a new --out-dir.");
    console.log(
      JSON.stringify(
        buildCudaAddon({
          coreDir: values["core-dir"],
          outDir: values["out-dir"],
          sourceDir: values["source-dir"]
        }),
        null,
        2
      )
    );
  }
}
