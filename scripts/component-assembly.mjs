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
import { builtinModules } from "node:module";
import ts from "typescript";
import {
  assertNoClaudeAgentSdkPlatformRuntimes,
  removeClaudeAgentSdkPlatformRuntimes
} from "./provider-runtime-package-policy.mjs";
import { prunePrivacyRuntimeForTarget } from "./privacy-runtime-package-policy.mjs";
import { pruneTerminalRuntimeForTarget } from "./terminal-runtime-package-policy.mjs";
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
  if (lstatSync(root).isSymbolicLink()) invalid.push(root);
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

const assertTargetPolicies = (componentRoot, platform, architecture) => {
  assertNoClaudeAgentSdkPlatformRuntimes(componentRoot);
  const prebuildsRoot = resolve(
    componentRoot,
    "node_modules/node-pty/prebuilds"
  );
  if (!existsSync(prebuildsRoot)) return;
  const expected = `${platform === "macos" ? "darwin" : platform === "windows" ? "win32" : platform}-${architecture}`;
  const targets = readdirSync(prebuildsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const expectedTargets = [
    "darwin-arm64",
    "darwin-x64",
    "win32-arm64",
    "win32-x64"
  ].includes(expected)
    ? [expected]
    : [];
  if (
    targets.length !== expectedTargets.length ||
    targets.some((target) => !expectedTargets.includes(target))
  ) {
    throw new Error(
      `Component assembly contains node-pty targets outside ${expected}: ${targets.join(", ")}.`
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

const dynamicImportOwnership = (packageName, file, edge) => {
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(file))
    return "excluded-test-file";
  if (packageName === "bullmq" && /classes\/child-processor\.js$/.test(file))
    return "base-runtime-path";
  if (
    packageName === "real-require" &&
    (file === "src/index.js" || file.endsWith("/src/index.js"))
  )
    return "declared-package-runtime";
  if (packageName === "node-pty" && file === "lib/utils.js")
    return "declared-native-loader-runtime-edge";
  if (packageName === "express" && file === "lib/view.js")
    return "optional-view-engine-runtime-edge";
  if (packageName === "onnxruntime-node" && file === "dist/binding.js")
    return "platform-selected-native-addon-loader";
  if (
    packageName === "sharp" &&
    ["lib/sharp.js", "lib/utility.js"].includes(file)
  )
    return "platform-selected-native-addon-loader";
  if (packageName === "sharp" && file === "lib/libvips.js")
    return "optional-libvips-package-probes";
  if (
    packageName === "@koed/privacy-service" &&
    file === "dist/validation-cache.js"
  )
    return "maintained-local-source-file-set";
  if (packageName === "qs" && file === "dist/qs.js")
    return "bundled-commonjs-module-loader";
  if (
    packageName === "@huggingface/transformers" &&
    [
      "dist/transformers.node.cjs",
      "dist/transformers.node.min.cjs",
      "dist/transformers.node.mjs"
    ].includes(file) &&
    edge.loader === "require.apply" &&
    edge.call === "require.apply" &&
    edge.argumentText === "arguments"
  )
    return "bundled-commonjs-loader-helper";
  if (
    packageName === "@huggingface/transformers" &&
    [
      "dist/transformers.node.cjs",
      "dist/transformers.node.min.cjs",
      "dist/transformers.node.mjs"
    ].includes(file) &&
    edge.loader === "import" &&
    /^[A-Za-z_$][\w$]*$/.test(edge.argumentText ?? "")
  )
    return "optional-worker-module-import";
  if (packageName === "hono" && /utils\/color\.js$/.test(file))
    return "optional-platform-module";
  if (packageName === "@koed/privacy-service" && file === "dist/runtime.js")
    return "declared-provider-dependency";
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
  if (packageName === "fast-json-stringify" && file === "lib/standalone.js")
    return "runtime-generated-standalone-requires";
  return null;
};

const sourceAuditExclusion = (packageName, file) => {
  const basename = file.split("/").at(-1);
  if (
    /^(?:example|benchmark|bench)\.[cm]?js$/.test(basename) ||
    /(?:^|\/)(?:example|benchmark|benchmarks?)(?:\/|$)/.test(file) ||
    /\.bench\.[cm]?js$/.test(file)
  )
    return "example-or-benchmark-entrypoint";
  if (packageName === "safer-buffer" && file === "tests.js")
    return "test-entrypoint";
  if (
    packageName === "@anthropic-ai/claude-agent-sdk" &&
    file === "browser-sdk.js"
  )
    return "non-node-browser-sdk-bundle";
  if (packageName === "global-agent" && file.startsWith("src/"))
    return "uncompiled-flow-source-not-package-entrypoint";
  if (
    packageName === "drizzle-orm" &&
    /^(?:bun-sql|bun-sqlite|expo-sqlite|op-sqlite)\//.test(file)
  )
    return "non-node-platform-entrypoint";
  if (packageName === "pg-cloudflare" && file === "dist/index.js")
    return "cloudflare-platform-entrypoint";
  if (packageName === "split2" && file === "bench.js")
    return "benchmark-entrypoint";
  if (packageName === "node-addon-api" && file.startsWith("tools/"))
    return "build-tooling";
  if (
    ["node-gyp-build", "node-gyp-build-optional-packages"].includes(
      packageName
    ) &&
    file === "bin.js"
  )
    return "build-cli-entrypoint";
  if (packageName === "semver" && file === "bin/semver.js")
    return "cli-entrypoint";
  if (packageName === "msgpackr" && file === "rollup.config.js")
    return "build-tooling";
  if (
    packageName === "@huggingface/transformers" &&
    [
      "dist/transformers.js",
      "dist/transformers.min.js",
      "dist/transformers.web.js",
      "dist/transformers.web.min.js",
      "dist/transformers.node.min.mjs",
      "dist/ort-wasm-simd-threaded.jsep.mjs"
    ].includes(file)
  )
    return "non-selected-transformers-runtime-target";
  if (
    packageName === "onnxruntime-node" &&
    ["script/build.js", "script/prepack.js"].includes(file)
  )
    return "native-addon-build-tooling";
  if (packageName === "sharp" && file.startsWith("install/"))
    return "native-addon-install-tooling";
  if (packageName === "@koed/mcp-server" && file.startsWith("integrations/pi/"))
    return "external-pi-integration";
  return null;
};

const sourceFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") visit(path);
      else if (
        entry.isFile() &&
        /\.(?:[cm]?js)$/.test(entry.name) &&
        !/(?:^|[.-])(?:test|spec)\.[cm]?js$/.test(entry.name) &&
        !/^test(?:s|-).*\.[cm]?js$/.test(entry.name) &&
        entry.name !== "test.js"
      )
        files.push(path);
    }
  };
  visit(root);
  return files;
};

