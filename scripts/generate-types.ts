/**
 * Type-def generation build step (PRD § Tool Description, Build Plan phase 5).
 *
 * Emits declarations for src/lsp-api.ts via the TypeScript compiler
 * (`tsc --declaration --emitDeclarationOnly`, in memory), extracts the
 * LLM-facing interfaces and the LspApi op signatures, and writes them as string
 * constants to src/lsp-types.generated.ts. The tool description embeds them via
 * its {{types}} placeholder, so src/lsp-api.ts stays the single source of truth.
 *
 * Read and write ops are kept in separate constants so CODEMODE_READONLY can
 * strip the write surface from the generated types (deferred from Phase 4).
 *
 * Run with: bun run generate:types
 * Freshness is enforced by test/unit/generated-types.test.ts.
 */
import { writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { READ_OP_NAMES, WRITE_OP_NAMES } from "../src/sandbox";

const projectRoot = join(import.meta.dir, "..");
const entryPath = join(projectRoot, "src", "lsp-api.ts");

/** Where the generated module lives (exported for the freshness test). */
export const generatedPath = join(projectRoot, "src", "lsp-types.generated.ts");

/** Interfaces shown in both modes. SymbolInfo is declared in src/symbol.ts. */
const COMMON_INTERFACE_NAMES = [
  "SymbolInfo",
  "WorkspaceSymbolInfo",
  "Reference",
  "CallInfo",
  "CallSite",
  "SymbolDependencies",
  "ImportDependency",
  "Location",
  "SearchResult",
  "Diagnostic",
  "ProjectCheckResult",
] as const;

/** Interfaces only reachable from write ops — stripped under CODEMODE_READONLY. */
const WRITE_INTERFACE_NAMES = ["WriteResult", "MoveSymbolResult"] as const;

/**
 * Position/Range come from vscode-languageserver-protocol in the source, so the
 * emitted d.ts references them by name only. Re-declared here (they are stable
 * LSP primitives) so Diagnostic.range is self-contained in the tool description.
 */
const POSITION_RANGE_SNIPPET = [
  "interface Position {",
  "  /** Zero-based. */",
  "  line: number;",
  "  character: number;",
  "}",
  "",
  "interface Range {",
  "  start: Position;",
  "  end: Position;",
  "}",
].join("\n");

/** Compile the lsp-api module graph and capture every emitted .d.ts in memory. */
function emitDeclarations(): Map<string, string> {
  const configPath = join(projectRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectRoot,
  );
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const host = ts.createCompilerHost(options);
  const outputs = new Map<string, string>();
  host.writeFile = (fileName, text) => {
    outputs.set(fileName, text);
  };
  const program = ts.createProgram([entryPath], options, host);
  const emitResult = program.emit();
  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(
      `Declaration emit failed:\n${ts.formatDiagnostics(errors, host)}`,
    );
  }
  return outputs;
}

function requireOutput(outputs: Map<string, string>, fileName: string): string {
  const suffix = `${sep}src${sep}${fileName}`;
  for (const [key, text] of outputs) {
    if (key.endsWith(suffix) || key.endsWith(`/src/${fileName}`)) return text;
  }
  throw new Error(
    `Declaration output "${fileName}" not found. Emitted: ${[...outputs.keys()].join(", ")}`,
  );
}

function parseDts(text: string): ts.SourceFile {
  return ts.createSourceFile("types.d.ts", text, ts.ScriptTarget.Latest, true);
}

/** d.ts emit indents with 4 spaces; halve it to match the rest of the description. */
function reindent(text: string): string {
  return text.replace(/^(?: {4})+/gm, (match) => " ".repeat(match.length / 2));
}

function extractInterfaces(
  sourceFile: ts.SourceFile,
  names: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  sourceFile.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && names.includes(node.name.text)) {
      const text = node.getText(sourceFile).replace(/^export\s+/, "");
      found.set(node.name.text, reindent(text));
    }
  });
  return found;
}

interface MethodSig {
  doc?: string;
  signature: string;
}

