import {
  sourceAuditExclusion,
  classifyRuntimeException
} from "./component-assembly-policy.mjs";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";
import enhancedResolve from "enhanced-resolve";
import ts from "typescript";
import {
  assertNoClaudeAgentSdkPlatformRuntimes,
  removeClaudeAgentSdkPlatformRuntimes
} from "./provider-runtime-package-policy.mjs";
import {
  prunePrivacyRuntimeForTarget,
  prunePrivacyRuntimeVariant
} from "./privacy-runtime-package-policy.mjs";
import { pruneTerminalRuntimeForTarget } from "./terminal-runtime-package-policy.mjs";
import {
  pruneSharedAppRuntimeMetadata,
  packageDirectories,
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

const sourceFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js)$/.test(entry.name))
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
  const createRequireBindings = new Set();
  const createRequireNamespaces = new Set();
  const requireBindings = new Set(["require"]);
  const isImportMetaUrl = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta";
  const moduleRequire = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0]) &&
    ["module", "node:module"].includes(node.arguments[0].text);
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ["module", "node:module"].includes(statement.moduleSpecifier.text)
    ) {
      if (ts.isImportClause(statement.importClause)) {
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements)
            if ((element.propertyName ?? element.name).text === "createRequire")
              createRequireBindings.add(element.name.text);
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          createRequireNamespaces.add(bindings.name.text);
        }
      }
    }
  }
  const isCreateRequireFactory = (expression) =>
    (ts.isIdentifier(expression) &&
      createRequireBindings.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "createRequire" &&
      ((ts.isIdentifier(expression.expression) &&
        createRequireNamespaces.has(expression.expression.text)) ||
        moduleRequire(expression.expression)));
  const collectBindings = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer;
      const isFactory =
        ts.isCallExpression(initializer) &&
        isCreateRequireFactory(initializer.expression);
      if (isFactory && ts.isIdentifier(node.name))
        requireBindings.add(node.name.text);
      if (moduleRequire(initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements)
          if (
            (element.propertyName ?? element.name).getText(file) ===
            "createRequire"
          )
            createRequireBindings.add(element.name.getText(file));
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);
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
  const specifier = (
    node,
    kind = "literal",
    loader = "import",
    call = null
  ) => {
    const literal = node && literalValue(node);
    if (literal !== null) edges.push({ kind, specifier: literal, loader });
    else
      edges.push({
        kind: kind === "literal" ? "dynamic" : kind,
        loader,
        call,
        argumentText: node?.getText(file)
      });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      specifier(node.moduleSpecifier, "literal", "import");
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const directCreateRequire =
        ts.isCallExpression(expression) &&
        isCreateRequireFactory(expression.expression) &&
        expression.arguments.length === 1 &&
        isImportMetaUrl(expression.arguments[0]);
      const directCreateRequireResolve =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "resolve" &&
        ts.isCallExpression(expression.expression) &&
        isCreateRequireFactory(expression.expression.expression) &&
        expression.expression.arguments.length === 1 &&
        isImportMetaUrl(expression.expression.arguments[0]);
      const callerCreateRequireResolve =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "resolve" &&
        ts.isCallExpression(expression.expression) &&
        isCreateRequireFactory(expression.expression.expression) &&
        expression.expression.arguments.length === 1 &&
        !isImportMetaUrl(expression.expression.arguments[0]);
      const aliasRequire =
        ts.isIdentifier(expression) && requireBindings.has(expression.text);
      const loader = aliasRequire
        ? "require"
        : ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            requireBindings.has(expression.expression.text) &&
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
        requireBindings.has(expression.expression.text);
      const isMetaResolve =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "resolve" &&
        expression.expression.getText(file) === "import.meta";
      if (
        isImport ||
        loader ||
        directCreateRequireResolve ||
        callerCreateRequireResolve ||
        isMetaResolve ||
        isRequireApply ||
        directCreateRequire
      ) {
        const argument = directCreateRequire
          ? node.arguments[0]
          : isRequireApply
            ? node.arguments[1]
            : node.arguments[0];
        const callLoader = directCreateRequire
          ? "require"
          : directCreateRequireResolve || callerCreateRequireResolve
            ? "require.resolve"
            : isRequireApply
              ? "require.apply"
              : isImport
                ? "import"
                : (loader ?? "import.meta.resolve");
        if (argument)
          specifier(argument, "literal", callLoader, expression.getText(file));
        else edges.push({ kind: "dynamic", loader: callLoader });
      } else if (
        isCreateRequireFactory(expression) &&
        node.arguments.length &&
        !isImportMetaUrl(node.arguments[0])
      ) {
        edges.push({
          kind: "dynamic",
          loader: "createRequire",
          call: ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : expression.getText(file),
          argumentText: node.arguments[0].getText(file)
        });
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      isImportMetaUrl(node.arguments[1])
    ) {
      specifier(node.arguments[0], "asset", "asset");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { edges, diagnostics: file.parseDiagnostics };
};

const nodeResolvers = new Map();
const nodeResolver = (loader) => {
  const kind =
    loader === "require" ||
    loader === "require.resolve" ||
    loader === "require.apply"
      ? "require"
      : "import";
  if (!nodeResolvers.has(kind)) {
    nodeResolvers.set(
      kind,
      enhancedResolve.create.sync({
        conditionNames: ["node", "node-addons", kind, "default"],
        extensions: [".js", ".mjs", ".cjs", ".json", ".node"],
        fullySpecified: kind === "import",
        mainFields: ["main"],
        exportsFields: ["exports"],
        importsFields: ["imports"]
      })
    );
  }
  return nodeResolvers.get(kind);
};

const isWithin = (root, path) => {
  const canonicalRoot = realpathSync(root);
  const canonicalPath = realpathSync(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")
  );
};

const resolveNodeEdge = (sourceRoot, packageRoot, path, edge, included) => {
  const specifier = edge.specifier;
  if (isAbsolute(specifier))
    return { error: "absolute source target is nonportable" };
  const packageEdge = !specifier.startsWith(".") && !specifier.startsWith("#");
  const isPackageImport = specifier.startsWith("#");
  let expectedPackageRoot = packageRoot;
  if (packageEdge) {
    const parts = specifier.split("/");
    const name = specifier.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0];
    try {
      expectedPackageRoot = resolveDependency(sourceRoot, packageRoot, name);
    } catch {
      return null;
    }
  }
  let target;
  if (edge.kind === "asset") {
    const assetPath = resolve(dirname(path), specifier);
    if (!existsSync(assetPath)) return null;
    const assetStat = lstatSync(assetPath);
    if (
      !assetStat.isFile() &&
      !(specifier.endsWith("/") && assetStat.isDirectory())
    )
      return null;
    target = assetPath;
  } else {
    try {
      target = nodeResolver(edge.loader)(dirname(path), specifier);
    } catch {
      return null;
    }
  }
  if (!target) return null;
  if (!isWithin(sourceRoot, target))
    return { error: "resolved source target escapes shared runtime root" };
  if (isPackageImport && !isWithin(expectedPackageRoot, target)) {
    const owner = [...included]
      .sort((left, right) => right.length - left.length)
      .find((root) => isWithin(root, target));
    if (!owner)
      return {
        error: "resolved package import escapes declared dependency ownership"
      };
    expectedPackageRoot = owner;
  }
  if (!isWithin(expectedPackageRoot, target))
    return { error: "resolved source target escapes copied package ownership" };
  return {
    packageRoot:
      packageEdge || isPackageImport ? expectedPackageRoot : packageRoot,
    target,
    packageEdge,
    isPackageImport
  };
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
          const policy = classifyRuntimeException(
            manifest.name,
            file,
            edge,
            closure
          );
          if (policy?.error) unresolved.push(detail + ": " + policy.error);
          else if (policy)
            known.push({
              detail,
              ...policy,
              loader: edge.loader,
              call: edge.call,
              argumentText: edge.argumentText
            });
          else unresolved.push(detail);
          continue;
        }
        const edgeSpecifier = edge.specifier;
        if (builtins.has(edgeSpecifier)) continue;
        const packageEdge =
          !edgeSpecifier.startsWith(".") &&
          !isAbsolute(edgeSpecifier) &&
          !edgeSpecifier.startsWith("#");
        const resolved = resolveNodeEdge(
          sourceRoot,
          packageRoot,
          path,
          edge,
          included
        );
        if (resolved?.error) {
          unresolved.push(`${detail}: ${resolved.error}`);
          continue;
        }
        if (!resolved?.target) {
          const policy = classifyRuntimeException(
            manifest.name,
            file,
            edge,
            closure
          );
          if (policy) {
            known.push({ detail, ...policy });
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
        if (
          resolved.packageEdge &&
          !included.has(resolve(resolved.packageRoot))
        ) {
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
    `${JSON.stringify({ schemaVersion: 2, excludedPackages, verifiedLiteralEdges: true, maintainedRuntimeEdges: runtimeEdges.known, unresolvedRuntimeEdges: runtimeEdges.unresolved, excludedSourceFiles: runtimeEdges.excludedSourceFiles, auditScope: "TypeScript JavaScript AST audit of .js, .cjs, and .mjs files in declared package closures; parser errors fail assembly.", scanLimits: ["Static import/export, import(), require(), require.resolve(), import.meta.resolve(), require.apply(), and new URL(literal, import.meta.url) references are checked.", "Dynamic loader and optional asset edges require named package/file/expression-constrained maintainedRuntimeEdges ownership; inventory entries state rationale and limits.", "Pino caller-selected transport targets are not bundled by this exception; configured targets require separate closure ownership and verification.", "Claude SDK platform CLI package probes are optional existence checks; platform runtime packages are removed and asserted absent.", "The node-gyp-build-optional-packages probe is owned only with a declared msgpackr-extract optional platform package in closure.", "Computed paths outside named owners, arbitrary loaders, native addon internals, and behavior assembled through arbitrary control flow are not fully inferable statically; successful loader smoke tests validate only selected host-target entries."], required }, null, 2)}\n`
  );
  assertSafeTree(componentRoot);
  return { root: componentRoot, required, closure };
};

// Read the same closures used by assembly. This is deliberately independent of
// copying/pruning so assessment can describe an existing distribution first.
export const inspectRuntimeComponentOwnership = ({
  sourceRoot,
  excludedPackages = []
}) => {
  assertSafeTree(sourceRoot);
  const base = packageClosure(
    sourceRoot,
    baseServices.map((service) => servicePackages[service])
  );
  const privacy = packageClosure(
    sourceRoot,
    [servicePackages["privacy-service"]],
    excludedPackages
  );
  const basePaths = new Set(base.map(({ packageRoot }) => packageRoot));
  const privacyPaths = new Set(privacy.map(({ packageRoot }) => packageRoot));
  const packages = new Map(
    [...base, ...privacy].map((entry) => [entry.packageRoot, entry])
  );
  const ownership = [...packages.values()]
    .map(({ packageRoot, manifest }) => ({
      name: manifest.name,
      version: manifest.version,
      path: relative(sourceRoot, packageRoot).replaceAll("\\", "/"),
      ownership: basePaths.has(packageRoot)
        ? privacyPaths.has(packageRoot)
          ? "shared"
          : "base"
        : "privacy",
      dependencies: manifest.dependencies ?? {},
      optionalDependencies: manifest.optionalDependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      peerDependenciesMeta: manifest.peerDependenciesMeta ?? {}
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    services: { base: baseServices, privacy: privacyServices },
    packages: ownership,
    unreachablePackages: packageDirectories(resolve(sourceRoot, "node_modules"))
      .filter((packageRoot) => !packages.has(packageRoot))
      .map((packageRoot) => ({
        name: readManifest(resolve(packageRoot, "package.json")).name,
        path: relative(sourceRoot, packageRoot).replaceAll("\\", "/")
      })),
    audits: {
      base: unresolvedRuntimeEdges(sourceRoot, base),
      privacy: unresolvedRuntimeEdges(sourceRoot, privacy)
    }
  };
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
  const baseNamesPresent = new Set(
    base.closure.map(({ manifest }) => manifest.name)
  );
  const privacyOnlyPackages = [
    ...new Set(
      packageDirectories(resolve(sourceRoot, "node_modules")).map(
        (packageRoot) => readManifest(resolve(packageRoot, "package.json")).name
      )
    )
  ]
    .filter((name) => !baseNamesPresent.has(name))
    .sort();
  return {
    baseRoot: base.root,
    privacyRoot: privacy.root,
    baseRequired: base.required,
    privacyRequired: privacy.required,
    privacyOnlyPackages
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
    if (platform === "linux" && architecture === "x64") {
      result.privacyCpuRoot = resolve(outputDir, "privacy-cpu");
      cpSync(result.privacyRoot, result.privacyCpuRoot, { recursive: true });
      prunePrivacyRuntimeVariant({
        runtimeRoot: result.privacyCpuRoot,
        variant: "cpu"
      });
      result.privacyCpuRequired = refreshRequiredFiles(result.privacyCpuRoot);
      result.privacyCudaRoot = result.privacyRoot;
    }
    return result;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};
