import { dirname, resolve } from "node:path";
import ts from "typescript";
import { assertStaticCatalogBinding } from "./static-catalog-binding.mjs";

const reject = () => {
  throw new Error(
    "npm package CLI/catalog consumer binding is disconnected or unsupported."
  );
};
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

// Accept the generated launcher only. Arbitrary candidate launchers are not
// executed, imported, or interpreted to discover their effective entrypoint.
const assertLauncher = (files) => {
  const expected = [
    "#!/usr/bin/env node",
    'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error(`@koed-labs/server requires Node.js >=24 <25; found ${process.versions.node}.`); process.exit(1); }',
    'const { runKoedServerCli, shouldExitPackagedSupervisor } = await import("../vendor/control-plane.js");',
    "const args = process.argv.slice(2);",
    "const exitCode = await runKoedServerCli(args);",
    "if (shouldExitPackagedSupervisor(args)) process.exit(exitCode);",
    "process.exitCode = exitCode;",
    ""
  ].join("\n");
  if (files.get("bin/koed.js")?.toString() !== expected) reject();
};

const staticProgram = (files) => {
  const sources = new Map(
    [...files]
      .filter(([path]) => path.endsWith(".js"))
      .map(([path, bytes]) => [
        resolve("/koed-inspection", path),
        bytes.toString()
      ])
  );
  const options = {
    allowJs: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (path) => sources.has(path);
  host.readFile = (path) => sources.get(path);
  host.directoryExists = (path) =>
    [...sources.keys()].some((name) => name.startsWith(`${path}/`));
  host.getSourceFile = (path) =>
    sources.has(path)
      ? ts.createSourceFile(
          path,
          sources.get(path),
          options.target,
          true,
          ts.ScriptKind.JS
        )
      : undefined;
  const program = ts.createProgram([...sources.keys()], options, host);
  if (program.getSyntacticDiagnostics().length) reject();
  return program;
};

const reference = (node) => {
  const parent = node.parent;
  return !(
    parent &&
    ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
        parent.name === node) ||
      ((ts.isVariableDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isParameter(parent)) &&
        parent.name === node))
  );
};

// Node chooses the nearest package scope for each .js file. Require explicit
// ESM scopes, including nested scopes; do not rely on syntax detection.
const assertModuleScopes = (files) => {
  const scopes = new Map();
  for (const [path, bytes] of files) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    try {
      scopes.set(dirname(path), JSON.parse(bytes.toString())?.type);
    } catch {
      throw new Error("npm package ESM scope contains invalid package.json.");
    }
  }
  for (const path of files.keys()) {
    if (!path.endsWith(".js")) continue;
    let scope = dirname(path);
    while (!scopes.has(scope) && scope !== ".") scope = dirname(scope);
    if (scopes.get(scope) !== "module")
      throw new Error("npm package ESM scope must explicitly use type module.");
  }
};

// Only generated direct admission calls and module import/export plumbing are
// supported. Reject escapes even in dead code: arrays, .call/.apply, arguments,
// aliases and other dispatch cannot be proved by this structural inspection.
const assertAdmissionReferences = (program, symbolAt) => {
  for (const source of program.getSourceFiles())
    walk(source, (node) => {
      if (
        !(
          (ts.isIdentifier(node) && reference(node)) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)
        )
      )
        return;
      const symbol = symbolAt(node);
      if (!/^verifyComponent(?:ManifestPin)?\d*$/.test(symbol?.name ?? ""))
        return;
      const parent = node.parent;
      if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return;
      if (
        ts.isIdentifier(node) &&
        ts.isCallExpression(parent) &&
        parent.expression === node
      )
        return;
      reject();
    });
};