/** Extract the named LspApi method signatures (+ first JSDoc line) from the d.ts. */
function extractMethods(
  sourceFile: ts.SourceFile,
  names: readonly string[],
): Map<string, MethodSig> {
  const found = new Map<string, MethodSig>();
  sourceFile.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== "LspApi") return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const name =
        member.name && ts.isIdentifier(member.name)
          ? member.name.text
          : undefined;
      if (!name || !names.includes(name)) continue;
      const jsDocs = (member as { jsDoc?: ts.JSDoc[] }).jsDoc;
      const comment = jsDocs?.[0]
        ? ts.getTextOfJSDocComment(jsDocs[0].comment)
        : undefined;
      found.set(name, {
        doc: comment?.split("\n")[0]?.trim() || undefined,
        signature: member.getText(sourceFile),
      });
    }
  });
  return found;
}

/** Render op signatures as two-space-indented members of the `lsp` object type. */
function renderOps(
  methods: Map<string, MethodSig>,
  names: readonly string[],
): string {
  const lines: string[] = [];
  for (const name of names) {
    const method = methods.get(name);
    if (!method) {
      throw new Error(
        `Method "${name}" not found in the LspApi declaration output.`,
      );
    }
    if (method.doc) lines.push(`  /** ${method.doc} */`);
    lines.push(`  ${method.signature}`);
  }
  return lines.join("\n");
}

/** Build the full source text of src/lsp-types.generated.ts. */
export function generateTypesModuleSource(): string {
  const outputs = emitDeclarations();
  const lspApiDts = parseDts(requireOutput(outputs, "lsp-api.d.ts"));
  const symbolDts = parseDts(requireOutput(outputs, "symbol.d.ts"));
  const dependenciesDts = parseDts(requireOutput(outputs, "dependencies.d.ts"));
  const projectCheckDts = parseDts(
    requireOutput(outputs, "project-check.d.ts"),
  );

  const interfaces = new Map([
    ...extractInterfaces(symbolDts, ["SymbolInfo"]),
    ...extractInterfaces(dependenciesDts, [
      "SymbolDependencies",
      "ImportDependency",
    ]),
    ...extractInterfaces(projectCheckDts, ["ProjectCheckResult"]),
    ...extractInterfaces(lspApiDts, [
      ...COMMON_INTERFACE_NAMES,
      ...WRITE_INTERFACE_NAMES,
    ]),
  ]);
  const pick = (name: string): string => {
    const text = interfaces.get(name);
    if (!text) {
      throw new Error(`Interface "${name}" not found in declaration output.`);
    }
    return text;
  };

  const common = [
    ...COMMON_INTERFACE_NAMES.map(pick),
    POSITION_RANGE_SNIPPET,
  ].join("\n\n");
  const write = WRITE_INTERFACE_NAMES.map(pick).join("\n\n");

  const methods = extractMethods(lspApiDts, [
    ...READ_OP_NAMES,
    ...WRITE_OP_NAMES,
  ]);
  const readOps = renderOps(methods, READ_OP_NAMES);
  const writeOps = renderOps(methods, WRITE_OP_NAMES);

  return [
    "// Generated by scripts/generate-types.ts from src/lsp-api.ts — DO NOT EDIT.",
    "// Regenerate with: bun run generate:types",
    "",
    "/** Interfaces shared by read + write ops (kept under CODEMODE_READONLY). */",
    `export const LSP_COMMON_INTERFACES = ${JSON.stringify(common)};`,
    "",
    "/** Interfaces only reachable from write ops; stripped under CODEMODE_READONLY. */",
    `export const LSP_WRITE_INTERFACES = ${JSON.stringify(write)};`,
    "",
    "/** Read-op members of the sandbox `lsp` object. */",
    `export const LSP_READ_OP_SIGNATURES = ${JSON.stringify(readOps)};`,
    "",
    "/** Write-op members; stripped under CODEMODE_READONLY. */",
    `export const LSP_WRITE_OP_SIGNATURES = ${JSON.stringify(writeOps)};`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  writeFileSync(generatedPath, generateTypesModuleSource());
  console.log(`wrote ${generatedPath}`);
}