const referenceEdges = (source) => {
  const file = ts.createSourceFile(
    "runtime.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const edges = [];
  const literalValue = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isParenthesizedExpression(node))
      return literalValue(node.expression);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = literalValue(node.left);
      const right = literalValue(node.right);
      return left === null || right === null ? null : left + right;
    }
    return null;
  };
  const specifier = (node, kind = "literal", loader = null, call = null) => {
    const literal = node && literalValue(node);
    if (literal !== null) edges.push({ kind, specifier: literal });
    else
      edges.push({
        kind: kind === "literal" ? "dynamic" : kind,
        loader,
        call,
        argumentText: node?.getText(file)
      });
  };
  const isImportMetaUrl = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta";
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      specifier(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const loader =
        ts.isIdentifier(expression) && expression.text === "require"
          ? "require"
          : ts.isPropertyAccessExpression(expression) &&
              ts.isIdentifier(expression.expression) &&
              expression.expression.text === "require" &&
              expression.name.text === "resolve"
            ? "require.resolve"
            : ts.isMetaProperty(expression) &&
                expression.keywordToken === ts.SyntaxKind.ImportKeyword
              ? "import.meta"
              : null;
      const isImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireApply =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "apply" &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "require";
      const isMetaResolve =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "resolve" &&
        expression.expression.getText(file) === "import.meta";
      if (isImport || loader || isMetaResolve || isRequireApply) {
        const argument = isRequireApply ? node.arguments[1] : node.arguments[0];
        const callLoader = isRequireApply
          ? "require.apply"
          : isImport
            ? "import"
            : (loader ?? "import.meta.resolve");
        const kind = "literal";
        if (argument)
          specifier(argument, kind, callLoader, expression.getText(file));
        else
          edges.push({
            kind: "dynamic",
            loader: isImport ? "import" : (loader ?? "import.meta.resolve")
          });
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      isImportMetaUrl(node.arguments[1])
    ) {
      specifier(node.arguments[0], "asset");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { edges, diagnostics: file.parseDiagnostics };
};

const resolveFileReference = (root, specifier) => {
  const rootIsDirectory = existsSync(root) && lstatSync(root).isDirectory();
  const directoryEntries = rootIsDirectory
    ? ["index.js", "index.mjs", "index.cjs", "index.json", "index.node"].map(
        (name) => resolve(root, name)
      )
    : [];
  const candidates = [
    ...(!rootIsDirectory ? [root] : []),
    ...[".js", ".mjs", ".cjs", ".json", ".node"].map((ext) => `${root}${ext}`),
    ...directoryEntries,
    ...(rootIsDirectory &&
    specifier.endsWith("/") &&
    directoryEntries.every((candidate) => !existsSync(candidate))
      ? [root]
      : [])
  ];
  const matches = candidates.filter((candidate) => {
    if (!existsSync(candidate)) return false;
    const stat = lstatSync(candidate);
    return (
      stat.isFile() ||
      (candidate === root && specifier.endsWith("/") && stat.isDirectory())
    );
  });
  if (matches.length !== 1) return null;
  return matches[0];
};

const selectExportTarget = (entry) => {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry))
    return entry.map(selectExportTarget).find(Boolean) ?? null;
  if (!entry || typeof entry !== "object") return null;
  for (const condition of ["import", "node", "require", "default"]) {
    if (condition in entry) {
      const target = selectExportTarget(entry[condition]);
      if (target) return target;
    }
  }
  return null;
};

