import type {
  DocumentSymbol,
  Position,
  Range,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import { SymbolKind } from "vscode-languageserver-protocol";

export interface SymbolInfo {
  name: string;
  /** Exact slash-separated path for use in other lsp.* calls. */
  path: string;
  /** "class" | "function" | "method" | "variable" | ... */
  kind: string;
  exported: boolean;
  /** 1-based. */
  startLine: number;
  endLine: number;
  /** One-line signature; often avoids a getSymbolBody call. */
  signature?: string;
  children?: SymbolInfo[];
}

export interface ParsedSymbolSegment {
  name: string;
  index?: number;
}

export interface ResolvedSymbol {
  name: string;
  path: string;
  range: Range;
  selectionRange: Range;
  kind: string;
  children: ResolvedSymbol[];
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [SymbolKind.File]: "file",
  [SymbolKind.Module]: "module",
  [SymbolKind.Namespace]: "namespace",
  [SymbolKind.Package]: "package",
  [SymbolKind.Class]: "class",
  [SymbolKind.Method]: "method",
  [SymbolKind.Property]: "property",
  [SymbolKind.Field]: "field",
  [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Enum]: "enum",
  [SymbolKind.Interface]: "interface",
  [SymbolKind.Function]: "function",
  [SymbolKind.Variable]: "variable",
  [SymbolKind.Constant]: "constant",
  [SymbolKind.String]: "string",
  [SymbolKind.Number]: "number",
  [SymbolKind.Boolean]: "boolean",
  [SymbolKind.Array]: "array",
  [SymbolKind.Object]: "object",
  [SymbolKind.Key]: "key",
  [SymbolKind.Null]: "null",
  [SymbolKind.EnumMember]: "enumMember",
  [SymbolKind.Struct]: "struct",
  [SymbolKind.Event]: "event",
  [SymbolKind.Operator]: "operator",
  [SymbolKind.TypeParameter]: "typeParameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `kind-${kind}`;
}

function positionContains(range: Range, position: Position): boolean {
  const startsBefore =
    range.start.line < position.line ||
    (range.start.line === position.line &&
      range.start.character <= position.character);
  const endsAfter =
    range.end.line > position.line ||
    (range.end.line === position.line &&
      range.end.character >= position.character);
  return startsBefore && endsAfter;
}

function rangeContains(outer: Range, inner: Range): boolean {
  return (
    positionContains(outer, inner.start) && positionContains(outer, inner.end)
  );
}

function lineAt(
  sourceText: string | undefined,
  zeroBasedLine: number,
): string | undefined {
  return sourceText?.split(/\r?\n/)[zeroBasedLine];
}

function inferExported(symbol: DocumentSymbol, sourceText?: string): boolean {
  for (
    let lineNumber = symbol.range.start.line;
    lineNumber <= symbol.selectionRange.start.line;
    lineNumber += 1
  ) {
    const line = lineAt(sourceText, lineNumber);
    if (line && /^\s*export\b/.test(line)) return true;
  }
  return false;
}

function signatureFor(
  symbol: DocumentSymbol,
  sourceText?: string,
): string | undefined {
  const line = lineAt(sourceText, symbol.selectionRange.start.line);
  const rangeStart = lineAt(sourceText, symbol.range.start.line);
  const candidate = line?.trim() || rangeStart?.trim();
  if (!candidate) return undefined;
  return candidate.length > 160 ? `${candidate.slice(0, 157)}...` : candidate;
}

function indexedPath(
  parentPath: string,
  name: string,
  siblings: DocumentSymbol[],
  indexInSiblings: number,
): string {
  const sameName = siblings.filter((candidate) => candidate.name === name);
  const base = parentPath ? `${parentPath}/${name}` : name;
  if (sameName.length <= 1) return base;
  const duplicateIndex =
    siblings
      .slice(0, indexInSiblings + 1)
      .filter((candidate) => candidate.name === name).length - 1;
  return `${base}[${duplicateIndex}]`;
}

function toInfo(
  symbol: DocumentSymbol,
  siblings: DocumentSymbol[],
  index: number,
  parentPath: string,
  sourceText?: string,
): SymbolInfo {
  const path = indexedPath(parentPath, symbol.name, siblings, index);
  const children = symbol.children?.map((child, childIndex) =>
    toInfo(child, symbol.children ?? [], childIndex, path, sourceText),
  );
  return {
    name: symbol.name,
    path,
    kind: symbolKindName(symbol.kind),
    exported: inferExported(symbol, sourceText),
    startLine: symbol.range.start.line + 1,
    endLine: symbol.range.end.line + 1,
    signature: signatureFor(symbol, sourceText),
    ...(children && children.length > 0 ? { children } : {}),
  };
}

function toResolved(
  symbol: DocumentSymbol,
  siblings: DocumentSymbol[],
  index: number,
  parentPath: string,
): ResolvedSymbol {
  const path = indexedPath(parentPath, symbol.name, siblings, index);
  const children = symbol.children?.map((child, childIndex) =>
    toResolved(child, symbol.children ?? [], childIndex, path),
  );
  return {
    name: symbol.name,
    path,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
    kind: symbolKindName(symbol.kind),
    children: children ?? [],
  };
}

export function isDocumentSymbolArray(
  symbols: DocumentSymbol[] | SymbolInformation[],
): symbols is DocumentSymbol[] {
  const first = symbols[0];
  return first === undefined || "selectionRange" in first;
}

export function parseSymbolPath(input: string): ParsedSymbolSegment[] {
  const normalized = input.trim().replaceAll(".", "/");
  if (!normalized) throw new Error("Symbol path cannot be empty.");
  return normalized.split("/").map((segment) => {
    const match = /^(.*?)(?:\[(\d+)\])?$/.exec(segment);
    const name = match?.[1];
    if (!match || !name) {
      throw new Error(
        `Invalid symbol path segment "${segment}" in "${input}".`,
      );
    }
    const indexText = match[2];
    return {
      name,
      ...(indexText === undefined ? {} : { index: Number(indexText) }),
    };
  });
}

/**
 * Whether a DocumentSymbol name can serve as a slash/dot symbol-path segment.
 *
 * `typescript-language-server` emits anonymous-callback symbols with synthetic
 * names like `registry.find() callback` (dots, parens, spaces). These are not
 * addressable: the dot-alias normalization (`.` → `/`) mangles the name, so the
 * path can never round-trip through getSymbolBody/findReferences/etc. They are
 * also not meaningful edit targets. We drop them from getSymbols output so every
 * returned SymbolInfo.path resolves. See PRD § Phase 2 implementation decisions.
 */
function isAddressableSymbolName(name: string): boolean {
  // Reject characters that conflict with path syntax (`/`, `.`) or that mark a
  // synthetic tsserver symbol: parens/spaces (`registry.find() callback`) and
  // angle brackets (`<function>` for anonymous function expressions).
  return name.length > 0 && !/[./()<>\s]/.test(name);
}

function addressableSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const filtered: DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (!isAddressableSymbolName(symbol.name)) continue;
    filtered.push(
      symbol.children
        ? { ...symbol, children: addressableSymbols(symbol.children) }
        : symbol,
    );
  }
  return filtered;
}

