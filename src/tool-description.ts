/**
 * The `execute` tool description — the LLM's documentation (PRD § Tool
 * Description). Structure: one-line purpose, generated type defs ({{types}}),
 * write semantics, worked examples, warnings. Type defs come from
 * src/lsp-types.generated.ts (regenerate with `bun run generate:types`);
 * src/lsp-api.ts is the single source of truth.
 *
 * Each worked example doubles as a golden script: it runs against the fixture
 * project in test/integration/golden-scripts.test.ts so the documentation can
 * never silently rot.
 */
import {
  LSP_COMMON_INTERFACES,
  LSP_READ_OP_SIGNATURES,
  LSP_WRITE_INTERFACES,
  LSP_WRITE_OP_SIGNATURES,
} from "./lsp-types.generated";
import { READ_OP_NAMES, WRITE_OP_NAMES } from "./sandbox";

export interface WorkedExample {
  title: string;
  code: string;
  /** Examples that use write ops are omitted under CODEMODE_READONLY. */
  writes: boolean;
}

export const WORKED_EXAMPLES: WorkedExample[] = [
  {
    title: "Explore a project",
    writes: false,
    code: `const files = await lsp.listFiles("src/**/*.ts");
const outline = [];
for (const file of files) {
  const symbols = await lsp.getSymbols(file);
  outline.push({ file, symbols: symbols.map((s) => s.kind + " " + s.path) });
}
outline;`,
  },
  {
    title: "Trace the call graph",
    writes: false,
    code: `// Who calls findUser, and what does findUser call?
const callers = await lsp.incomingCalls("src/users.ts", "findUser");
const callees = await lsp.outgoingCalls("src/users.ts", "findUser");
({
  calledBy: callers.map((c) => c.file + "::" + c.symbolPath),
  calls: callees.map((c) => c.file + "::" + c.symbolPath),
});`,
  },
  {
    title: "Move a symbol and verify the project",
    writes: true,
    code: `// Move a top-level symbol to another module — the target's imports are
// computed, every importer is repointed, and the source's imports pruned.
const moved = await lsp.moveSymbol("src/auth.ts", "createAuthMiddleware", "src/middleware.ts");
// Verify the WHOLE project over the buffered state — unlike per-file
// getDiagnostics, path aliases resolve here even in files created this script.
const check = await lsp.checkProject();
({ filesChanged: moved.filesChanged, projectErrors: check.errorCount });`,
  },
  {
    title: "Batch refactor: migrate every caller",
    writes: true,
    code: `// Switch every function that calls AuthService.validate to validateToken.
const refs = await lsp.findReferences("src/auth.ts", "AuthService/validate");
const callers = [...new Set(
  refs
    .filter((r) => r.symbolPath && !r.symbolPath.startsWith("AuthService"))
    .map((r) => r.file + "::" + r.symbolPath),
)];
for (const caller of callers) {
  const [file, symbolPath] = caller.split("::");
  const body = await lsp.getSymbolBody(file, symbolPath);
  await lsp.replaceSymbolBody(file, symbolPath,
    body.replace(".validate(", ".validateToken("));
}
({ updatedFunctions: callers.length });`,
  },
  {
    title: "Write, then check diagnostics",
    writes: true,
    code: `const result = await lsp.replaceSymbolBody("src/auth.ts", "AuthService/logout",
  \`logout(token: Token): void {
    this.sessions.delete(token);
    this.sessions.delete(token + "-r");
  }\`);
const errors = result.diagnostics.filter((d) => d.severity === "error");
({ ok: errors.length === 0, errors: errors.map((d) => d.file + ": " + d.message) });`,
  },
];

/**
 * Render the {{types}} block: a typed `lsp` object, then the supporting
 * interfaces. The signatures come FIRST deliberately: MCP clients may truncate
 * long tool descriptions, and a field report showed an agent that received the
 * interfaces but lost the op signatures — the single most load-bearing part.
 * Under CODEMODE_READONLY the write signatures and WriteResult are absent —
 * the LLM never sees them, so it never tries them.
 */
export function renderLspTypes(readonly: boolean): string {
  const interfaces = readonly
    ? LSP_COMMON_INTERFACES
    : `${LSP_COMMON_INTERFACES}\n\n${LSP_WRITE_INTERFACES}`;
  const helpOp =
    "  /** This full API reference as a string — call it if this description was truncated. */\n  help(): Promise<string>;";
  const ops = readonly
    ? `${LSP_READ_OP_SIGNATURES}\n\n${helpOp}`
    : `${LSP_READ_OP_SIGNATURES}\n\n  // Write operations — buffered, applied atomically when the script succeeds.\n${LSP_WRITE_OP_SIGNATURES}\n\n${helpOp}`;
  return `declare const lsp: {\n${ops}\n};\n\n${interfaces}`;
}