const packageImportRoot = (sourceRoot, packageRoot, specifier) => {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  let dependencyRoot;
  try {
    dependencyRoot = resolveDependency(sourceRoot, packageRoot, name);
  } catch {
    return null;
  }
  const subpath = specifier.slice(name.length) || ".";
  const manifest = readManifest(resolve(dependencyRoot, "package.json"));
  const fallback =
    subpath === "." ? (manifest.main ?? "index.js") : `.${subpath}`;
  const exportKey = subpath === "." ? "." : `.${subpath}`;
  let exported = manifest.exports?.[exportKey];
  if (!exported && typeof manifest.exports === "object") {
    const wildcard = Object.entries(manifest.exports).find(([key]) => {
      const [prefix, suffix] = key.split("*");
      return (
        key.includes("*") &&
        exportKey.startsWith(prefix) &&
        exportKey.endsWith(suffix)
      );
    });
    if (wildcard) {
      const [key, value] = wildcard;
      const [prefix, suffix] = key.split("*");
      const capture = exportKey.slice(
        prefix.length,
        exportKey.length - suffix.length || undefined
      );
      const wildcardTarget = selectExportTarget(value?.["."] ?? value);
      exported = wildcardTarget?.replace("*", capture);
    }
  }
  const target = selectExportTarget(exported?.["."] ?? exported) ?? fallback;
  if (
    typeof target !== "string" ||
    target.startsWith("../") ||
    target.startsWith("/")
  )
    return null;
  const resolvedTarget = resolveFileReference(
    resolve(dependencyRoot, target),
    specifier
  );
  return resolvedTarget
    ? { packageRoot: dependencyRoot, target: resolvedTarget }
    : null;
};

