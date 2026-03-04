# codemode-lsp PRD

MCP server that exposes a single code-mode tool backed by LSP. The LLM writes JavaScript that chains semantic code operations, which run in a vm sandbox and return results.

## Why

Traditional MCP servers like Serena expose many individual tools (Serena has ~49). Even a reduced set of 8 tools means the LLM has to:

1. Call `find_references` → get hundreds of results dumped into context
2. Reason about filtering in natural language, or write temp files
3. Call the next tool, one reference at a time
4. Many round-trips, tons of tokens wasted, lots of noise

With a code-mode approach (inspired by [Cloudflare's codemode](https://github.com/cloudflare/agents)), the LLM instead writes a single script:

```javascript
const refs = await lsp.findReferences("src/api.ts", "handleRequest");
const relevant = refs.filter((r) => r.context.includes("deprecated"));
const newImpl = "function handleRequest(req) { return newHandler(req); }";
for (const ref of relevant) {
  await lsp.replaceSymbolBody(ref.file, ref.symbolPath, newImpl);
}
({ modified: relevant.length });
```

One round-trip. The filtering, looping, and chaining happen in code, not in LLM reasoning. LLMs are better at writing code than orchestrating dozens of tool calls — they've seen millions of lines of real code but only contrived tool-calling examples.

## Architecture

### Runtime & Transport

- **Runtime**: Bun + TypeScript
- **MCP**: `@modelcontextprotocol/sdk`, stdio transport
- **LSP**: Direct JSON-RPC client over stdio. Spawn language servers as child processes.
- **Sandbox**: Bun/Node `vm` module for executing LLM-generated code. Not a security boundary — safety comes from exposing a narrow API surface, not from process isolation.

### One Tool

The MCP server exposes a **single tool**: `execute`. It accepts JavaScript code as a string, runs it in a vm sandbox where LSP primitives are available as async APIs, and returns the result.

The LLM receives TypeScript type definitions in the tool description for API shape guidance, but scripts themselves are plain JavaScript (no transpile step needed).

### LSP Primitives (internal APIs)

These are **not** MCP tools. They are typed functions available inside the sandbox via the `lsp` object.

**Read operations:**

- `lsp.readFile(file)` — read file contents as string
- `lsp.getSymbolBody(file, symbolPath)` — read source code of a specific symbol
- `lsp.findSymbol(query)` — workspace symbol search
- `lsp.findReferences(file, symbolPath)` — all references to a symbol
- `lsp.getSymbols(file)` — document symbols (file outline / symbol tree)
- `lsp.goToDefinition(file, symbolPath)` — jump to definition

**Write operations:**

- `lsp.renameSymbol(file, symbolPath, newName)` — LSP rename across codebase
- `lsp.replaceSymbolBody(file, symbolPath, newText)` — replace a symbol's full declaration
- `lsp.insertBeforeSymbol(file, symbolPath, text)` — insert code before a symbol
- `lsp.insertAfterSymbol(file, symbolPath, text)` — insert code after a symbol

All return structured objects. Write operations buffer in memory and notify the LSP via `didChange`; flushed to disk only when the script completes successfully (see Transactional Writes).

### Workspace

- Workspace root = server's cwd. No walking up, no auto-detection.
- Client controls root by spawning the server from the desired directory.
- Single root only. No multi-root workspace support.
- No config file in v1. Add one when there are multiple things to configure.

### Language Servers (v1)

- **TypeScript only**: `typescript-language-server`
- No Python/pyright in v1. Nothing in the architecture is TypeScript-specific — LSP protocol is language-agnostic, sandbox APIs (`lsp.findReferences`, etc.) don't know what server is behind them. Adding another language later = map file extensions → spawn the right server. `lsp-manager.ts` already abstracts this.

### Concurrency

- Reads are safe to parallelize (no LSP state mutation).
- Writes are naturally sequential — LLM scripts `await` each write. No mutex needed.

### Document Sync

- `textDocument/didOpen` on first access to a file.
- `textDocument/didChange` during script execution for buffered edits (LSP sees changes before disk flush). See Transactional Writes for details.
- No `didChangeWatchedFiles` or `didClose` idle timeout in v1. Language servers manage their own memory fine.

### LSP Crash Recovery

- LSP dies mid-script → script fails, buffered edits roll back automatically.
- Next `execute` call detects dead server → respawns + init handshake → `didOpen` happens naturally as the new script touches files.
- No replay of previously-open documents, no mid-script recovery. Keep it simple.

### Edit Application (Transactional Writes)

Write operations buffer in memory during script execution — nothing hits disk until the script completes successfully.

1. Script calls a write operation → update in-memory buffer, send `textDocument/didChange` to LSP so it sees the edit. No disk write yet.
2. Subsequent reads within the same script see the updated state (LSP is aware of the buffered changes).
3. Script completes successfully → flush all dirty buffers to disk.
4. Script throws → discard dirty buffers, restore LSP state to originals (`didChange` back or `didClose`+`didOpen`). Disk untouched.

This gives automatic rollback on failure with zero overhead on success. The LLM gets the error, rewrites the script, retries on a clean codebase.

### Sandbox

The vm sandbox exposes a minimal, controlled API surface:

**Available:**

- `lsp.*` — all LSP primitives listed above
- JS builtins — Math, JSON, Array, Object, Map, Set, Promise, String, Number, Date, RegExp, etc.
- `console.log/warn/error` — captured to a logs array, returned alongside the script result (not printed to stdout)

**Not available:**

- No `fetch` or network access
- No `fs` / `require` / `import` — file reading goes through `lsp.readFile()`
- No `setTimeout` / `setInterval` — LSP timing is handled internally
- No `process`, `Bun`, `Deno`, or other runtime globals

### Tool Description & Type Definitions

The `execute` tool description includes auto-generated TypeScript type definitions for the entire `lsp.*` API surface. This gives the LLM IDE-like guidance when writing scripts.

Type defs are generated from the actual API implementation (single source of truth). Build step runs `tsc --declaration --emitDeclarationOnly` on `lsp-api.ts`, reads the `.d.ts` output, and embeds it in the tool description via a `{{types}}` placeholder.

Example of what the LLM sees in the tool description:

```typescript
interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  file: string;
  range: Range;
}
interface Reference {
  file: string;
  range: Range;
  context: string;
  symbolPath: string;
}
// ...

declare const lsp: {
  /** Read file contents */
  readFile(file: string): Promise<string>;
  /** Read source code of a specific symbol */
  getSymbolBody(file: string, symbolPath: string): Promise<string>;
  /** Workspace symbol search */
  findSymbol(query: string): Promise<SymbolInfo[]>;
  // ...
};
```

The LLM writes a script body (no function wrapper needed), and the last expression is the return value:

```javascript
const refs = await lsp.findReferences("src/api.ts", "handleRequest");
const deprecated = refs.filter((r) => r.context.includes("deprecated"));
deprecated.map((r) => ({ file: r.file, line: r.range.start.line }));
```

## Symbol Path Resolution

Slash-separated, unlimited nesting depth. Walks the document symbol tree.

```
"MyClass"                      → top-level class
"MyClass/constructor"          → class constructor
"MyClass/myMethod"             → class method
"OuterClass/InnerClass/method" → deeply nested
"myFunction"                   → top-level function
"config"                       → variable (arrow fns use their variable name)
"router/get"                   → object literal property
```

Ambiguity: if a bare name matches multiple symbols, return candidates for the script to disambiguate.

## Result Format

The `execute` tool returns:

- **result**: whatever the script's last expression evaluates to. Any serializable value — objects, arrays, strings.
- **logs**: array of captured `console.log/warn/error` calls from the script.

LSP primitives return structured objects by default (symbol names, kinds, locations with file paths and ranges, context lines). Scripts can transform these however they like before returning.

## Modules

- `mcp-server.ts` — MCP server setup, single `execute` tool registration, stdio transport
- `lsp-client.ts` — spawn language server, JSON-RPC with Content-Length framing, init handshake, crash recovery
- `lsp-manager.ts` — manage multiple language servers (one per language), auto-detect from file extensions, idle timeout
- `sandbox.ts` — vm sandbox setup, inject LSP primitives as typed APIs, execute LLM-generated code
- `lsp-api.ts` — the internal API surface exposed inside the sandbox (wraps LSP calls into clean async functions)
- `symbol.ts` — symbol path resolution (slash-separated path → LSP positions via document symbols)

## Open Questions

_To be filled as interview continues._