const TEMPLATE = `Semantic code intelligence and refactoring for TypeScript/JavaScript (LSP-backed).
Best for codebase-WIDE questions and edits: impact analysis ("what breaks if I
change X"), call graphs, usage audits, and atomic multi-file refactors — it
RESOLVES names where grep only matches text, in one call instead of many
search/read round trips. For a single-file peek, plain file reads are cheaper.
If this description looks truncated, run the script \`await lsp.help()\` — it
returns this complete reference. Ops — {{opInventory}}.

Write one script that chains lsp.* calls — filter, loop, and branch in code
instead of across many tool calls. The sandbox provides \`lsp\`,
\`console.log/warn/error\` (captured into \`logs\`), and
\`path.join/basename/dirname/extname\`; nothing else (no fetch, fs, require,
setTimeout). The tool returns { result, logs, changes }, where \`result\` is the
script's last expression, JSON-serialized.

## Rules

- The last TOP-LEVEL expression is the return value — end the script with a
  bare expression, e.g. \`({ count })\`. An expression inside a trailing
  if/for/try block is NOT captured; use a top-level \`return\` from inside
  blocks.
- Every \`lsp.*\` call returns a Promise — always \`await\` it. An un-awaited
  call inside the result serializes as \`{}\`.
- \`.filter()\`/\`.map()\` callbacks cannot be async — use \`for...of\` with \`await\`.
- \`searchText\`/\`listFiles\` cover the whole workspace (minus .gitignore);
  scope with a glob, which matches the full workspace-relative path:
  \`listFiles("src/**")\` for a directory (a bare name like \`"src"\` is treated
  as \`src/**\`), \`listFiles()\` for every file. \`searchText\`'s second argument
  is a glob string — there is no options object; filter results in your script.
- Symbol paths are slash-separated (\`MyClass/myMethod\`); discover exact paths
  with \`getSymbols(file)\` rather than guessing. Symbol ops always take the
  pair \`(file, symbolPath)\` — a \`SymbolInfo.path\` belongs to the file you
  called \`getSymbols\` on, and round-trips into findReferences/goToDefinition/
  the write ops.
- \`searchText\` patterns are regexes — escape metacharacters for literal text:
  \`searchText("new NotFoundError\\\\(")\`.
- To trace calls, use \`incomingCalls\`/\`outgoingCalls\` — they return only TRUE
  calls, attributed to the enclosing function. \`findReferences\` mixes calls
  with imports, re-exports, and type references.
- Moving code? \`moveSymbol(file, symbolPath, targetFile)\` moves a TOP-LEVEL
  symbol end to end: target imports computed, importers repointed, source
  imports pruned — don't hand-splice what it can do in one call. For custom
  splits, \`getDependencies(file, symbolPath)\` computes what a symbol's body
  needs from outside itself (required imports + same-file helpers), and
  \`organizeImports\`/\`addMissingImports\` clean up import blocks natively.
- \`goToDefinition\` only addresses symbols DEFINED in the given file — it cannot
  follow an imported or called name into another module. To resolve a name to
  its definition anywhere in the workspace, use \`findSymbol(name)\` and filter
  for an exact \`name\` match (it also returns substring matches), or
  \`outgoingCalls\` on the containing function.
- \`result\` is capped at 50,000 chars (logs at 10,000). Aggregate INSIDE the
  script — return counts, top-N lists, and compact summaries, never a raw
  inventory of files/symbols/references. \`getSymbols(file, 1)\` returns just
  the top-level outline when you don't need every nested property.
- File paths are relative to the workspace root; anything outside it is
  rejected.
- Diagnostics cover files touched this session only, never the whole project.
  \`Diagnostic.range\` is zero-based; every other line/column is 1-based.
- On a file CREATED this script, per-file getDiagnostics reports "Cannot find
  module" for tsconfig path aliases (\`@/...\`) spuriously — the file joins the
  TS project only once flushed to disk. Such diagnostics carry
  \`likelyFalsePositive: true\`; exclude them from any abort gate:
  \`d.severity === "error" && !d.likelyFalsePositive\`. Better: use
  \`checkProject()\` as the verify gate for multi-file refactors — it
  type-checks the whole buffered project with full alias resolution, created
  files included, so it has no such false positives.

## API

{{types}}

{{writeSemantics}}

## Examples

{{examples}}`;

const WRITE_SEMANTICS = `Write operations available: writes are buffered during the script and applied
atomically (flushed to disk) only when the whole script succeeds; if it throws,
every buffered write is rolled back and the codebase is unchanged. The tool
result's \`changes\` lists each flushed file as { file, kind, diff } with a
reviewable unified diff. Each write op returns fresh diagnostics for the files
it touched — check them and self-correct within the same script.`;

const READONLY_SEMANTICS =
  "This server is running in read-only mode (CODEMODE_READONLY): write operations are not available.";

export function buildToolDescription(readonly: boolean): string {
  const examples = WORKED_EXAMPLES.filter(
    (example) => !readonly || !example.writes,
  )
    .map(
      (example) =>
        `### ${example.title}\n\`\`\`javascript\n${example.code}\n\`\`\``,
    )
    .join("\n\n");
  // The inventory sits in the first lines so even a brutally truncated
  // description still names every operation (signatures follow under ## API).
  const opInventory = readonly
    ? `read: ${READ_OP_NAMES.join(", ")}`
    : `read: ${READ_OP_NAMES.join(", ")}; write: ${WRITE_OP_NAMES.join(", ")}`;
  return TEMPLATE.replace("{{opInventory}}", opInventory)
    .replace("{{types}}", renderLspTypes(readonly))
    .replace(
      "{{writeSemantics}}",
      readonly ? READONLY_SEMANTICS : WRITE_SEMANTICS,
    )
    .replace("{{examples}}", examples);
}
