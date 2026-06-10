import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
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
import type { LspClient } from "./lsp-client";
import {
  buildSymbolInfoTree,
  containingSymbolPath,
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
  /** Path of the symbol containing the reference (a reusable handle); "" at top level. */
  symbolPath: string;
  /** Always false in v1 — the language server does not classify accesses. */
  isWriteAccess: boolean;
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
}

export interface WorkspaceSymbolInfo extends SymbolInfo {
  file: string;
}

export interface WriteResult {
  file: string;
  /** All files affected — rename can fan out to many. */
  filesChanged: string[];
  /** Fresh diagnostics for the affected files; check for "error" severity. */
  diagnostics: Diagnostic[];
}

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

  /** Document symbol tree (file outline). Every path is a usable handle. */
  async getSymbols(file: string): Promise<SymbolInfo[]> {
    this.requireStrings(
      "getSymbols(file)",
      'await lsp.getSymbols("src/auth.ts")',
      { file },
    );
    const resolved = this.resolveWorkspacePath(file);
    await this.ensureReadyForBuffer();
    const text = this.readText(resolved);
    return buildSymbolInfoTree(await this.documentSymbols(resolved), text);
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
      return containingSymbolPath(symbols, location.range.start);
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
    return diagnostics.map((diagnostic) => ({
      file: workspacePath.relPath,
      range: diagnostic.range,
      message:
        typeof diagnostic.message === "string"
          ? diagnostic.message
          : diagnostic.message.value,
      severity: severityName(diagnostic.severity),
    }));
  }

  private lineLooksExported(text: string, zeroBasedLine: number): boolean {
    return /^\s*export\b/.test(lineContext(text, zeroBasedLine));
  }
}
