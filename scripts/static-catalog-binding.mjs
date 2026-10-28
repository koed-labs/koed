import ts from "typescript";

const reject = () => {
  throw new Error("Packaged catalog static binding is mutable or reassigned.");
};
const rootName = (node) => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return rootName(node.expression);
  if (ts.isParenthesizedExpression(node)) return rootName(node.expression);
  return undefined;
};
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const mutableMethods = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "delete",
  "clear"
]);
const objectMutators = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
  "set",
  "deleteProperty"
]);

const aliasesFor = (source, symbol) => {
  const aliases = new Set([symbol]);
  let previous = 0;
  while (previous !== aliases.size) {
    previous = aliases.size;
    if (previous > 128) reject();
    walk(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        aliases.has(rootName(node.initializer))
      )
        aliases.add(node.name.text);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        aliases.has(rootName(node.right))
      )
        aliases.add(node.left.text);
    });
  }
  return aliases;
};

const mutatingCall = (node, aliases) => {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return false;
  const receiver = node.expression.expression;
  const method = node.expression.name.text;
  if (aliases.has(rootName(receiver)) && mutableMethods.has(method))
    return true;
  return (
    ts.isIdentifier(receiver) &&
    ["Object", "Reflect"].includes(receiver.text) &&
    objectMutators.has(method) &&
    node.arguments[0] &&
    aliases.has(rootName(node.arguments[0]))
  );
};

// This guards generated binding shape, not arbitrary JavaScript semantics or
// package authenticity. Packaged admission behavior remains a separate gate.
export const assertStaticCatalogBinding = (source, symbol) => {
  const aliases = aliasesFor(source, symbol);
  walk(source, (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.flags & ts.NodeFlags.Let &&
      node.declarationList.declarations.some((declaration) =>
        aliases.has(rootName(declaration.name))
      )
    )
      reject();
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      aliases.has(rootName(node.left))
    )
      reject();
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        node.operator
      ) &&
      aliases.has(rootName(node.operand))
    )
      reject();
    if (ts.isDeleteExpression(node) && aliases.has(rootName(node.expression)))
      reject();
    if (mutatingCall(node, aliases)) reject();
  });
};

export const assertPackagedCatalogConsumer = (sourceText) => {
  const source = ts.createSourceFile(
    "component-store.js",
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  if (source.parseDiagnostics.length)
    throw new Error("Invalid packaged catalog consumer syntax.");
  const imported = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    for (const binding of statement.importClause.namedBindings.elements)
      imported.set(
        `${statement.moduleSpecifier.text}:${(binding.propertyName ?? binding.name).text}`,
        binding.name.text
      );
  }
  const catalog = imported.get(
    "./component-manifest-catalog-data.js:productionComponentManifestCatalog"
  );
  const validator = imported.get(
    "./component-manifest-catalog.js:validateManifestCatalog"
  );
  let consumes = false;
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === validator &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === catalog
    )
      consumes = true;
  });
  if (!catalog || !validator || !consumes)
    throw new Error(
      "Packaged component store does not validate imported catalog authority; rebuild Server before packaging."
    );
};
