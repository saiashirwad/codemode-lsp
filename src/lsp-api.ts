import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type {
  CallHierarchyItem,
  DocumentSymbol,
  Diagnostic as LspDiagnostic,
  Location as LspLocation,
  Range,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { isLspDocumentPath, TransactionalBuffer } from "./buffer";
import { analyzeDependencies, type SymbolDependencies } from "./dependencies";
import type { LspClient } from "./lsp-client";
import {
  type AliasMaps,
  addExportModifiers,
  aliasMapsFromPaths,
  EMPTY_ALIAS_MAPS,
  ensureTopLevelExport,
  type HeaderImport,
  importBindingNames,
  namesUsedOutsideImports,
  relativeSpecifier,
  removeImportOfName,
  renderImportHeader,
  rewireMovedImport,
  rewriteSpecifier,
  specifierResolvesTo,
  stripModuleExtension,
  topLevelTypeNames,
} from "./move-symbol";
import { type ProjectCheckResult, runProjectCheck } from "./project-check";
import {
  buildSymbolInfoTree,
  containingFunctionPath,
  isDocumentSymbolArray,
  resolveSymbolPath,
  type SymbolInfo,
  symbolKindName,
  symbolPathForRange,
} from "./symbol";

export type { SymbolInfo } from "./symbol";

export interface Reference {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The actual line of code containing the reference. */
  context: string;
  /** Path of the nearest enclosing function/method (a reusable handle); "" at top level. */
  symbolPath: string;
  /** Always false in v1 — the language server does not classify accesses. */
  isWriteAccess: boolean;
}

/** One exact call site (a true call — never an import, re-export, or type reference). */
export interface CallSite {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The line of code containing the call. */
  context: string;
}

/** One edge of the call graph, from incomingCalls/outgoingCalls. */
export interface CallInfo {
  /** The other function: the caller (incomingCalls) or the callee (outgoingCalls). */
  file: string;
  /** Its symbol path — round-trips into other lsp.* calls together with `file`; "" when the call sits at module top level (no enclosing function). */
  symbolPath: string;
  name: string;
  kind: string;
  /** Call sites in the caller's body (so in `file` for incomingCalls, in the queried symbol's file for outgoingCalls). */
  callSites: CallSite[];
}

export interface Location {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Set when the definition lands inside a known symbol. */
  symbolPath?: string;
}

export interface SearchResult {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  match: string;
  /** Full line containing the match. */
  context: string;
}

export interface Diagnostic {
  file: string;
  /** Zero-based, unlike the 1-based line/column elsewhere. */
  range: Range;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  /** True when this is probably spurious (e.g. path-alias resolution on a file created this script) — exclude these from any abort/rollback gate. */
  likelyFalsePositive?: boolean;
}

export interface WorkspaceSymbolInfo extends SymbolInfo {
  file: string;
}

export interface WriteResult {
  file: string;
  /** All files affected — rename can fan out to many. */
  filesChanged: string[];
  /** Fresh diagnostics for the affected files; gate on severity "error" but skip likelyFalsePositive ones. */
  diagnostics: Diagnostic[];
}

export interface MoveSymbolResult extends WriteResult {
  /** Same-file dependencies left behind in `file` that were auto-exported so the moved body can import them. */
  autoExported: string[];
}

export type { ProjectCheckResult } from "./project-check";

export interface ResolvedWorkspacePath {
  absPath: string;
  relPath: string;
  uri: string;
}

interface IgnoreRule {
  raw: string;
  directoryOnly: boolean;
  regex: RegExp;
}

const ALWAYS_EXCLUDED_DIRS = new Set([".git", "node_modules"]);

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob = "**/*"): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    const afterNext = glob[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(char ?? "");
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

function gitignorePatternToRegex(pattern: string, anchored: boolean): RegExp {
  const source = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const body = globToRegExp(
    source.includes("*")
      ? source
      : `${source}${pattern.endsWith("/") ? "/**" : ""}`,
  )
    .source.replace(/^\^/, "")
    .replace(/\$$/, "");
  if (anchored) return new RegExp(`^${body}(?:/.*)?$`);
  if (source.includes("/")) return new RegExp(`(?:^|/)${body}(?:/.*)?$`);
  return new RegExp(`(?:^|/)${body}(?:/.*)?$`);
}

function loadIgnoreRules(rootDir: string): IgnoreRule[] {
  const gitignore = resolve(rootDir, ".gitignore");
  if (!existsSync(gitignore)) return [];
  return readFileSync(gitignore, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!"),
    )
    .map((raw) => {
      const anchored = raw.startsWith("/");
      const pattern = anchored ? raw.slice(1) : raw;
      return {
        raw: pattern,
        directoryOnly: pattern.endsWith("/"),
        regex: gitignorePatternToRegex(pattern, anchored),
      };
    });
}

function isIgnored(
  relPath: string,
  isDirectory: boolean,
  rules: IgnoreRule[],
): boolean {
  const segments = relPath.split("/");
  if (segments.some((segment) => ALWAYS_EXCLUDED_DIRS.has(segment)))
    return true;
  return rules.some((rule) => {
    if (rule.directoryOnly && !isDirectory && !relPath.startsWith(rule.raw)) {
      return false;
    }
    return rule.regex.test(relPath);
  });
}

function offsetAt(text: string, line: number, character: number): number {
  let currentLine = 0;
  let offset = 0;
  while (currentLine < line && offset < text.length) {
    const char = text[offset];
    if (char === "\r" && text[offset + 1] === "\n") {
      offset += 2;
      currentLine += 1;
    } else if (char === "\n") {
      offset += 1;
      currentLine += 1;
    } else {
      offset += 1;
    }
  }
  return Math.min(offset + character, text.length);
}

/**
 * Expand a symbol's deletion range to swallow its leading JSDoc/line comments and
 * decorators, plus trailing whitespace through the end of the line (PRD §
 * deleteSymbol). Walks lines upward from the symbol start while they look like a
 * comment or decorator, then extends the end to cover the trailing newline so no
 * blank line is left behind.
 */
function expandDeletionRange(text: string, range: Range): Range {
  const lines = text.split("\n");
  let startLine = range.start.line;
  // Absorb a contiguous block of leading comment/decorator lines.
  for (let line = startLine - 1; line >= 0; line -= 1) {
    const trimmed = (lines[line] ?? "").trim();
    const isComment =
      trimmed.startsWith("/**") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/") ||
      trimmed.startsWith("//");
    const isDecorator = trimmed.startsWith("@");
    if (isComment || isDecorator) {
      startLine = line;
    } else if (trimmed === "") {
      // Stop at a blank line: it separates this symbol from a prior one.
      break;
    } else {
      break;
    }
  }
  const start = { line: startLine, character: 0 };
  // Extend the end past the symbol's last line's newline so the trailing blank
  // line collapses. If the symbol ends mid-line, fall back to its own end.
  let endLine = range.end.line;
  let endChar = range.end.character;
  // Swallow trailing whitespace on the symbol's final line and the newline.
  const remainder = (lines[endLine] ?? "").slice(endChar);
  if (remainder.trim() === "") {
    endLine += 1;
    endChar = 0;
  }
  return { start, end: { line: endLine, character: endChar } };
}

/** Trim a symbol tree to `depth` levels (1 = top-level symbols, no children). */
function trimSymbolTreeDepth(tree: SymbolInfo[], depth: number): SymbolInfo[] {
  return tree.map((symbol) => {
    const { children, ...rest } = symbol;
    if (depth <= 1 || !children || children.length === 0) return rest;
    return { ...rest, children: trimSymbolTreeDepth(children, depth - 1) };
  });
}

function severityName(severity: number | undefined): Diagnostic["severity"] {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}

function lineContext(text: string, zeroBasedLine: number): string {
  return text.split(/\r?\n/)[zeroBasedLine] ?? "";
}

function symbolInformationLocation(
  symbol: SymbolInformation | WorkspaceSymbol,
): LspLocation | undefined {
  if (!("location" in symbol)) return undefined;
  const location = symbol.location;
  if (!location || typeof location !== "object") return undefined;
  if ("range" in location) return location;
  return undefined;
}

function isBareSymbolQuery(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length > 0 && !trimmed.includes("/") && !trimmed.includes(".");
}

function formatWorkspaceSymbolCandidate(symbol: WorkspaceSymbolInfo): string {
  return `${symbol.file}: ${symbol.path} (${symbol.kind}, exported: ${symbol.exported})`;
}

export class LspApi {
  private readonly rootDir: string;
  private readonly client: LspClient;
  private readonly ignoreRules: IgnoreRule[];
  private readonly rootRealPath: string;
  private buffer: TransactionalBuffer | null = null;

  constructor(options: { rootDir: string; client: LspClient }) {
    this.rootDir = resolve(options.rootDir);
    this.rootRealPath = realpathSync(this.rootDir);
    this.client = options.client;
    this.ignoreRules = loadIgnoreRules(this.rootDir);
  }

  /**
   * Begin a fresh transaction (one per `execute` script). The returned buffer
   * holds all buffered writes; the runner flushes it on success and rolls it back
   * on failure. Reads during the transaction reflect the buffer.
   */
  beginTransaction(): TransactionalBuffer {
    const buffer = new TransactionalBuffer(this.client);
    this.buffer = buffer;
    return buffer;
  }

  /** End the current transaction, clearing the active buffer. */
  endTransaction(): void {
    this.buffer = null;
  }

  /**
   * Read a workspace file's current content, reflecting buffered writes when a
   * transaction is active. Throws DeletedFileError if it was deleted this script.
   *
   * When a buffer is active, the first read of a file opens it in the LSP server
   * (`track`), which requires the server alive. The execute runner ensures that
   * before any script runs; {@link ensureReadyForBuffer} covers direct-API callers.
   */
  private readText(resolved: ResolvedWorkspacePath): string {
    if (this.buffer) {
      return this.buffer.getText(resolved.absPath, resolved.relPath);
    }
    return readFileSync(resolved.absPath, "utf8");
  }

  /**
   * Ensure the LSP server is alive before a buffered read opens a document. No-op
   * outside a transaction (plain disk reads need no server).
   */
  private async ensureReadyForBuffer(): Promise<void> {
    if (this.buffer) await this.client.ensureAlive();
  }

  /**
   * Like {@link readText} but for incidental reads (reference context, search)
   * where a deleted file should just be skipped rather than throw. Returns the
   * buffered content for tracked files, disk content otherwise, or "" if gone.
   * Crucially it never tracks/opens the file: a searchText scan touches every
   * project file, and opening them all in tsserver produced tens of thousands
   * of garbage diagnostics in a real session.
   */
  private readTextSafe(resolved: ResolvedWorkspacePath): string {
    if (this.buffer) {
      if (this.buffer.isDeleted(resolved.absPath)) return "";
      const buffered = this.buffer.peekText(resolved.absPath);
      if (buffered !== undefined) return buffered;
    }
    try {
      return readFileSync(resolved.absPath, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Validate an op's string arguments up front with self-correction guidance.
   * Field report: wrong-shape calls previously died with raw JS errors — a
   * symbol name passed as a file became ENOENT, a missing second argument
   * became "input.trim is not a function" — none of which tell the model what
   * the op actually expects. `contentArgs` may be empty strings.
   */
  private requireStrings(
    signature: string,
    example: string,
    args: Record<string, unknown>,
    contentArgs: string[] = [],
  ): void {
    for (const [name, value] of Object.entries(args)) {
      const allowEmpty = contentArgs.includes(name);
      if (typeof value === "string" && (allowEmpty || value.trim() !== "")) {
        continue;
      }
      const got =
        value === undefined
          ? "nothing (missing argument)"
          : value === null
            ? "null"
            : Array.isArray(value)
              ? "an array"
              : `${typeof value === "object" ? "an" : "a"} ${typeof value}`;
      throw new Error(
        `${signature}: "${name}" must be a ${allowEmpty ? "" : "non-empty "}string but got ${got}. Example: ${example}`,
      );
    }
  }

  resolveWorkspacePath(file: string): ResolvedWorkspacePath {
    const absPath = isAbsolute(file)
      ? resolve(file)
      : resolve(this.rootDir, file);
    const rel = relative(this.rootDir, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Path "${file}" resolves outside the workspace root. Use a file path relative to the workspace root.`,
      );
    }
    this.assertRealPathInside(file, absPath);
    return {
      absPath,
      relPath: toPosixPath(rel),
      uri: pathToFileURL(absPath).href,
    };
  }

  private assertRealPathInside(originalFile: string, absPath: string): void {
    let probe = absPath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = realpathSync(probe);
    const rel = relative(this.rootRealPath, realProbe);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Path "${originalFile}" resolves outside the workspace root. Use a file path relative to the workspace root.`,
      );
    }
  }

  /** File contents as a raw string (no line numbers). */
  async readFile(file: string): Promise<string> {
    this.requireStrings("readFile(file)", 'await lsp.readFile("src/auth.ts")', {
      file,
    });
    const resolved = this.resolveWorkspacePath(file);
    await this.ensureReadyForBuffer();
    return this.readText(resolved);
  }

  /** Source code of one symbol. Get exact symbolPath values from getSymbols. */
  async getSymbolBody(file: string, symbolPath: string): Promise<string> {
    this.requireStrings(
      "getSymbolBody(file, symbolPath)",
      'await lsp.getSymbolBody("src/auth.ts", "AuthService/validate") — get file and symbolPath from getSymbols(file)',
      { file, symbolPath },
    );
    const resolved = this.resolveWorkspacePath(file);
    await this.ensureReadyForBuffer();
    const text = this.readText(resolved);
    const symbols = await this.documentSymbols(resolved);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols,
    });
    const start = offsetAt(
      text,
      symbol.range.start.line,
      symbol.range.start.character,
    );
    const end = offsetAt(
      text,
      symbol.range.end.line,
      symbol.range.end.character,
    );
    return text.slice(start, end);
  }

  /** Document symbol tree (file outline). Every path is a usable handle. Pass depth: 1 for top-level symbols only (big files produce big trees). */
  async getSymbols(file: string, depth?: number): Promise<SymbolInfo[]> {
    this.requireStrings(
      "getSymbols(file)",
      'await lsp.getSymbols("src/auth.ts")',
      { file },
    );
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
      throw new Error(
        `getSymbols(file, depth): "depth" must be a positive integer (1 = top-level symbols only) but got ${JSON.stringify(depth)}. Example: await lsp.getSymbols("src/auth.ts", 1)`,
      );
    }
    const resolved = this.resolveWorkspacePath(file);
    await this.ensureReadyForBuffer();
    const text = this.readText(resolved);
    const tree = buildSymbolInfoTree(
      await this.documentSymbols(resolved),
      text,
    );
    return depth === undefined ? tree : trimSymbolTreeDepth(tree, depth);
  }

  /** Workspace-wide symbol search; matches substrings, so filter for exact `name`. The index warms lazily — early calls may be empty; getSymbols(file) is exhaustive. */
  async findSymbol(query: string): Promise<WorkspaceSymbolInfo[]> {
    this.requireStrings(
      "findSymbol(query)",
      'await lsp.findSymbol("AuthService")',
      { query },
    );
    const symbols = await this.workspaceSymbolWithIndexWait(query);
    const mapped: WorkspaceSymbolInfo[] = [];
    for (const symbol of symbols) {
      const location = symbolInformationLocation(symbol);
      if (!location) continue;
      const workspacePath = this.workspacePathFromUri(location.uri);
      if (!workspacePath) continue;
      const text = existsSync(workspacePath.absPath)
        ? readFileSync(workspacePath.absPath, "utf8")
        : "";
      mapped.push({
        name: symbol.name,
        file: workspacePath.relPath,
        path:
          "containerName" in symbol && symbol.containerName
            ? `${symbol.containerName}/${symbol.name}`
            : symbol.name,
        kind: symbolKindName(symbol.kind),
        exported: this.lineLooksExported(text, location.range.start.line),
        startLine: location.range.start.line + 1,
        endLine: location.range.end.line + 1,
        signature:
          lineContext(text, location.range.start.line).trim() || undefined,
      });
    }
    this.throwIfAmbiguousBareName(query, mapped);
    return mapped;
  }

  /** All references to a symbol across the workspace (incl. the declaration). */
  async findReferences(file: string, symbolPath: string): Promise<Reference[]> {
    this.requireStrings(
      "findReferences(file, symbolPath)",
      'await lsp.findReferences("src/auth.ts", "AuthService/validate") — get file and symbolPath from getSymbols(file)',
      { file, symbolPath },
    );
    const resolved = this.resolveWorkspacePath(file);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols: await this.documentSymbols(resolved),
    });
    const locations = await this.client.references({
      uri: resolved.uri,
      position: symbol.selectionRange.start,
    });
    const references: Reference[] = [];
    for (const location of locations) {
      const workspacePath = this.workspacePathFromUri(location.uri);
      if (!workspacePath) continue;
      const text = this.readTextSafe(workspacePath);
      const containingPath = await this.containingPathForLocation(
        workspacePath,
        location,
      );
      references.push({
        file: workspacePath.relPath,
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
        context: lineContext(text, location.range.start.line),
        symbolPath: containingPath ?? "",
        // Standard LSP references return only Location objects; TLS does not
        // expose read/write classification here. See PRD Phase 2 Decision Log.
        isWriteAccess: false,
      });
    }
    return references;
  }

  /** Jump to the definition of a symbol DEFINED in `file` — imports/callees in a body are not addressable; resolve those names with findSymbol. */
  async goToDefinition(file: string, symbolPath: string): Promise<Location> {
    this.requireStrings(
      "goToDefinition(file, symbolPath)",
      'await lsp.goToDefinition("src/auth.ts", "AuthService/validate")',
      { file, symbolPath },
    );
    const resolved = this.resolveWorkspacePath(file);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols: await this.documentSymbols(resolved),
    });
    const locations = await this.client.definition({
      uri: resolved.uri,
      position: symbol.selectionRange.start,
    });
    const first = locations[0];
    if (!first) {
      throw new Error(
        `Definition for symbol "${symbolPath}" not found from "${resolved.relPath}".`,
      );
    }
    return this.locationToApiLocation(first);
  }

  /** Functions that CALL this symbol — true calls only (no imports/re-exports), each attributed to its enclosing function with exact call sites. */
  async incomingCalls(file: string, symbolPath: string): Promise<CallInfo[]> {
    const item = await this.callHierarchyItemFor(
      "incomingCalls(file, symbolPath)",
      'await lsp.incomingCalls("src/auth.ts", "AuthService/validate")',
      file,
      symbolPath,
    );
    const calls = await this.client.incomingCalls(item);
    const results: CallInfo[] = [];
    for (const call of calls) {
      // Incoming call sites live in the CALLER's file.
      const info = await this.callHierarchyItemToInfo(
        call.from,
        call.fromRanges,
        call.from.uri,
      );
      if (info) results.push(info);
    }
    return results;
  }

  /** Functions this symbol's body CALLS, each resolved to its definition (follows imports across modules); workspace functions only — library calls are omitted. */
  async outgoingCalls(file: string, symbolPath: string): Promise<CallInfo[]> {
    const item = await this.callHierarchyItemFor(
      "outgoingCalls(file, symbolPath)",
      'await lsp.outgoingCalls("src/payments.ts", "recordPayment")',
      file,
      symbolPath,
    );
    const calls = await this.client.outgoingCalls(item);
    const results: CallInfo[] = [];
    for (const call of calls) {
      // Outgoing call sites live in the QUERIED symbol's own body.
      const info = await this.callHierarchyItemToInfo(
        call.to,
        call.fromRanges,
        item.uri,
      );
      if (info) results.push(info);
    }
    return results;
  }

  /** What the symbol's body uses from OUTSIDE itself: imported bindings (with module + type-only flag) and same-file top-level symbols — the exact imports it needs if moved to another file. Syntactic, so a local shadowing an import can rarely produce a false positive. */
  async getDependencies(
    file: string,
    symbolPath: string,
  ): Promise<SymbolDependencies> {
    this.requireStrings(
      "getDependencies(file, symbolPath)",
      'await lsp.getDependencies("src/payments.ts", "recordPayment")',
      { file, symbolPath },
    );
    const resolved = this.resolveWorkspacePath(file);
    const symbols = await this.documentSymbols(resolved);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols,
    });
    const text = this.readTextSafe(resolved);
    const topLevelNames = buildSymbolInfoTree(symbols, text).map(
      (info) => info.name,
    );
    // Exclude the symbol's own top-level ancestor so recursion (or a method
    // referencing its own class) doesn't count as a same-file dependency.
    const selfName =
      symbol.path.split("/")[0]?.replace(/\[\d+\]$/, "") ?? symbol.name;
    return analyzeDependencies({
      fileName: resolved.relPath,
      sourceText: text,
      range: symbol.range,
      topLevelNames,
      selfName,
    });
  }

  /** Resolve (file, symbolPath) to the LSP call-hierarchy item, or throw an LLM-targeted error. */
  private async callHierarchyItemFor(
    signature: string,
    example: string,
    file: string,
    symbolPath: string,
  ): Promise<CallHierarchyItem> {
    this.requireStrings(signature, example, { file, symbolPath });
    const resolved = this.resolveWorkspacePath(file);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols: await this.documentSymbols(resolved),
    });
    const items = await this.client.prepareCallHierarchy({
      uri: resolved.uri,
      position: symbol.selectionRange.start,
    });
    const item = items[0];
    if (!item) {
      throw new Error(
        `"${symbolPath}" in "${resolved.relPath}" has no call hierarchy — the symbol must be callable (a function, method, or constructor; its kind is "${symbol.kind}"). Pick a function-like symbol from getSymbols("${resolved.relPath}").`,
      );
    }
    return item;
  }

  /**
   * Map one side of a call edge to a CallInfo. Returns undefined for items
   * outside the workspace (lib.d.ts, node_modules) so call graphs contain only
   * workspace functions.
   */
  private async callHierarchyItemToInfo(
    item: CallHierarchyItem,
    fromRanges: Range[],
    rangesUri: string,
  ): Promise<CallInfo | undefined> {
    const itemPath = this.workspacePathFromUri(item.uri);
    if (!itemPath) return undefined;
    const rangesPath = this.workspacePathFromUri(rangesUri);
    const rangesText = rangesPath ? this.readTextSafe(rangesPath) : "";
    // tsserver may hand back an anonymous callback as the item; mapping its
    // selection range through the addressable symbol tree lands on the nearest
    // reusable handle (the named enclosing function).
    let symbolPath: string | undefined;
    try {
      const symbols = await this.documentSymbols(itemPath);
      symbolPath =
        symbolPathForRange(symbols, item.selectionRange) ??
        containingFunctionPath(symbols, item.selectionRange.start);
    } catch {
      symbolPath = undefined;
    }
    return {
      file: itemPath.relPath,
      // When no addressable symbol encloses the call (e.g. module-level code,
      // bare test(...) blocks), tsserver hands back the source FILE as the
      // item; its name (a filename) is not a symbol path and would not
      // round-trip. "" marks top level, same convention as Reference.
      symbolPath: symbolPath ?? "",
      name: item.name,
      kind: symbolKindName(item.kind),
      // tsserver occasionally reports the same range twice — dedupe by position.
      callSites: [
        ...new Map(
          fromRanges.map((range) => [
            `${range.start.line}:${range.start.character}`,
            {
              line: range.start.line + 1,
              column: range.start.character + 1,
              context: rangesPath
                ? lineContext(rangesText, range.start.line)
                : "",
            },
          ]),
        ).values(),
      ],
    };
  }

  /** Regex search across project files — escape metacharacters for literal text; optional second arg is a glob string. */
  async searchText(pattern: string, glob?: string): Promise<SearchResult[]> {
    this.requireStrings(
      "searchText(pattern, glob?)",
      'await lsp.searchText("new NotFoundError\\\\(", "src/**") — the pattern is a regex; escape metacharacters for literal text',
      { pattern },
    );
    if (glob !== undefined && glob !== null && typeof glob !== "string") {
      // Observed failure mode: scripts invent an options object here, which
      // would otherwise silently match nothing.
      throw new Error(
        'searchText(pattern, glob?) takes a glob STRING as its second argument, e.g. searchText("TODO", "src/**"). There is no options object — filter or slice the returned array in your script instead.',
      );
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "g");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid searchText regex "${pattern}": ${message}`);
    }
    const results: SearchResult[] = [];
    await this.ensureReadyForBuffer();
    for (const file of await this.listFiles(glob)) {
      const resolved = this.resolveWorkspacePath(file);
      const lines = this.readTextSafe(resolved).split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        regex.lastIndex = 0;
        for (
          let match = regex.exec(line);
          match !== null;
          match = regex.exec(line)
        ) {
          results.push({
            file,
            line: lineIndex + 1,
            column: match.index + 1,
            match: match[0],
            context: line,
          });
          if (match[0].length === 0) regex.lastIndex += 1;
        }
      }
    }
    return results;
  }

  /**
   * Normalize a listFiles/searchText glob (LLM-facing DWIM, from observed
   * sessions): non-strings throw instead of silently matching nothing; ""/"."
   * mean the whole workspace; absolute paths inside the root become relative;
   * and a wildcard-free path naming an existing directory becomes "dir/**" —
   * `listFiles("src")` always means `listFiles("src/**")`.
   */
  private normalizeGlob(glob: unknown): string {
    if (glob === undefined || glob === null) return "**/*";
    if (typeof glob !== "string") {
      throw new Error(
        `listFiles/searchText globs must be strings like "src/**/*.ts" (got ${typeof glob}). Omit the glob to cover every file.`,
      );
    }
    let candidate = glob.trim();
    if (candidate.startsWith("./")) candidate = candidate.slice(2);
    while (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
    if (candidate === "" || candidate === ".") return "**/*";
    if (isAbsolute(candidate)) {
      const rel = relative(this.rootDir, resolve(candidate));
      if (rel === "") return "**/*";
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `Glob "${glob}" points outside the workspace root. Use a workspace-relative pattern like "src/**".`,
        );
      }
      candidate = toPosixPath(rel);
    }
    if (!/[*?[\]{}]/.test(candidate)) {
      const abs = resolve(this.rootDir, candidate);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        return `${candidate}/**`;
      }
    }
    return candidate;
  }

  /** Project files matching a glob; no glob = all files, a directory name means everything under it. */
  async listFiles(glob?: string): Promise<string[]> {
    const matcher = globToRegExp(this.normalizeGlob(glob));
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = resolve(dir, entry.name);
        const relPath = toPosixPath(relative(this.rootDir, abs));
        if (ALWAYS_EXCLUDED_DIRS.has(entry.name)) continue;
        if (isIgnored(relPath, entry.isDirectory(), this.ignoreRules)) continue;
        if (entry.isDirectory()) {
          visit(abs);
          continue;
        }
        if (entry.isFile() && matcher.test(relPath)) files.push(relPath);
      }
    };
    visit(this.rootDir);
    return files.sort();
  }

  /** Diagnostics for a file, or every file touched this session (not project-wide). */
  async getDiagnostics(file?: string): Promise<Diagnostic[]> {
    if (file !== undefined && file !== null) {
      this.requireStrings(
        "getDiagnostics(file?)",
        'await lsp.getDiagnostics("src/auth.ts") — or no argument for every file touched this session',
        { file },
      );
      const resolved = this.resolveWorkspacePath(file);
      // tsserver only produces meaningful diagnostics for TS-family files;
      // asking about a lockfile/markdown/etc. is a quick, clean empty answer.
      if (!isLspDocumentPath(resolved.absPath)) return [];
      await this.client.ensureAlive();
      // During a transaction the file may carry buffered edits; track() opens it
      // at buffered content rather than re-reading disk.
      if (this.buffer) this.buffer.track(resolved.absPath);
      else this.client.openTextDocument(resolved.absPath);
      await this.client.waitForDiagnosticsForUris([resolved.uri]);
      return this.convertDiagnosticsForUri(
        resolved.uri,
        this.client.getDiagnosticsForUris([resolved.uri]),
      );
    }
    return this.client
      .getTouchedUris()
      .flatMap((uri) =>
        this.convertDiagnosticsForUri(
          uri,
          this.client.getDiagnosticsForUris([uri]),
        ),
      );
  }

  // ---- Write operations (Phase 4) -----------------------------------------
  // All require an active transaction (begun by the execute runner). Each routes
  // its edit through the buffer (didChange), then collects fresh diagnostics for
  // the affected files (≤2s wait) so the write-check-fix loop fits in one script.

  /** Rename a symbol across the whole codebase (LSP rename). */
  async renameSymbol(
    file: string,
    symbolPath: string,
    newName: string,
  ): Promise<WriteResult> {
    this.requireStrings(
      "renameSymbol(file, symbolPath, newName)",
      'await lsp.renameSymbol("src/auth.ts", "AuthService/validate", "checkToken")',
      { file, symbolPath, newName },
    );
    const buffer = this.requireBuffer("renameSymbol");
    const resolved = this.resolveWorkspacePath(file);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols: await this.documentSymbols(resolved),
    });
    // prepareRename validates the position is renameable; surface its rejection
    // as an LLM-readable error rather than letting rename silently no-op.
    let prepared: unknown;
    try {
      prepared = await this.client.prepareRename({
        uri: resolved.uri,
        position: symbol.selectionRange.start,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot rename "${symbolPath}" in "${resolved.relPath}": ${message}`,
      );
    }
    if (prepared === null) {
      throw new Error(
        `Symbol "${symbolPath}" in "${resolved.relPath}" cannot be renamed at this position.`,
      );
    }
    // Open every file that references the symbol so tsserver includes them in the
    // rename's WorkspaceEdit. Cross-file rename only fans out to documents the
    // server has in its project view; references that live in unopened files are
    // otherwise missed (PRD § Rename fan-out is the highest-risk operation). The
    // cross-file index is built lazily, so the first references call after warmup
    // can return only the origin file (PRD Risk #2) — poll until it stabilizes.
    await this.warmReferenceIndex(
      resolved,
      symbol.selectionRange.start,
      buffer,
    );
    const edit = await this.client.rename({
      uri: resolved.uri,
      position: symbol.selectionRange.start,
      newName,
    });
    const editsByPath = this.workspaceEditToEdits(edit);
    if (editsByPath.size === 0) {
      throw new Error(
        `Rename of "${symbolPath}" in "${resolved.relPath}" produced no edits.`,
      );
    }
    const affected: string[] = [];
    for (const [absPath, edits] of editsByPath) {
      buffer.applyEdits(absPath, edits);
      affected.push(absPath);
    }
    const filesChanged = affected
      .map((absPath) => this.relPathFor(absPath))
      .sort();
    const diagnostics = await this.collectDiagnostics(affected);
    return { file: resolved.relPath, filesChanged, diagnostics };
  }

  /** Replace a symbol's full declaration with newText (pair with getSymbolBody). */
  async replaceSymbolBody(
    file: string,
    symbolPath: string,
    newText: string,
  ): Promise<WriteResult> {
    this.requireStrings(
      "replaceSymbolBody(file, symbolPath, newText)",
      'await lsp.replaceSymbolBody("src/auth.ts", "AuthService/validate", "validate(token: Token): boolean { … }")',
      { file, symbolPath, newText },
      ["newText"],
    );
    return this.editSymbolRange(file, symbolPath, (symbol) => ({
      range: symbol.range,
      newText,
    }));
  }

  /** Insert code on its own line(s) directly above a symbol's declaration. */
  async insertBeforeSymbol(
    file: string,
    symbolPath: string,
    text: string,
  ): Promise<WriteResult> {
    this.requireStrings(
      "insertBeforeSymbol(file, symbolPath, text)",
      'await lsp.insertBeforeSymbol("src/auth.ts", "AuthService", "// header\\n")',
      { file, symbolPath, text },
      ["text"],
    );
    // Anchor to column 0 of the symbol's start line so the inserted block lands on
    // its own line(s) above the whole declaration — not mid-line after a leading
    // `export const` (a symbol's range often starts at the name, not the modifier).
    return this.editSymbolRange(file, symbolPath, (symbol) => ({
      range: {
        start: { line: symbol.range.start.line, character: 0 },
        end: { line: symbol.range.start.line, character: 0 },
      },
      newText: text.endsWith("\n") ? text : `${text}\n`,
    }));
  }

  /** Insert code on its own line(s) directly below a symbol's declaration. */
  async insertAfterSymbol(
    file: string,
    symbolPath: string,
    text: string,
  ): Promise<WriteResult> {
    this.requireStrings(
      "insertAfterSymbol(file, symbolPath, text)",
      'await lsp.insertAfterSymbol("src/auth.ts", "AuthService", "export const x = 1;\\n")',
      { file, symbolPath, text },
      ["text"],
    );
    // Anchor just past the end of the symbol's last line.
    return this.editSymbolRange(file, symbolPath, (symbol) => ({
      range: { start: symbol.range.end, end: symbol.range.end },
      newText: text.startsWith("\n") ? text : `\n${text}`,
    }));
  }

  /** Remove a symbol including its leading JSDoc/decorators. */
  async deleteSymbol(file: string, symbolPath: string): Promise<WriteResult> {
    this.requireStrings(
      "deleteSymbol(file, symbolPath)",
      'await lsp.deleteSymbol("src/auth.ts", "AuthService/validate")',
      { file, symbolPath },
    );
    const buffer = this.requireBuffer("deleteSymbol");
    const resolved = this.resolveWorkspacePath(file);
    await this.client.ensureAlive();
    const text = this.readText(resolved);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols: await this.documentSymbols(resolved),
    });
    const range = expandDeletionRange(text, symbol.range);
    buffer.applyEdits(resolved.absPath, [{ range, newText: "" }]);
    const diagnostics = await this.collectDiagnostics([resolved.absPath]);
    return {
      file: resolved.relPath,
      filesChanged: [resolved.relPath],
      diagnostics,
    };
  }

  /** Create or overwrite a whole file (escape hatch for non-symbol edits). */
  async writeFile(file: string, content: string): Promise<WriteResult> {
    this.requireStrings(
      "writeFile(file, content)",
      'await lsp.writeFile("src/new.ts", "export const x = 1;\\n")',
      { file, content },
      ["content"],
    );
    const buffer = this.requireBuffer("writeFile");
    const resolved = this.resolveWorkspacePath(file);
    await this.client.ensureAlive();
    buffer.writeFile(resolved.absPath, content);
    const diagnostics = await this.collectDiagnostics([resolved.absPath]);
    return {
      file: resolved.relPath,
      filesChanged: [resolved.relPath],
      diagnostics,
    };
  }

  /** Delete a file. */
  async deleteFile(file: string): Promise<WriteResult> {
    this.requireStrings(
      "deleteFile(file)",
      'await lsp.deleteFile("src/old.ts")',
      { file },
    );
    const buffer = this.requireBuffer("deleteFile");
    const resolved = this.resolveWorkspacePath(file);
    await this.client.ensureAlive();
    // Touch tracking so other touched files' diagnostics still resolve, but the
    // deleted file itself has no diagnostics.
    buffer.deleteFile(resolved.absPath, resolved.relPath);
    return {
      file: resolved.relPath,
      filesChanged: [resolved.relPath],
      diagnostics: [],
    };
  }

  /**
   * Type-check the WHOLE project: an in-process TypeScript program over the
   * buffered state under the real tsconfig. Unlike per-file getDiagnostics,
   * path aliases resolve even in files created this script — use this as the
   * verify gate for multi-file refactors. Slow on big projects (full program).
   */
  async checkProject(): Promise<ProjectCheckResult> {
    return runProjectCheck({
      rootDir: this.rootDir,
      overlay: this.buffer?.overlay() ?? new Map(),
    });
  }

  /** Drop a file's unused imports, then sort and merge the rest (native TS organize-imports). */
  async organizeImports(file: string): Promise<WriteResult> {
    this.requireStrings(
      "organizeImports(file)",
      'await lsp.organizeImports("src/auth.ts")',
      { file },
    );
    // tsserver splits the behavior: organizeImports alone is non-destructive
    // (sort/merge), removeUnusedImports does the dropping. Chain both.
    return this.runSourceAction(file, [
      ["source.removeUnusedImports.ts"],
      ["source.organizeImports.ts", "source.organizeImports"],
    ]);
  }

  /** Add import statements for every unresolved name the file uses (native TS auto-import). Most reliable on files that already exist on disk. */
  async addMissingImports(file: string): Promise<WriteResult> {
    this.requireStrings(
      "addMissingImports(file)",
      'await lsp.addMissingImports("src/auth.ts")',
      { file },
    );
    return this.runSourceAction(file, [["source.addMissingImports.ts"]]);
  }

  /** Move a TOP-LEVEL symbol to another file (created if missing): brings its JSDoc, computes the target's imports (deduped against what it already imports), back-imports if the source still uses it, repoints every importer (alias-aware), and prunes the source's now-unused imports. The moved symbol becomes exported. Moving a whole cluster? moveSymbols is much faster. */
  async moveSymbol(
    file: string,
    symbolPath: string,
    targetFile: string,
  ): Promise<MoveSymbolResult> {
    this.requireStrings(
      "moveSymbol(file, symbolPath, targetFile)",
      'await lsp.moveSymbol("src/commands.ts", "loadSnapshot", "src/snapshot.ts")',
      { file, symbolPath, targetFile },
    );
    return this.moveSymbolsImpl(file, [symbolPath], targetFile);
  }

  /** Move several TOP-LEVEL symbols from one file to another in one pass (list them in dependency order: types/helpers first). Same per-symbol behavior as moveSymbol, but imports/cleanups/diagnostics are handled once for the whole batch — the fast path for extracting a cluster. */
  async moveSymbols(
    file: string,
    symbolPaths: string[],
    targetFile: string,
  ): Promise<MoveSymbolResult> {
    this.requireStrings(
      "moveSymbols(file, symbolPaths, targetFile)",
      'await lsp.moveSymbols("src/commands.ts", ["Snapshot", "loadSnapshot"], "src/snapshot.ts")',
      { file, targetFile },
    );
    if (
      !Array.isArray(symbolPaths) ||
      symbolPaths.length === 0 ||
      symbolPaths.some((p) => typeof p !== "string" || p.length === 0)
    ) {
      throw new Error(
        `moveSymbols(file, symbolPaths, targetFile): "symbolPaths" must be a non-empty array of symbol-path strings but got ${JSON.stringify(symbolPaths)}. Example: await lsp.moveSymbols("src/commands.ts", ["Snapshot", "loadSnapshot"], "src/snapshot.ts")`,
      );
    }
    return this.moveSymbolsImpl(file, symbolPaths, targetFile);
  }

  private async moveSymbolsImpl(
    file: string,
    symbolPaths: string[],
    targetFile: string,
  ): Promise<MoveSymbolResult> {
    const buffer = this.requireBuffer("moveSymbol");
    const source = this.resolveWorkspacePath(file);
    const target = this.resolveWorkspacePath(targetFile);
    if (source.absPath === target.absPath) {
      throw new Error(
        `moveSymbol: source and target are the same file ("${source.relPath}").`,
      );
    }
    if (!isLspDocumentPath(target.absPath)) {
      throw new Error(
        `moveSymbol: target "${target.relPath}" must be a TypeScript/JavaScript file.`,
      );
    }
    await this.client.ensureAlive();
    const aliases = this.loadAliasMaps();
    const targetExistedBefore =
      !buffer.isDeleted(target.absPath) &&
      (buffer.peekText(target.absPath) !== undefined ||
        existsSync(target.absPath));

    const touched = new Set<string>([source.absPath, target.absPath]);
    const autoExported = new Set<string>();
    for (const symbolPath of symbolPaths) {
      const moved = await this.moveOneSymbol(
        buffer,
        source,
        target,
        symbolPath,
        aliases,
      );
      for (const absPath of moved.touched) touched.add(absPath);
      for (const name of moved.autoExported) autoExported.add(name);
    }

    // Native cleanups ONCE for the whole batch: drop the source imports the
    // moved bodies took with them; merge the prepended headers into a
    // pre-existing target's import block. (Per-batch, not per-move — a field
    // run burned its 30s timeout on per-move cleanup round trips.)
    await this.applyCodeActionEdits(source, ["source.removeUnusedImports.ts"]);
    if (targetExistedBefore) {
      await this.applyCodeActionEdits(target, ["source.organizeImports.ts"]);
    }

    const touchedList = [...touched];
    const diagnostics = await this.collectDiagnostics(touchedList);
    return {
      file: source.relPath,
      filesChanged: touchedList
        .map((absPath) => this.relPathFor(absPath))
        .sort(),
      diagnostics,
      autoExported: [...autoExported].sort(),
    };
  }

  /** Move one top-level symbol; analysis-then-mutation, no cleanups/diagnostics. */
  private async moveOneSymbol(
    buffer: TransactionalBuffer,
    source: ResolvedWorkspacePath,
    target: ResolvedWorkspacePath,
    symbolPath: string,
    aliases: AliasMaps,
  ): Promise<{ touched: string[]; autoExported: string[] }> {
    const text = this.readText(source);
    const symbols = await this.documentSymbols(source);
    const symbol = resolveSymbolPath({
      file: source.relPath,
      symbolPath,
      symbols,
    });
    if (symbol.path.includes("/")) {
      throw new Error(
        `moveSymbol moves TOP-LEVEL symbols only, but "${symbol.path}" is nested inside "${symbol.path.split("/")[0]}". Move the whole top-level symbol, or restructure with getSymbolBody + writeFile.`,
      );
    }
    const movedName = symbol.path.replace(/\[\d+\]$/, "");
    const infoTree = buildSymbolInfoTree(symbols, text);

    // Everything below mutates only after all analysis ran on the pre-move text.
    const deps = analyzeDependencies({
      fileName: source.relPath,
      sourceText: text,
      range: symbol.range,
      topLevelNames: infoTree.map((info) => info.name),
      selfName: movedName,
    });
    await this.warmReferenceIndex(source, symbol.selectionRange.start, buffer);
    const locations = await this.client.references({
      uri: source.uri,
      position: symbol.selectionRange.start,
    });
    const referencingPaths = new Map<string, ResolvedWorkspacePath>();
    for (const location of locations) {
      const workspacePath = this.workspacePathFromUri(location.uri);
      if (!workspacePath) continue;
      if (workspacePath.absPath === source.absPath) continue;
      if (workspacePath.absPath === target.absPath) continue;
      referencingPaths.set(workspacePath.absPath, workspacePath);
    }

    const movedRange = expandDeletionRange(text, symbol.range);
    const startOffset = offsetAt(
      text,
      movedRange.start.line,
      movedRange.start.character,
    );
    const endOffset = offsetAt(
      text,
      movedRange.end.line,
      movedRange.end.character,
    );
    const movedText = ensureTopLevelExport(
      target.relPath,
      `${text.slice(startOffset, endOffset).trimEnd()}\n`,
      movedName,
    );

    const typeNames = topLevelTypeNames(source.relPath, text, [
      ...deps.sameFile,
      movedName,
    ]);

    // Current target state: needed to dedupe the header (field run: two moved
    // functions sharing a dependency produced "Duplicate identifier") and to
    // drop a pre-existing import of the moved symbol from the source module
    // (it would collide with the arriving definition).
    const targetExisted =
      !buffer.isDeleted(target.absPath) &&
      (buffer.peekText(target.absPath) !== undefined ||
        existsSync(target.absPath));
    let targetText = targetExisted ? this.readText(target) : undefined;
    if (targetText !== undefined) {
      targetText = removeImportOfName({
        fileName: target.relPath,
        sourceText: targetText,
        name: movedName,
        isModule: (specifier) =>
          specifierResolvesTo(
            specifier,
            target.relPath,
            source.relPath,
            aliases,
          ),
      }).text;
    }
    const existingTargetBindings =
      targetText !== undefined
        ? importBindingNames(target.relPath, targetText)
        : new Set<string>();

    // Construct the target's import header deterministically from the
    // dependency analysis — no auto-import involved, so it works identically
    // for created files.
    const byModule = new Map<
      string,
      { names: string[]; typeOnlyNames: string[] }
    >();
    const bucketFor = (specifier: string) => {
      const existing = byModule.get(specifier);
      if (existing) return existing;
      const bucket = { names: [], typeOnlyNames: [] };
      byModule.set(specifier, bucket);
      return bucket;
    };
    for (const dependency of deps.imports) {
      // Already bound in the target (e.g. an earlier move in this batch
      // brought it) — adding it again is the duplicate-identifier bug.
      if (existingTargetBindings.has(dependency.name)) continue;
      const specifier = rewriteSpecifier(
        dependency.from,
        source.relPath,
        target.relPath,
      );
      // A dependency that resolves to the target itself needs no import there.
      if (
        specifierResolvesTo(specifier, target.relPath, target.relPath, aliases)
      ) {
        continue;
      }
      const bucket = bucketFor(specifier);
      (dependency.typeOnly ? bucket.typeOnlyNames : bucket.names).push(
        dependency.name,
      );
    }
    const neededSameFile = deps.sameFile.filter(
      (name) => !existingTargetBindings.has(name),
    );
    if (neededSameFile.length > 0) {
      const fromSource = relativeSpecifier(target.relPath, source.relPath);
      const bucket = bucketFor(fromSource);
      for (const name of neededSameFile) {
        (typeNames.has(name) ? bucket.typeOnlyNames : bucket.names).push(name);
      }
    }
    const headerImports: HeaderImport[] = [...byModule.entries()].map(
      ([from, bucket]) => ({ from, ...bucket }),
    );
    const header = renderImportHeader(headerImports);

    const newTargetText =
      targetText !== undefined
        ? `${header ? `${header}\n` : ""}${targetText.trimEnd()}\n\n${movedText}`
        : `${header ? `${header}\n\n` : ""}${movedText}`;

    // Source: cut the block, auto-export stayed-behind dependencies, add a
    // back-import when the remaining code still uses the moved symbol.
    let newSourceText = text.slice(0, startOffset) + text.slice(endOffset);
    const notExported = deps.sameFile.filter(
      (name) => !infoTree.some((info) => info.name === name && info.exported),
    );
    const exportResult = addExportModifiers(
      source.relPath,
      newSourceText,
      notExported,
    );
    newSourceText = exportResult.text;
    const stillUsed = namesUsedOutsideImports(source.relPath, newSourceText, [
      movedName,
    ]).has(movedName);
    if (stillUsed) {
      const keyword = typeNames.has(movedName) ? "import type" : "import";
      const specifier = relativeSpecifier(source.relPath, target.relPath);
      newSourceText = `${keyword} { ${movedName} } from "${specifier}";\n${newSourceText}`;
    }

    buffer.writeFile(target.absPath, newTargetText);
    buffer.writeFile(source.absPath, newSourceText);

    // Repoint every importer, preserving its specifier style (alias importers
    // stay on the alias when the target maps onto one).
    const targetBase = stripModuleExtension(target.relPath);
    const changedReferencers: string[] = [];
    for (const [absPath, refPath] of referencingPaths) {
      const refText = this.readText(refPath);
      const rewired = rewireMovedImport({
        fileName: refPath.relPath,
        sourceText: refText,
        movedName,
        isOldModule: (specifier) =>
          specifierResolvesTo(
            specifier,
            refPath.relPath,
            source.relPath,
            aliases,
          ),
        newSpecifierFor: (oldSpecifier) =>
          oldSpecifier.startsWith(".")
            ? relativeSpecifier(refPath.relPath, target.relPath)
            : (aliases.toAlias(targetBase) ??
              relativeSpecifier(refPath.relPath, target.relPath)),
      });
      if (rewired.changed) {
        buffer.writeFile(absPath, rewired.text);
        changedReferencers.push(absPath);
      }
    }

    return {
      touched: [source.absPath, target.absPath, ...changedReferencers],
      autoExported: exportResult.exported,
    };
  }

  /**
   * Request the first matching source.* code action for the file's full range
   * and apply its WorkspaceEdit through the buffer. Returns affected absPaths.
   */
  private async applyCodeActionEdits(
    resolved: ResolvedWorkspacePath,
    kinds: string[],
  ): Promise<string[]> {
    const buffer = this.requireBuffer("applyCodeActionEdits");
    const text = buffer.getText(resolved.absPath, resolved.relPath);
    const lines = text.split("\n");
    const range = {
      start: { line: 0, character: 0 },
      end: {
        line: Math.max(lines.length - 1, 0),
        character: lines[lines.length - 1]?.length ?? 0,
      },
    };
    const actions = await this.client.codeAction({
      uri: resolved.uri,
      range,
      only: kinds,
    });
    const affected: string[] = [];
    for (const action of actions) {
      if (!action.edit) continue;
      for (const [absPath, edits] of this.workspaceEditToEdits(action.edit)) {
        buffer.applyEdits(absPath, edits);
        affected.push(absPath);
      }
      break;
    }
    return affected;
  }

  private async runSourceAction(
    file: string,
    rounds: string[][],
  ): Promise<WriteResult> {
    const resolved = this.resolveWorkspacePath(file);
    this.requireBuffer(rounds[0]?.[0] ?? "sourceAction");
    await this.ensureReadyForBuffer();
    const applyRounds = async (): Promise<string[]> => {
      const paths: string[] = [];
      for (const kinds of rounds) {
        paths.push(...(await this.applyCodeActionEdits(resolved, kinds)));
      }
      return paths;
    };
    // Auto-import (and unused-detection) need tsserver's project semantics,
    // which warm up shortly after open — retry briefly before trusting an
    // empty answer, since "no action" is also the legitimate no-op result.
    // Capped at 3: a field run's addMissingImports on a big file compounded
    // each retry with a whole-project export scan and ate into the timeout.
    let affected = await applyRounds();
    for (let attempt = 0; attempt < 3 && affected.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      affected = await applyRounds();
    }
    affected = [...new Set(affected)];
    if (affected.length === 0) {
      return { file: resolved.relPath, filesChanged: [], diagnostics: [] };
    }
    const diagnostics = await this.collectDiagnostics(affected);
    return {
      file: resolved.relPath,
      filesChanged: affected.map((absPath) => this.relPathFor(absPath)).sort(),
      diagnostics,
    };
  }

  private aliasMapsCache: AliasMaps | null = null;

  /** tsconfig "paths" → alias maps, best-effort (no aliases → relative-only rewiring). */
  private loadAliasMaps(): AliasMaps {
    if (this.aliasMapsCache) return this.aliasMapsCache;
    let maps = EMPTY_ALIAS_MAPS;
    try {
      const configPath = ts.findConfigFile(
        this.rootDir,
        ts.sys.fileExists.bind(ts.sys),
      );
      if (configPath && resolve(configPath).startsWith(resolve(this.rootDir))) {
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(
          config.config ?? {},
          ts.sys,
          resolve(configPath, ".."),
        );
        const paths = parsed.options.paths;
        if (paths) {
          const base =
            parsed.options.baseUrl ??
            (parsed.options as { pathsBasePath?: string }).pathsBasePath ??
            resolve(configPath, "..");
          const workspaceRelative: Record<string, string[]> = {};
          for (const [pattern, targets] of Object.entries(paths)) {
            workspaceRelative[pattern] = targets.map((targetPattern) =>
              toPosixPath(
                relative(this.rootDir, resolve(String(base), targetPattern)),
              ),
            );
          }
          maps = aliasMapsFromPaths(workspaceRelative);
        }
      }
    } catch {
      // Alias maps are an enhancement; relative-specifier rewiring still works.
    }
    this.aliasMapsCache = maps;
    return maps;
  }

  /**
   * Poll `textDocument/references` until the set of referencing files stabilizes
   * (same set twice in a row) or a bound elapses, opening each referencing file in
   * the buffer so tsserver indexes it for the upcoming rename. Mitigates the
   * cold-start incompleteness where the first references call returns only the
   * origin file (PRD Risk #2).
   */
  private async warmReferenceIndex(
    resolved: ResolvedWorkspacePath,
    position: { line: number; character: number },
    buffer: TransactionalBuffer,
    timeoutMs = 3_000,
  ): Promise<void> {
    const started = Date.now();
    const union = new Set<string>();
    let stablePolls = 0;
    // Require the referencing-file set to stop growing for a few consecutive polls
    // before trusting it, so the cold index (which reports the origin file first,
    // then cross-file references a few hundred ms later) has time to fill in.
    while (Date.now() - started < timeoutMs) {
      const refs = await this.client.references({
        uri: resolved.uri,
        position,
      });
      let grew = false;
      for (const ref of refs) {
        const refPath = this.workspacePathFromUri(ref.uri);
        if (refPath && !union.has(refPath.absPath)) {
          union.add(refPath.absPath);
          buffer.track(refPath.absPath);
          grew = true;
        }
      }
      stablePolls = grew ? 0 : stablePolls + 1;
      if (stablePolls >= 3) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private requireBuffer(op: string): TransactionalBuffer {
    if (!this.buffer) {
      throw new Error(
        `Write operation "${op}" requires an active transaction. This is an ` +
          "internal error: write ops must run inside an execute script.",
      );
    }
    return this.buffer;
  }

  private async editSymbolRange(
    file: string,
    symbolPath: string,
    build: (symbol: { range: Range }) => TextEdit,
  ): Promise<WriteResult> {
    const buffer = this.requireBuffer("editSymbolRange");
    const resolved = this.resolveWorkspacePath(file);
    const symbol = resolveSymbolPath({
      file: resolved.relPath,
      symbolPath,
      symbols: await this.documentSymbols(resolved),
    });
    buffer.applyEdits(resolved.absPath, [build({ range: symbol.range })]);
    const diagnostics = await this.collectDiagnostics([resolved.absPath]);
    return {
      file: resolved.relPath,
      filesChanged: [resolved.relPath],
      diagnostics,
    };
  }

  private workspaceEditToEdits(
    edit: WorkspaceEdit | null,
  ): Map<string, TextEdit[]> {
    const byPath = new Map<string, TextEdit[]>();
    if (!edit) return byPath;
    const add = (uri: string, edits: TextEdit[]): void => {
      const workspacePath = this.workspacePathFromUri(uri);
      if (!workspacePath) return;
      const existing = byPath.get(workspacePath.absPath) ?? [];
      existing.push(...edits);
      byPath.set(workspacePath.absPath, existing);
    };
    if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
    }
    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        if ("textDocument" in change && "edits" in change) {
          add(
            change.textDocument.uri,
            change.edits.filter(
              (e): e is TextEdit => "range" in e && "newText" in e,
            ),
          );
        }
      }
    }
    return byPath;
  }

  /**
   * Wait ≤2s for fresh publishDiagnostics for the affected files, then return
   * their diagnostics (PRD § Diagnostics collection). The buffer has already
   * sent didChange, so tsserver re-publishes for these URIs.
   */
  private async collectDiagnostics(absPaths: string[]): Promise<Diagnostic[]> {
    // Non-TS files are never opened in tsserver (see buffer.ts), so waiting for
    // their diagnostics would just burn the 2s timeout.
    const uris = absPaths
      .filter((absPath) => isLspDocumentPath(absPath))
      .map((absPath) => pathToFileURL(absPath).href);
    if (uris.length === 0) return [];
    await this.client.waitForDiagnosticsForUris(uris);
    return uris.flatMap((uri) =>
      this.convertDiagnosticsForUri(
        uri,
        this.client.getDiagnosticsForUris([uri]),
      ),
    );
  }

  private relPathFor(absPath: string): string {
    return toPosixPath(relative(this.rootDir, absPath));
  }

  /**
   * `workspace/symbol` returns an empty list until tsserver finishes building
   * its project-wide symbol index, which happens lazily a few hundred ms after
   * the project loads (PRD Risk #2: cold-start incompleteness). Poll briefly on
   * an empty result so the first cross-file query is not silently empty; a query
   * that is genuinely empty just pays the bounded wait once.
   */
  private async workspaceSymbolWithIndexWait(
    query: string,
    timeoutMs = 3_000,
  ): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
    const started = Date.now();
    let symbols = await this.client.workspaceSymbol(query);
    while (symbols.length === 0 && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      symbols = await this.client.workspaceSymbol(query);
    }
    return symbols;
  }

  private async documentSymbols(
    resolved: ResolvedWorkspacePath,
  ): Promise<DocumentSymbol[]> {
    const symbols = await this.client.documentSymbol(resolved.absPath);
    if (isDocumentSymbolArray(symbols)) return symbols;
    throw new Error(
      `Language server returned a flat symbol list for "${resolved.relPath}". Hierarchical document symbols are required for symbol path resolution.`,
    );
  }

  private workspacePathFromUri(uri: string): ResolvedWorkspacePath | undefined {
    let absPath: string;
    try {
      absPath = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const rel = relative(this.rootDir, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return { absPath, relPath: toPosixPath(rel), uri };
  }

  private throwIfAmbiguousBareName(
    query: string,
    symbols: WorkspaceSymbolInfo[],
  ): void {
    const trimmed = query.trim();
    if (!isBareSymbolQuery(trimmed)) return;
    const exactMatches = symbols.filter((symbol) => symbol.name === trimmed);
    if (exactMatches.length <= 1) return;
    const candidates = exactMatches
      .map((symbol) => `- ${formatWorkspaceSymbolCandidate(symbol)}`)
      .join("\n");
    throw new Error(
      [
        `Symbol "${trimmed}" is ambiguous across the workspace. Candidates:`,
        candidates,
        "Use the candidate file with getSymbols(file), then pass the exact " +
          "SymbolInfo.path to resolver-backed APIs such as " +
          "getSymbolBody(file, symbolPath).",
      ].join("\n"),
    );
  }

  private async containingPathForLocation(
    workspacePath: ResolvedWorkspacePath,
    location: LspLocation,
  ): Promise<string | undefined> {
    try {
      const symbols = await this.documentSymbols(workspacePath);
      // Nearest enclosing FUNCTION, not nearest binding — a reference inside
      // `const result = await foo(...)` belongs to the containing function,
      // not to `result` (field report).
      return containingFunctionPath(symbols, location.range.start);
    } catch {
      return undefined;
    }
  }

  private async locationToApiLocation(
    location: LspLocation,
  ): Promise<Location> {
    const workspacePath = this.workspacePathFromUri(location.uri);
    if (!workspacePath) {
      throw new Error(
        `Definition resolved outside the workspace: ${location.uri}`,
      );
    }
    const symbols = await this.documentSymbols(workspacePath);
    return {
      file: workspacePath.relPath,
      line: location.range.start.line + 1,
      column: location.range.start.character + 1,
      symbolPath: symbolPathForRange(symbols, location.range),
    };
  }

  private convertDiagnosticsForUri(
    uri: string,
    diagnostics: LspDiagnostic[],
  ): Diagnostic[] {
    const workspacePath = this.workspacePathFromUri(uri);
    if (!workspacePath) return [];
    // A file created this script exists only in the buffer, so tsserver checks
    // it in the INFERRED project where tsconfig "paths" aliases don't resolve.
    // Module-not-found errors there are usually false positives (field report:
    // a correct module split was rolled back over 6 of them) — say so in-band
    // so the script can classify instead of blindly aborting.
    const pendingCreation = this.buffer?.isPendingCreation(
      workspacePath.absPath,
    );
    return diagnostics.map((diagnostic) => {
      let message =
        typeof diagnostic.message === "string"
          ? diagnostic.message
          : diagnostic.message.value;
      let likelyFalsePositive = false;
      if (pendingCreation && /Cannot find module/i.test(message)) {
        likelyFalsePositive = true;
        message +=
          " [likely a FALSE POSITIVE: this file is newly created and not yet " +
          "on disk, so tsconfig path aliases do not resolve in it until the " +
          "script succeeds and it is flushed. If an existing file imports the " +
          "same module without errors, ignore this; verify with " +
          "getDiagnostics in a follow-up call after the flush.]";
      }
      const converted: Diagnostic = {
        file: workspacePath.relPath,
        range: diagnostic.range,
        message,
        severity: severityName(diagnostic.severity),
      };
      if (likelyFalsePositive) converted.likelyFalsePositive = true;
      return converted;
    });
  }

  private lineLooksExported(text: string, zeroBasedLine: number): boolean {
    return /^\s*export\b/.test(lineContext(text, zeroBasedLine));
  }
}
