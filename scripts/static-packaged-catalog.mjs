import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { assertStaticCatalogBinding } from "./static-catalog-binding.mjs";

const unsupported = () => {
  throw new Error(
    "Packaged catalog requires a static literal export; executable expressions are forbidden."
  );
};

const literalValue = (node) => {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(node)) {
    const entries = node.properties.map((property) => {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        return unsupported();
      return [property.name.text, literalValue(property.initializer)];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      return unsupported();
    return Object.fromEntries(entries);
  }
  // Generated modules validate this literal at runtime. Inspection instead uses
  // our trusted validator; never evaluate the candidate's function or imports.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    /^validateManifestCatalog\d*$/.test(node.expression.text) &&
    node.arguments.length === 1
  )
    return literalValue(node.arguments[0]);
  return unsupported();
};

const readSource = (root, path) => {
  const real = realpathSync(path);
  const child = relative(root, real);
  if (
    child === ".." ||
    child.startsWith("../") ||
    isAbsolute(child) ||
    statSync(real).size > 64 * 1024 * 1024
  )
    throw new Error(
      "Packaged catalog module escapes package or exceeds inspection size limit."
    );
  const source = ts.createSourceFile(
    real,
    readFileSync(real, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  if (source.parseDiagnostics.length)
    throw new Error("Invalid packaged catalog module syntax.");
  return source;
};

const resolveImport = (context, path, symbol, seen) => {
  if (!path.startsWith("./") && !path.startsWith("../")) return unsupported();
  return resolveBinding(
    context.root,
    resolve(dirname(context.path), path),
    symbol,
    seen
  );
};

const resolveVariable = (root, path, statements, symbol, seen) => {
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== symbol ||
        !declaration.initializer
      )
        continue;
      return ts.isIdentifier(declaration.initializer)
        ? resolveBinding(root, path, declaration.initializer.text, seen, false)
        : literalValue(declaration.initializer);
    }
  }
  return undefined;
};

const isExported = (statements, symbol) =>
  statements.some((statement) => {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      return statement.exportClause.elements.some(
        (element) => element.name.text === symbol
      );
    return (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      ) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === symbol
      )
    );
  });

const forwardedExport = (statement, context, symbol, seen) => {
  if (
    !ts.isExportDeclaration(statement) ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  )
    return undefined;
  const binding = statement.exportClause.elements.find(
    (element) => element.name.text === symbol
  );
  if (!binding) return undefined;
  const name = (binding.propertyName ?? binding.name).text;
  if (
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier)
  )
    return resolveImport(context, statement.moduleSpecifier.text, name, seen);
  if (name !== symbol)
    return resolveBinding(context.root, context.path, name, seen, false);
  return undefined;
};

const importedBinding = (statement, context, symbol, seen) => {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    !statement.importClause?.namedBindings ||
    !ts.isNamedImports(statement.importClause.namedBindings)
  )
    return undefined;
  const binding = statement.importClause.namedBindings.elements.find(
    (element) => element.name.text === symbol
  );
  return binding
    ? resolveImport(
        context,
        statement.moduleSpecifier.text,
        (binding.propertyName ?? binding.name).text,
        seen
      )
    : undefined;
};

const resolveBinding = (root, path, symbol, seen, exported = true) => {
  const key = `${path}:${symbol}`;
  if (seen.has(key) || seen.size >= 32)
    throw new Error("Cyclic or excessive packaged catalog bindings.");
  seen.add(key);
  const source = readSource(root, path);
  const { statements } = source;
  assertStaticCatalogBinding(source, symbol);
  if (exported && !isExported(statements, symbol)) return unsupported();
  const context = { root, path };
  for (const statement of statements) {
    const forwarded = forwardedExport(statement, context, symbol, seen);
    if (forwarded !== undefined) return forwarded;
    const imported = importedBinding(statement, context, symbol, seen);
    if (imported !== undefined) return imported;
  }
  const value = resolveVariable(root, path, statements, symbol, seen);
  if (value === undefined) return unsupported();
  return value;
};

export const readPackagedCatalog = (modulePath) => {
  const path = realpathSync(resolve(modulePath));
  return resolveBinding(
    realpathSync(dirname(path)),
    path,
    "productionComponentManifestCatalog",
    new Set()
  );
};
