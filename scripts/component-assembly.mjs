import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { prunePrivacyRuntimeForTarget } from "./privacy-runtime-package-policy.mjs";
import {
  pruneSharedAppRuntimeMetadata,
  stageSharedAppRuntime
} from "./app-runtime-staging.mjs";

const servicePackages = {
  api: "@koed/api",
  worker: "@koed/worker",
  "embedding-service": "@koed/embedding-service",
  "mcp-server": "@koed/mcp-server",
  "koed-server": "@koed-labs/server",
  "privacy-service": "@koed/privacy-service"
};
const baseServices = [
  "api",
  "worker",
  "embedding-service",
  "mcp-server",
  "koed-server"
];
const privacyServices = ["privacy-service"];
const licensePattern = /^(?:licen[cs]e|notice|copying)(?:\.|$)/i;

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"));

const resolveDependency = (sourceRoot, packageRoot, name) => {
  let current = packageRoot;
  while (current.startsWith(sourceRoot)) {
    const candidate = resolve(current, "node_modules", name);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Runtime dependency ${name} from ${packageRoot} is unresolved.`
  );
};

const packageClosure = (sourceRoot, rootNames, excludedPackages = []) => {
  const excluded = new Set(excludedPackages);
  const visited = new Map();
  const visit = (packageRoot) => {
    const manifestPath = resolve(packageRoot, "package.json");
    const manifest = readManifest(manifestPath);
    if (!manifest.name || !manifest.version) {
      throw new Error(
        `Runtime package manifest lacks name/version: ${manifestPath}`
      );
    }
    const identity = `${resolve(packageRoot)}\0${manifest.version}`;
    if (visited.has(identity)) return;
    visited.set(identity, { packageRoot, manifest });
    const dependencies = Object.entries(manifest.dependencies ?? {}).map(
      ([name]) => ({ name, optional: false })
    );
    dependencies.push(
      ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({
        name,
        optional: true
      }))
    );
    dependencies.push(
      ...Object.keys(manifest.peerDependencies ?? {}).map((name) => ({
        name,
        optional: manifest.peerDependenciesMeta?.[name]?.optional === true
      }))
    );
    for (const { name, optional } of dependencies.sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      let dependencyRoot;
      try {
        dependencyRoot = resolveDependency(sourceRoot, packageRoot, name);
      } catch (error) {
        if (!optional && !excluded.has(name)) throw error;
        continue;
      }
      visit(dependencyRoot);
    }
  };
  for (const name of rootNames) {
    visit(
      resolveDependency(sourceRoot, resolve(sourceRoot, "node_modules"), name)
    );
  }
  return [...visited.values()];
};

const assertSafeTree = (root) => {
  const invalid = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        invalid.push(path);
      } else if (stat.isDirectory()) visit(path);
    }
  };
  visit(root);
  if (invalid.length) {
    throw new Error(
      `Component assembly contains unsupported entries:\n${invalid.slice(0, 20).join("\n")}`
    );
  }
};

const copyPackage = (sourceRoot, componentRoot, packageRoot) => {
  const relativePath = relative(
    resolve(sourceRoot, "node_modules"),
    packageRoot
  );
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Runtime package escapes node_modules: ${packageRoot}`);
  }
  const target = resolve(componentRoot, "node_modules", relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(packageRoot, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true
  });
};

const componentFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort();
};

const dynamicImportOwnership = (packageName, file) => {
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(file))
    return "excluded-test-file";
  if (packageName === "bullmq" && /classes\/child-processor\.js$/.test(file))
    return "base-runtime-path";
  if (
    packageName === "real-require" &&
    (file === "src/index.js" || file.endsWith("/src/index.js"))
  )
    return "declared-package-runtime";
  if (packageName === "hono" && /utils\/color\.js$/.test(file))
    return "optional-platform-module";
  if (packageName === "@koed/privacy-service" && file === "dist/runtime.js")
    return "declared-provider-dependency";
  if (packageName === "@huggingface/transformers")
    return "package-runtime-assets";
  if (packageName === "onnxruntime-web")
    return "excluded-by-node-target-policy";
  if (
    packageName === "@koed/mcp-server" &&
    file === "integrations/pi/managed-rpc-host.mjs"
  )
    return "external-ai-client-sdk-path";
  if (
    packageName === "@koed-labs/server" &&
    ["dist/local-api-token.js", "dist/privacy-service-bootstrap.js"].includes(
      file
    )
  )
    return "selected-runtime-component-path";
  return null;
};