const unresolvedRuntimeEdges = (sourceRoot, closure) => {
  const unresolved = [];
  const known = [];
  const excludedSourceFiles = [];
  const included = new Set(
    closure.map(({ packageRoot }) => resolve(packageRoot))
  );
  const builtins = new Set(
    builtinModules.flatMap((name) => [name, `node:${name}`])
  );
  for (const { packageRoot, manifest } of closure) {
    for (const path of sourceFiles(packageRoot)) {
      const file = relative(packageRoot, path).replaceAll("\\", "/");
      if (
        /(?:^|\/)(?:test|tests|__tests__|benchmark|benchmarks|examples|docs|scripts)(?:\/|$)/.test(
          file
        )
      )
        continue;
      if (/^(?:eslint|vitest|jest)\.config\./.test(file)) continue;
      const exclusion = sourceAuditExclusion(manifest.name, file);
      if (exclusion) {
        excludedSourceFiles.push({
          package: manifest.name,
          file,
          reason: exclusion
        });
        continue;
      }
      const { edges, diagnostics } = referenceEdges(readFileSync(path, "utf8"));
      if (diagnostics.length) {
        unresolved.push(
          ...diagnostics.map(
            (diagnostic) =>
              `${manifest.name}:${file}: parser error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
          )
        );
        continue;
      }
      for (const edge of edges) {
        const detail = `${manifest.name}:${file}: ${edge.specifier ?? `${edge.loader ?? edge.kind}(${edge.argumentText ?? ""}) non-literal edge`}`;
        if (!edge.specifier) {
          const owner = dynamicImportOwnership(manifest.name, file, edge);
          if (owner && ["dynamic", "asset"].includes(edge.kind))
            known.push({ detail, owner });
          else unresolved.push(detail);
          continue;
        }
        const edgeSpecifier = edge.specifier;
        if (builtins.has(edgeSpecifier)) continue;
        const packageEdge =
          !edgeSpecifier.startsWith(".") &&
          !edgeSpecifier.startsWith("/") &&
          !edgeSpecifier.startsWith("#");
        const isPackageImport = edgeSpecifier.startsWith("#");
        const specifier = isPackageImport
          ? selectExportTarget(manifest.imports?.[edgeSpecifier])
          : edgeSpecifier;
        const resolved = !specifier
          ? null
          : specifier.startsWith(".") || specifier.startsWith("/")
            ? {
                target: resolveFileReference(
                  resolve(
                    isPackageImport ? packageRoot : dirname(path),
                    specifier
                  ),
                  specifier
                )
              }
            : packageImportRoot(sourceRoot, packageRoot, specifier);
        if (!resolved?.target) {
          const alternativeRuntimeOwner =
            edge.kind === "asset" &&
            manifest.name === "@koed/embedding-service" &&
            file === "dist/env-config.js" &&
            edgeSpecifier === "../.env"
              ? "optional-env-file-guarded-by-existsSync"
              : edge.kind === "asset" &&
                  manifest.name === "@huggingface/transformers" &&
                  edgeSpecifier.endsWith(".wasm")
                ? "onnxruntime-web-optional-wasm-asset"
                : edge.kind === "asset" &&
                    manifest.name === "@koed/privacy-service" &&
                    file === "dist/validation-cache.js"
                  ? "maintained-local-source-file-set"
                  : manifest.name === "drizzle-orm" &&
                      file.startsWith("bun-") &&
                      edgeSpecifier.startsWith("bun:")
                    ? "non-node-runtime-import"
                    : manifest.name === "pg-cloudflare" &&
                        file === "dist/index.js" &&
                        edgeSpecifier === "cloudflare:sockets"
                      ? "cloudflare-runtime-import"
                      : manifest.name === "ajv" &&
                          file === "dist/runtime/re2.js" &&
                          edgeSpecifier === "re2"
                        ? "optional-native-plugin-import"
                        : manifest.name === "@huggingface/transformers" &&
                            edgeSpecifier === "onnxruntime-web/webgpu"
                          ? "non-node-webgpu-provider-import"
                          : manifest.name === "sharp" &&
                              file === "lib/libvips.js" &&
                              edgeSpecifier.startsWith(
                                "@img/sharp-libvips-dev/"
                              )
                            ? "optional-build-only-libvips-package"
                            : null;
          if (alternativeRuntimeOwner) {
            known.push({ detail, owner: alternativeRuntimeOwner });
            continue;
          }
          const dependencyName = edgeSpecifier.startsWith("@")
            ? edgeSpecifier.split("/").slice(0, 2).join("/")
            : edgeSpecifier.split("/")[0];
          const optional =
            Object.hasOwn(
              manifest.optionalDependencies ?? {},
              dependencyName
            ) ||
            manifest.peerDependenciesMeta?.[dependencyName]?.optional === true;
          if (packageEdge && optional) {
            known.push({ detail, owner: "declared-optional-package-edge" });
          } else {
            unresolved.push(`${detail}: unavailable or ambiguous target`);
          }
          continue;
        }
        if (packageEdge && !included.has(resolve(resolved.packageRoot))) {
          unresolved.push(`${detail}: package is outside declared closure`);
        }
      }
    }
  }
  return { unresolved, known, excludedSourceFiles };
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
  const runtimeEdges = unresolvedRuntimeEdges(sourceRoot, closure);
  if (runtimeEdges.unresolved.length) {
    throw new Error(
      `Component dependency graph has unresolved runtime edges:\n${runtimeEdges.unresolved.slice(0, 30).join("\n")}`
    );
  }
  for (const { packageRoot } of closure)
    copyPackage(sourceRoot, componentRoot, packageRoot);
  writeNotices(componentRoot, closure);
  const required = componentFiles(componentRoot);
  writeFileSync(
    resolve(componentRoot, "component-assembly-inventory.json"),
    `${JSON.stringify({ schemaVersion: 2, excludedPackages, verifiedLiteralEdges: true, maintainedRuntimeEdges: runtimeEdges.known, unresolvedRuntimeEdges: runtimeEdges.unresolved, excludedSourceFiles: runtimeEdges.excludedSourceFiles, auditScope: "TypeScript JavaScript AST audit of .js, .cjs, and .mjs files in declared package closures; parser errors fail assembly.", scanLimits: ["Static import/export, import(), require(), require.resolve(), import.meta.resolve(), require.apply(), and new URL(literal, import.meta.url) references are checked.", "Dynamic loader and optional asset edges require named maintainedRuntimeEdges ownership; excluded source files are listed with reasons.", "Computed paths, arbitrary loaders, native addon internals, and behavior assembled through arbitrary control flow are not fully inferable statically; successful loader smoke tests validate only selected host-target entries."], required }, null, 2)}\n`
  );
  assertSafeTree(componentRoot);
  return { root: componentRoot, required, closure };
};

export const projectRuntimeComponents = ({
  sourceRoot,
  outputDir,
  excludedPackages = []
}) => {
  assertSafeTree(sourceRoot);
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
    removeClaudeAgentSdkPlatformRuntimes(sharedRoot);
    pruneTerminalRuntimeForTarget({
      runtimeRoot: sharedRoot,
      platform,
      architecture
    });
    assertNoClaudeAgentSdkPlatformRuntimes(sharedRoot);
    const result = projectRuntimeComponents({
      sourceRoot: sharedRoot,
      outputDir,
      excludedPackages
    });
    pruneSharedAppRuntimeMetadata(result.baseRoot);
    pruneSharedAppRuntimeMetadata(result.privacyRoot);
    assertTargetPolicies(result.baseRoot, platform, architecture);
    assertTargetPolicies(result.privacyRoot, platform, architecture);
    result.baseRequired = refreshRequiredFiles(result.baseRoot);
    result.privacyRequired = refreshRequiredFiles(result.privacyRoot);
    return result;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};