export const assertReleasePackageBindings = (files) => {
  assertLauncher(files);
  assertModuleScopes(files);
  const program = staticProgram(files);
  const checker = program.getTypeChecker();
  const dynamicMember = dynamicMemberResolver(program, checker);
  const symbolAt = (node) => {
    const symbol =
      checker.getSymbolAtLocation(node) ??
      (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
        ? checker.getPropertyOfType(
            checker.getTypeAtLocation(node.expression),
            node.argumentExpression.text
          )
        : undefined);
    if (symbol)
      return symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return dynamicMember(node);
  };
  assertAdmissionReferences(program, symbolAt);
  const source = program.getSourceFile(
    "/koed-inspection/vendor/control-plane.js"
  );
  const exports = source && checker.getSymbolAtLocation(source);
  const exported = (name) =>
    exports &&
    checker.getExportsOfModule(exports).find((symbol) => symbol.name === name);
  const unalias = (symbol) =>
    symbol?.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const catalog = unalias(exported("productionComponentManifestCatalog"));
  const cli = unalias(exported("runKoedServerCli"));
  if (!catalog?.declarations?.length || !cli?.declarations?.length) reject();
  for (const declaration of catalog.declarations)
    assertStaticCatalogBinding(declaration.getSourceFile(), catalog.name);
  assertAdmissionBindings({ cli, catalog, symbolAt });
};

const reachableDeclarations = (nodes, symbolAt) => {
  const found = new Set();
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.pop();
    if (found.has(node)) continue;
    // Admission APIs are graph boundaries. Inspect their call-site inputs,
    // not the verifier's internal forwarding of its already-admitted input.
    if (
      node.name &&
      /^verifyComponent(?:ManifestPin)?\d*$/.test(node.name.getText())
    )
      continue;
    if (found.size >= 100000) reject();
    found.add(node);
    walkExecution(node, (child) => {
      if (
        !(
          (ts.isIdentifier(child) && reference(child)) ||
          ts.isPropertyAccessExpression(child)
        )
      )
        return;
      const symbol = callableSymbol(child, symbolAt);
      const declarations = symbol?.declarations ?? [];
      const callable = declarations.some(isCallableDeclaration);
      const parent = child.parent;
      const invoked =
        ts.isCallExpression(parent) &&
        (parent.expression === child || parent.arguments.includes(child));
      if (!callable || invoked) queue.push(...declarations);
    });
  }
  return found;
};

const assertAdmissionBindings = ({ cli, catalog, symbolAt }) => {
  const reachable = reachableDeclarations(cli.declarations, symbolAt);
  const isCatalogValue = catalogValueChecker(catalog, symbolAt);
  let validates = false;
  let admits = false;
  for (const declaration of reachable)
    walkExecution(declaration, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = callableSymbol(node.expression, symbolAt)?.name ?? "";
      if (
        /^validateManifestCatalog\d*$/.test(callee) &&
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0]) &&
        symbolAt(node.arguments[0]) === catalog
      )
        validates = true;
      if (!/^verifyComponent(?:ManifestPin)?\d*$/.test(callee)) return;
      if (
        node.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(node.arguments[0])
      )
        reject();
      const properties = node.arguments[0].properties;
      if (
        properties.some(
          (property) =>
            (!ts.isPropertyAssignment(property) &&
              !ts.isShorthandPropertyAssignment(property)) ||
            ts.isComputedPropertyName(property.name)
        )
      )
        reject();
      const pins = properties.filter(
        (property) => property.name.text === "manifestCatalog"
      );
      if (pins.length !== 1 || !ts.isPropertyAssignment(pins[0])) reject();
      if (!isCatalogValue(pins[0].initializer)) reject();
      admits = true;
    });
  if (!validates || !admits) reject();
};

const collectAssignments = (program, checker) => {
  const assignments = new Map();
  for (const source of program.getSourceFiles())
    walk(source, (node) => {
      if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isIdentifier(node.left)
      )
        return;
      const symbol = checker.getSymbolAtLocation(node.left);
      if (!symbol) return;
      const values = assignments.get(symbol) ?? [];
      values.push(node.right);
      assignments.set(symbol, values);
    });
  return assignments;
};