const unresolvedDynamicImports = (closure) => {
  const unresolved = [];
  const known = [];
  for (const { packageRoot, manifest } of closure) {
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules") visit(path);
        else if (
          entry.isFile() &&
          /\.(?:[cm]?js)$/.test(entry.name) &&
          !/(?:^|\/)(?:test|tests|__tests__|benchmark|benchmarks|examples|docs|scripts)(?:\/|$)/.test(
            relative(packageRoot, path)
          ) &&
          !/^(?:eslint|vitest|jest)\.config\./.test(entry.name)
        ) {
          const source = readFileSync(path, "utf8").replace(
            /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
            " "
          );
          if (/\bimport\s*\(\s*(?!["'`])/.test(source)) {
            const file = relative(packageRoot, path).replaceAll("\\", "/");
            const owner = dynamicImportOwnership(manifest.name, file);
            const detail = `${manifest.name}:${file}: non-literal import()`;
            if (owner) known.push({ detail, owner });
            else unresolved.push(detail);
          }
        }
      }
    };
    visit(packageRoot);
  }
  return { unresolved, known };
};

const refreshRequiredFiles = (componentRoot) => {
  const inventoryPath = resolve(
    componentRoot,
    "component-assembly-inventory.json"
  );
  const inventory = readManifest(inventoryPath);
  const required = componentFiles(componentRoot);
  writeFileSync(
    inventoryPath,
    `${JSON.stringify({ ...inventory, required }, null, 2)}\n`
  );
  return required;
};

const writeNotices = (componentRoot, closure) => {
  const packages = closure
    .map(({ packageRoot, manifest }) => ({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? null,
      files: readdirSync(packageRoot)
        .filter((name) => licensePattern.test(name))
        .sort()
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
    );
  writeFileSync(
    resolve(componentRoot, "third-party-notices.json"),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`
  );
};

const projectComponent = (
  sourceRoot,
  componentRoot,
  services,
  packageNames,
  excludedPackages = []
) => {
  mkdirSync(componentRoot, { recursive: true });
  for (const service of services) {
    const source = resolve(sourceRoot, service);
    if (!existsSync(source))
      throw new Error(`Component service root is missing: ${source}`);
    cpSync(source, resolve(componentRoot, service), {
      recursive: true,
      dereference: false
    });
  }
  const closure = packageClosure(sourceRoot, packageNames, excludedPackages);
  const dynamicImports = unresolvedDynamicImports(closure);
  if (dynamicImports.unresolved.length) {
    throw new Error(
      `Component dependency graph has unresolved dynamic imports:\n${dynamicImports.unresolved.slice(0, 20).join("\n")}`
    );
  }
  for (const { packageRoot } of closure)
    copyPackage(sourceRoot, componentRoot, packageRoot);
  writeNotices(componentRoot, closure);
  const required = componentFiles(componentRoot);
  writeFileSync(
    resolve(componentRoot, "component-assembly-inventory.json"),
    `${JSON.stringify({ schemaVersion: 1, excludedPackages, knownDynamicImports: dynamicImports.known, unresolvedDynamicImports: dynamicImports.unresolved, unresolvedAssets: [], required }, null, 2)}\n`
  );
  assertSafeTree(componentRoot);
  return { root: componentRoot, required, closure };
};

export const projectRuntimeComponents = ({
  sourceRoot,
  outputDir,
  excludedPackages = []
}) => {
  const baseNames = baseServices.map((service) => servicePackages[service]);
  const privacyName = servicePackages["privacy-service"];
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const base = projectComponent(
    sourceRoot,
    resolve(outputDir, "base"),
    baseServices,
    baseNames
  );
  const privacy = projectComponent(
    sourceRoot,
    resolve(outputDir, "privacy"),
    privacyServices,
    [privacyName],
    excludedPackages
  );
  return {
    baseRoot: base.root,
    privacyRoot: privacy.root,
    baseRequired: base.required,
    privacyRequired: privacy.required
  };
};

export const stageRuntimeComponents = async ({
  repoRoot,
  outputDir,
  platform,
  architecture
}) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "koed-component-stage-"));
  const sharedRoot = resolve(temporaryRoot, "shared-runtime");
  try {
    stageSharedAppRuntime({ repoRoot, runtimeRoot: sharedRoot });
    prunePrivacyRuntimeForTarget({
      repoRoot,
      runtimeRoot: sharedRoot,
      platform,
      architecture
    });
    const privacyPolicy = readManifest(
      resolve(repoRoot, "config/privacy-runtime-package-policy.json")
    );
    const excludedPackages = privacyPolicy.removeStandaloneOnnxruntimeWeb
      ? ["onnxruntime-web"]
      : [];
    const result = projectRuntimeComponents({
      sourceRoot: sharedRoot,
      outputDir,
      excludedPackages
    });
    pruneSharedAppRuntimeMetadata(result.baseRoot);
    pruneSharedAppRuntimeMetadata(result.privacyRoot);
    result.baseRequired = refreshRequiredFiles(result.baseRoot);
    result.privacyRequired = refreshRequiredFiles(result.privacyRoot);
    return result;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};
