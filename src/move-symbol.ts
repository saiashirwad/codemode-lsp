/**
 * Pure mechanics for the moveSymbol op — the "line-range surgery" a field
 * session had to hand-roll (PRD § decision log): module-specifier math,
 * tsconfig path-alias maps, import-statement rewiring in referencing files,
 * and export-modifier insertion. Everything here is text-in/text-out over the
 * TypeScript AST so it unit-tests without a language server; orchestration
 * (symbol resolution, buffering, diagnostics) lives in lsp-api.ts.
 */
import { posix } from "node:path";
import ts from "typescript";
import { isUsageIdentifier } from "./dependencies";

const MODULE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(fileName: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
}

/** Strip a module-resolvable extension: "src/users.ts" → "src/users". */
export function stripModuleExtension(path: string): string {
  return path.replace(MODULE_EXTENSIONS, "");
}

/**
 * Module specifier for importing `toFile` from inside `fromFile` (both
 * workspace-relative posix paths): "src/a/x.ts" → "src/b/y.ts" gives "../b/y".
 */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const fromDir = posix.dirname(fromFile);
  let specifier = posix.relative(fromDir, stripModuleExtension(toFile));
  if (specifier.endsWith("/index"))
    specifier = specifier.slice(0, -"/index".length);
  if (specifier === "" || specifier === "index") specifier = ".";
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

/**
 * Rewrite a module specifier that appears in `fromFile` so it still resolves
 * to the same module when the import lives in `toFile` instead. Only relative
 * specifiers change; package and alias specifiers are location-independent.
 */
export function rewriteSpecifier(
  specifier: string,
  fromFile: string,
  toFile: string,
): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = posix.normalize(
    posix.join(posix.dirname(fromFile), specifier),
  );
  return relativeSpecifier(toFile, resolved);
}

/** tsconfig "paths" support, restricted to single-`*` patterns. */
export interface AliasMaps {
  /** Alias specifier → workspace-relative base path (no extension), or undefined. */
  resolve(specifier: string): string | undefined;
  /** Workspace-relative module base (no extension) → alias specifier, or undefined. */
  toAlias(moduleBase: string): string | undefined;
}

export const EMPTY_ALIAS_MAPS: AliasMaps = {
  resolve: () => undefined,
  toAlias: () => undefined,
};

/**
 * Build alias maps from tsconfig `paths` (pattern → targets) where targets are
 * already workspace-relative (the caller resolves baseUrl). Only `prefix*` ↔
 * `targetPrefix*` single-star patterns are supported — others are ignored.
 */
export function aliasMapsFromPaths(
  paths: Record<string, string[]> | undefined,
): AliasMaps {
  if (!paths) return EMPTY_ALIAS_MAPS;
  const entries: Array<{ aliasPrefix: string; targetPrefix: string }> = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!target) continue;
    const aliasStar = pattern.indexOf("*");
    const targetStar = target.indexOf("*");
    if (aliasStar === -1 || targetStar === -1) continue;
    if (aliasStar !== pattern.length - 1 || targetStar !== target.length - 1) {
      continue;
    }
    entries.push({
      aliasPrefix: pattern.slice(0, -1),
      targetPrefix: posix.normalize(target.slice(0, -1)),
    });
  }
  return {
    resolve(specifier) {
      for (const { aliasPrefix, targetPrefix } of entries) {
        if (specifier.startsWith(aliasPrefix)) {
          return posix.normalize(
            targetPrefix + specifier.slice(aliasPrefix.length),
          );
        }
      }
      return undefined;
    },
    toAlias(moduleBase) {
      for (const { aliasPrefix, targetPrefix } of entries) {
        if (moduleBase.startsWith(targetPrefix)) {
          return aliasPrefix + moduleBase.slice(targetPrefix.length);
        }
      }
      return undefined;
    },
  };
}

/**
 * Whether `specifier`, written in `importerFile`, resolves to `moduleFile`
 * (all workspace-relative; extension-insensitive, `/index` aware).
 */
export function specifierResolvesTo(
  specifier: string,
  importerFile: string,
  moduleFile: string,
  aliases: AliasMaps = EMPTY_ALIAS_MAPS,
): boolean {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(importerFile), specifier));
  } else {
    base = aliases.resolve(specifier);
  }
  if (base === undefined) return false;
  base = stripModuleExtension(base);
  const moduleBase = stripModuleExtension(moduleFile);
  return base === moduleBase || `${base}/index` === moduleBase;
}

/** One import line for a constructed header. */
export interface HeaderImport {
  names: string[];
  typeOnlyNames: string[];
  from: string;
}

/**
 * Render import declarations: value and type names merged per module with
 * inline `type` qualifiers ("import { a, type T } from \"./x\";"); modules
 * with only type names get `import type`.
 */
export function renderImportHeader(imports: HeaderImport[]): string {
  const lines: string[] = [];
  for (const entry of imports) {
    const values = [...entry.names].sort();
    const types = [...entry.typeOnlyNames].sort();
    if (values.length === 0 && types.length === 0) continue;
    if (values.length === 0) {
      lines.push(`import type { ${types.join(", ")} } from "${entry.from}";`);
    } else {
      const merged = [...values, ...types.map((name) => `type ${name}`)];
      lines.push(`import { ${merged.join(", ")} } from "${entry.from}";`);
    }
  }
  return lines.join("\n");
}

