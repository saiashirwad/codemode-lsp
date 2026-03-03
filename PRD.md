# codemode-lsp PRD

MCP server that exposes a single code-mode tool backed by LSP. The LLM writes TypeScript that chains semantic code operations, which run in a vm sandbox and return results.

## Why

Traditional MCP servers like Serena expose many individual tools (Serena has ~49). Even a reduced set of 8 tools means the LLM has to:

1. Call `find_references` → get hundreds of results dumped into context
2. Reason about filtering in natural language, or write temp files
3. Call the next tool, one reference at a time
4. Many round-trips, tons of tokens wasted, lots of noise

With a code-mode approach (inspired by [Cloudflare's codemode](https://github.com/cloudflare/agents)), the LLM instead writes a single script:

```typescript
async () => {
  const refs = await lsp.findReferences("src/api.ts", "handleRequest");
  const relevant = refs.filter(r => r.context.includes("deprecated"));
  for (const ref of relevant) {
    await lsp.replaceSymbolBody(ref.file, ref.symbolPath, newImplementation);
  }
  return { modified: relevant.length };
}
```

One round-trip. The filtering, looping, and chaining happen in code, not in LLM reasoning. LLMs are better at writing TypeScript than orchestrating dozens of tool calls — they've seen millions of lines of real code but only contrived tool-calling examples.

## Architecture

### Runtime & Transport

- **Runtime**: Bun + TypeScript
- **MCP**: `@modelcontextprotocol/sdk`, stdio transport
- **LSP**: Direct JSON-RPC client over stdio. Spawn language servers as child processes.
- **Sandbox**: Bun/Node `vm` module for executing LLM-generated code. Not a security boundary — safety comes from exposing a narrow API surface, not from process isolation.

### One Tool

The MCP server exposes a **single tool**: `execute`. It accepts TypeScript code as a string, runs it in a vm sandbox where LSP primitives are available as typed async APIs, and returns the result.

The LLM receives auto-generated type definitions for all available APIs so it can write correct code with IDE-like guidance.

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

All return structured objects. Write operations write directly to disk and notify the LSP.

### Workspace

- Auto-detect workspace root from server's cwd — walk up to find `.git`, `package.json`, etc.
- No explicit init step required from client.

### Language Servers (v1)

- **TypeScript**: `typescript-language-server`
- **Python**: `pyright`
- Auto-detect language from file extensions. One server instance per language.

### Concurrency

- **Read operations**: concurrent, safe to parallelize within a script.
- **Write operations**: serialized via mutex. Second write waits.

### Document Sync

- `textDocument/didOpen` on first access to a file.
- `textDocument/didChange` after edits so LSP index stays current.
- `workspace/didChangeWatchedFiles` for external filesystem changes.
- `textDocument/didClose` on idle timeout to prevent memory bloat.

### LSP Crash Recovery

- Auto-restart crashed/unresponsive language server transparently.
- Replay `didOpen` for all previously-open documents to restore state.
- Failed call returns error to the script; recovery is automatic for subsequent calls.

### Edit Application

- Server writes edits directly to disk (not diffs for client to apply).

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

Type defs are generated from the actual API implementation (single source of truth) and embedded in the tool description via a `{{types}}` placeholder, similar to Cloudflare's approach.

Example of what the LLM sees in the tool description:
```typescript
interface SymbolInfo { name: string; kind: SymbolKind; file: string; range: Range; }
interface Reference { file: string; range: Range; context: string; symbolPath: string; }
// ...

declare const lsp: {
  /** Read file contents */
  readFile(file: string): Promise<string>;
  /** Read source code of a specific symbol */
  getSymbolBody(file: string, symbolPath: string): Promise<string>;
  /** Workspace symbol search */
  findSymbol(query: string): Promise<SymbolInfo[]>;
  // ...
}
```

The LLM writes a script body (no function wrapper needed), and the last expression is the return value:
```typescript
const refs = await lsp.findReferences("src/api.ts", "handleRequest");
const deprecated = refs.filter(r => r.context.includes("deprecated"));
deprecated.map(r => ({ file: r.file, line: r.range.start.line }));
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
