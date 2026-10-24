import ts from "typescript";
import { assertStaticCatalogBinding } from "./static-catalog-binding.mjs";

export const inspectPackagedTrustRoots = (text) => {
  const source = ts.createSourceFile(
    "component-trust-roots.js",
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  if (source.parseDiagnostics.length)
    throw new Error("Invalid packaged trust roots syntax.");
  const symbol = "productionComponentTrustRoots";
  assertStaticCatalogBinding(source, symbol);
  let entries;
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== symbol
      )
        continue;
      const value = declaration.initializer;
      if (
        entries ||
        !value ||
        !ts.isNewExpression(value) ||
        !ts.isIdentifier(value.expression) ||
        value.expression.text !== "Map" ||
        value.arguments?.length !== 1 ||
        !ts.isArrayLiteralExpression(value.arguments[0])
      )
        throw new Error("Packaged trust roots require literal Map entries.");
      entries = value.arguments[0].elements.map((entry) => {
        if (
          !ts.isArrayLiteralExpression(entry) ||
          entry.elements.length !== 2 ||
          !entry.elements.every(
            (element) =>
              ts.isStringLiteral(element) ||
              ts.isNoSubstitutionTemplateLiteral(element)
          )
        )
          throw new Error("Packaged trust roots require literal key pairs.");
        return entry.elements.map((element) => element.text);
      });
    }
  }
  if (
    !entries?.length ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  )
    throw new Error("Packaged trust roots are missing or duplicated.");
  return Object.fromEntries(entries);
};