/** Names among `names` declared at top level as type-only constructs (interface/type alias). */
export function topLevelTypeNames(
  fileName: string,
  sourceText: string,
  names: readonly string[],
): Set<string> {
  const sourceFile = parse(fileName, sourceText);
  const wanted = new Set(names);
  const found = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      wanted.has(statement.name.text)
    ) {
      found.add(statement.name.text);
    }
  }
  return found;
}

function statementDeclaredNames(statement: ts.Statement): string[] {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
    return names;
  }
  return [];
}

function hasExportModifier(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement)
    : undefined;
  return (
    modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

/**
 * Insert `export ` before the top-level declarations of `names` that lack it.
 * Insertion happens at the declaration start (after JSDoc). Returns the new
 * text and which names were actually changed.
 */
export function addExportModifiers(
  fileName: string,
  sourceText: string,
  names: readonly string[],
): { text: string; exported: string[] } {
  const sourceFile = parse(fileName, sourceText);
  const wanted = new Set(names);
  const insertions: Array<{ position: number; name: string }> = [];
  for (const statement of sourceFile.statements) {
    const declared = statementDeclaredNames(statement).filter((name) =>
      wanted.has(name),
    );
    if (declared.length === 0 || hasExportModifier(statement)) continue;
    insertions.push({
      position: statement.getStart(sourceFile),
      name: declared[0] ?? "",
    });
  }
  insertions.sort((a, b) => b.position - a.position);
  let text = sourceText;
  for (const { position } of insertions) {
    text = `${text.slice(0, position)}export ${text.slice(position)}`;
  }
  return {
    text,
    exported: insertions.map((insertion) => insertion.name).sort(),
  };
}

/**
 * Which of `names` are used in the file outside import/export declarations —
 * decides whether the source file needs a back-import after the move.
 */
export function namesUsedOutsideImports(
  fileName: string,
  sourceText: string,
  names: readonly string[],
): Set<string> {
  const sourceFile = parse(fileName, sourceText);
  const wanted = new Set(names);
  const used = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isIdentifier(node) &&
      wanted.has(node.text) &&
      isUsageIdentifier(node)
    ) {
      used.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return used;
}

/**
 * Ensure the (single) top-level declaration of `name` inside a moved snippet
 * carries `export`. The snippet's leading JSDoc is preserved (insertion is at
 * the declaration start, which skips trivia).
 */
export function ensureTopLevelExport(
  fileName: string,
  snippet: string,
  name: string,
): string {
  return addExportModifiers(fileName, snippet, [name]).text;
}

/**
 * Rewire imports of `movedName` in one referencing file: every import
 * declaration whose specifier points at the old module and names `movedName`
 * either gets its specifier repointed (sole binding) or has the binding split
 * out into a new import from `newSpecifier` (other bindings present).
 */
export function rewireMovedImport(params: {
  fileName: string;
  sourceText: string;
  movedName: string;
  isOldModule: (specifier: string) => boolean;
  /** New specifier given the matched old one — lets callers preserve alias style. */
  newSpecifierFor: (oldSpecifier: string) => string;
}): { text: string; changed: boolean } {
  const sourceFile = parse(params.fileName, params.sourceText);
  const splices: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!params.isOldModule(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (!clause || !named || !ts.isNamedImports(named)) continue;
    const element = named.elements.find(
      (candidate) => candidate.name.text === params.movedName,
    );
    if (!element) continue;
    const clauseTypeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
    const elementTypeOnly = clauseTypeOnly || element.isTypeOnly === true;
    const newSpecifier = params.newSpecifierFor(statement.moduleSpecifier.text);
    if (named.elements.length === 1 && !clause.name) {
      // Sole binding: repoint the specifier in place.
      const literal = statement.moduleSpecifier;
      const quote = params.sourceText[literal.getStart(sourceFile)] ?? '"';
      splices.push({
        start: literal.getStart(sourceFile),
        end: literal.getEnd(),
        text: `${quote}${newSpecifier}${quote}`,
      });
    } else {
      // Split the binding out of the list…
      const elements = named.elements;
      const index = elements.indexOf(element);
      const next = elements[index + 1];
      const previous = elements[index - 1];
      const start = next
        ? element.getStart(sourceFile)
        : (previous?.getEnd() ?? element.getStart(sourceFile));
      const end = next ? next.getStart(sourceFile) : element.getEnd();
      splices.push({ start, end, text: "" });
      // …and import it from the new module on the next line.
      const importKeyword = elementTypeOnly ? "import type" : "import";
      splices.push({
        start: statement.getEnd(),
        end: statement.getEnd(),
        text: `\n${importKeyword} { ${params.movedName} } from "${newSpecifier}";`,
      });
    }
  }
  if (splices.length === 0) return { text: params.sourceText, changed: false };
  splices.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = params.sourceText;
  for (const splice of splices) {
    text = text.slice(0, splice.start) + splice.text + text.slice(splice.end);
  }
  return { text, changed: true };
}