// Resolve the generated bootstrap's awaited literal import without evaluation.
const dynamicMemberResolver = (program, checker) => {
  const assignments = collectAssignments(program, checker);
  return (node) => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      !ts.isIdentifier(node.expression)
    )
      return undefined;
    const values =
      assignments.get(checker.getSymbolAtLocation(node.expression)) ?? [];
    const imports = values
      .map((value) => (ts.isAwaitExpression(value) ? value.expression : value))
      .filter(
        (value) =>
          ts.isCallExpression(value) &&
          value.expression.kind === ts.SyntaxKind.ImportKeyword
      );
    if (!imports.length) return undefined;
    if (imports.length !== 1 || values.length !== 1) reject();
    const [call] = imports;
    if (
      call.arguments.length !== 1 ||
      !ts.isStringLiteral(call.arguments[0]) ||
      !call.arguments[0].text.startsWith("./")
    )
      reject();
    const source = program.getSourceFile(
      resolve(dirname(node.getSourceFile().fileName), call.arguments[0].text)
    );
    const module = source && checker.getSymbolAtLocation(source);
    const symbol =
      module &&
      checker
        .getExportsOfModule(module)
        .find((item) => item.name === node.name.text);
    return symbol?.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };
};

const walkExecution = (root, visit) => {
  const entryFunction = ts.isVariableDeclaration(root)
    ? root.initializer
    : root;
  const descend = (node) => {
    if (ts.isFunctionLike(node) && node !== entryFunction) {
      // Inline callbacks passed to calls are generated execution edges; unused
      // local function declarations/initializers are not.
      if (
        !ts.isCallExpression(node.parent) ||
        !node.parent.arguments.includes(node)
      )
        return;
    }
    visit(node);
    ts.forEachChild(node, descend);
  };
  descend(root);
};

const catalogValueChecker = (catalog, symbolAt) => {
  const check = (node, seen = new Set()) => {
    if (seen.has(node) || seen.size >= 32) return false;
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node);
      if (symbol === catalog) return true;
      const declarations = symbol?.declarations ?? [];
      if (
        declarations.length !== 1 ||
        !ts.isVariableDeclaration(declarations[0]) ||
        !declarations[0].initializer
      )
        return false;
      assertStaticCatalogBinding(node.getSourceFile(), node.text);
      return check(declarations[0].initializer, next);
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
      return false;
    if (/^validateManifestCatalog\d*$/.test(node.expression.text))
      return (
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0]) &&
        symbolAt(node.arguments[0]) === catalog
      );
    if (node.arguments.length) return false;
    const declarations = symbolAt(node.expression)?.declarations ?? [];
    if (declarations.length !== 1) return false;
    const declaration = declarations[0];
    const fn = ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : declaration;
    if (!fn || !ts.isFunctionLike(fn) || !fn.body || ts.isBlock(fn.body))
      return false;
    const body = fn.body;
    return (
      isCatalogNullGuard(body, catalog, symbolAt) && check(body.whenFalse, next)
    );
  };
  return check;
};

// Exact generated null guard: no comma expressions or incidental references.
const isCatalogNullGuard = (body, catalog, symbolAt) =>
  ts.isConditionalExpression(body) &&
  ts.isBinaryExpression(body.condition) &&
  body.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
  ts.isIdentifier(body.condition.left) &&
  symbolAt(body.condition.left) === catalog &&
  body.condition.right.kind === ts.SyntaxKind.NullKeyword &&
  body.whenTrue.kind === ts.SyntaxKind.NullKeyword;

const isCallableDeclaration = (node) =>
  ts.isFunctionLike(node) ||
  (ts.isVariableDeclaration(node) &&
    node.initializer &&
    ts.isFunctionLike(node.initializer));

const callableSymbol = (node, symbolAt, seen = new Set()) => {
  const symbol = symbolAt(node);
  if (!symbol || seen.has(symbol) || seen.size >= 32) return symbol;
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return symbol;
  const declaration = declarations[0];
  if (
    !ts.isVariableDeclaration(declaration) &&
    !ts.isPropertyAssignment(declaration) &&
    !ts.isBindingElement(declaration) &&
    !ts.isParameter(declaration)
  )
    return symbol;
  // An initializer is only the alias's value when nothing can rewrite it.
  if (
    !ts.isPropertyAssignment(declaration) &&
    !(
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    )
  )
    return symbol;
  const value = declaration.initializer;
  if (
    !value ||
    (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))
  )
    return symbol;
  return callableSymbol(value, symbolAt, new Set(seen).add(symbol));
};