export function buildSymbolInfoTree(
  symbols: DocumentSymbol[],
  sourceText?: string,
): SymbolInfo[] {
  const addressable = addressableSymbols(symbols);
  return addressable.map((symbol, index) =>
    toInfo(symbol, addressable, index, "", sourceText),
  );
}

export function buildResolvedSymbolTree(
  symbols: DocumentSymbol[],
): ResolvedSymbol[] {
  return symbols.map((symbol, index) => toResolved(symbol, symbols, index, ""));
}

function availableTopLevel(symbols: ResolvedSymbol[]): string {
  return symbols.map((symbol) => symbol.name).join(", ") || "none";
}

function formatChildren(symbol: ResolvedSymbol): string {
  return `${symbol.path} has children: ${
    symbol.children.map((child) => child.name).join(", ") || "none"
  }.`;
}

export function resolveSymbolPath(params: {
  file: string;
  symbolPath: string;
  symbols: DocumentSymbol[];
}): ResolvedSymbol {
  const segments = parseSymbolPath(params.symbolPath);
  const roots = buildResolvedSymbolTree(params.symbols);
  let currentLevel = roots;
  let resolved: ResolvedSymbol | undefined;

  for (const segment of segments) {
    const matches = currentLevel.filter(
      (symbol) => symbol.name === segment.name,
    );
    if (matches.length === 0) {
      const prefix = resolved ? `${resolved.path} ` : "";
      const childHint = resolved ? `\n${formatChildren(resolved)}` : "";
      throw new Error(
        `Symbol "${params.symbolPath}" not found in "${params.file}".\n` +
          `Available top-level symbols: ${availableTopLevel(roots)}.${childHint || (prefix ? `\n${prefix}has no matching children.` : "")}`,
      );
    }
    if (matches.length > 1 && segment.index === undefined) {
      const overloads = matches.map((symbol) => symbol.path).join(", ");
      throw new Error(
        `Symbol "${params.symbolPath}" is ambiguous in "${params.file}".\n` +
          `Available overloads: ${overloads}.\n` +
          `Use an overload index suffix like "${matches[0]?.path ?? segment.name}".`,
      );
    }
    const index = segment.index ?? 0;
    const next = matches[index];
    if (!next) {
      const overloads = matches.map((symbol) => symbol.path).join(", ");
      throw new Error(
        `Symbol "${params.symbolPath}" not found in "${params.file}".\n` +
          `Available overloads: ${overloads}.`,
      );
    }
    resolved = next;
    currentLevel = resolved.children;
  }

  if (!resolved) {
    throw new Error(
      `Symbol "${params.symbolPath}" not found in "${params.file}".`,
    );
  }
  return resolved;
}

export function containingSymbolPath(
  symbols: DocumentSymbol[],
  position: Position,
): string | undefined {
  function visit(candidates: ResolvedSymbol[]): ResolvedSymbol | undefined {
    for (const candidate of candidates) {
      if (!positionContains(candidate.range, position)) continue;
      return visit(candidate.children) ?? candidate;
    }
    return undefined;
  }
  // Walk the addressable tree only: un-addressable nodes (anonymous callbacks,
  // `<function>`) and their subtrees are pruned, so the containing handle is the
  // nearest *reusable* symbol path — never a synthetic inner name.
  return visit(buildResolvedSymbolTree(addressableSymbols(symbols)))?.path;
}

export function symbolPathForRange(
  symbols: DocumentSymbol[],
  range: Range,
): string | undefined {
  function visit(candidates: ResolvedSymbol[]): ResolvedSymbol | undefined {
    for (const candidate of candidates) {
      if (!rangeContains(candidate.range, range)) continue;
      return visit(candidate.children) ?? candidate;
    }
    return undefined;
  }
  return visit(buildResolvedSymbolTree(addressableSymbols(symbols)))?.path;
}
