import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DocumentSymbol,
  Diagnostic as LspDiagnostic,
  Location as LspLocation,
  Range,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
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
  line: number;
  column: number;
  context: string;
  symbolPath: string;
  isWriteAccess: boolean;
}

export interface Location {
  file: string;
  line: number;
  column: number;
  symbolPath?: string;
}

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  match: string;
  context: string;
}

export interface Diagnostic {
  file: string;
  range: Range;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
}

export interface WorkspaceSymbolInfo extends SymbolInfo {
  file: string;
}

export interface WriteResult {
  file: string;
  filesChanged: string[];
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

  constructor(options: { rootDir: string; client: LspClient }) {
    this.rootDir = resolve(options.rootDir);
    this.rootRealPath = realpathSync(this.rootDir);
    this.client = options.client;
    this.ignoreRules = loadIgnoreRules(this.rootDir);
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

  async readFile(file: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(file);
    return readFileSync(resolved.absPath, "utf8");
  }

  async getSymbolBody(file: string, symbolPath: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(file);
    const text = readFileSync(resolved.absPath, "utf8");
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

  async getSymbols(file: string): Promise<SymbolInfo[]> {
    const resolved = this.resolveWorkspacePath(file);
    const text = readFileSync(resolved.absPath, "utf8");
    return buildSymbolInfoTree(await this.documentSymbols(resolved), text);
  }

  async findSymbol(query: string): Promise<WorkspaceSymbolInfo[]> {
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

  async findReferences(file: string, symbolPath: string): Promise<Reference[]> {
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
      const text = readFileSync(workspacePath.absPath, "utf8");
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

  async goToDefinition(file: string, symbolPath: string): Promise<Location> {
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

  async searchText(pattern: string, glob?: string): Promise<SearchResult[]> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "g");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid searchText regex "${pattern}": ${message}`);
    }
    const results: SearchResult[] = [];
    for (const file of await this.listFiles(glob)) {
      const resolved = this.resolveWorkspacePath(file);
      const lines = readFileSync(resolved.absPath, "utf8").split(/\r?\n/);
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

  async listFiles(glob?: string): Promise<string[]> {
    const matcher = globToRegExp(glob ?? "**/*");
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

  async getDiagnostics(file?: string): Promise<Diagnostic[]> {
    if (file) {
      const resolved = this.resolveWorkspacePath(file);
      await this.client.ensureAlive();
      this.client.openTextDocument(resolved.absPath);
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
