/**
 * Symbol dependency analysis — what a symbol's body references from outside
 * itself. Field-voted primitive (PRD § Phase 6 implementation decisions): a
 * module split can compute the exact imports each moved symbol needs instead
 * of eyeballing the file's import header.
 *
 * Pure syntactic analysis over the TypeScript AST (no checker): identifiers
 * used inside the symbol's range are intersected with the file's import
 * bindings and top-level symbol names. A local variable that shadows an import
 * can therefore produce a false positive — acceptable for the import-rewiring
 * use case, and called out in the op's documentation.
 */
import ts from "typescript";
import type { Range } from "vscode-languageserver-protocol";

/** One imported binding a symbol's body uses. */
export interface ImportDependency {
  /** Local binding name (what the body references). */
  name: string;
  /** Module specifier it comes from, e.g. "./users" or "drizzle-orm". */
  from: string;
  /** True for `import type` / `{ type X }` — a moved symbol needs `import type`. */
  typeOnly: boolean;
}

/** Everything a symbol references from outside its own body. */
export interface SymbolDependencies {
  /** Imported bindings the body uses, with their source modules. */
  imports: ImportDependency[];
  /** Top-level symbols in the SAME file the body references (excluding itself). */
  sameFile: string[];
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** All import bindings declared in the file, keyed by local name. */
function collectImportBindings(
  sourceFile: ts.SourceFile,
): Map<string, ImportDependency> {
  const bindings = new Map<string, ImportDependency>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    const clauseTypeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
    if (clause.name) {
      bindings.set(clause.name.text, {
        name: clause.name.text,
        from,
        typeOnly: clauseTypeOnly,
      });
    }
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, {
        name: named.name.text,
        from,
        typeOnly: clauseTypeOnly,
      });
    }
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(element.name.text, {
          name: element.name.text,
          from,
          typeOnly: clauseTypeOnly || element.isTypeOnly === true,
        });
      }
    }
  }
  return bindings;
}

/**
 * Whether an identifier node is a USE of a name, rather than a property name
 * or a declaration name. `payments.eq` must not count `eq`; `const eq = …`
 * declares rather than uses.
 */
function isUsageIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

/**
 * Analyze which outside names a symbol's body uses. `range` is the symbol's
 * full declaration range (zero-based LSP range, as returned by the symbol
 * resolver); `topLevelNames` are the file's addressable top-level symbols;
 * `selfName` is excluded from sameFile results.
 */
export function analyzeDependencies(params: {
  fileName: string;
  sourceText: string;
  range: Range;
  topLevelNames: string[];
  selfName: string;
}): SymbolDependencies {
  const sourceFile = ts.createSourceFile(
    params.fileName,
    params.sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(params.fileName),
  );
  const start = ts.getPositionOfLineAndCharacter(
    sourceFile,
    params.range.start.line,
    params.range.start.character,
  );
  const end = ts.getPositionOfLineAndCharacter(
    sourceFile,
    params.range.end.line,
    params.range.end.character,
  );

  const used = new Set<string>();
  function visit(node: ts.Node): void {
    if (node.end < start || node.getStart(sourceFile) > end) return;
    if (ts.isIdentifier(node) && isUsageIdentifier(node)) {
      used.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const bindings = collectImportBindings(sourceFile);
  const imports = [...bindings.values()]
    .filter((binding) => used.has(binding.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sameFile = params.topLevelNames
    .filter((name) => name !== params.selfName && used.has(name))
    .sort();
  return { imports, sameFile };
}
