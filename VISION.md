# codemode-lsp Vision

Final vision document synthesized from four expert analyses: LSP protocol constraints, LLM behavior patterns, systems architecture, and product/competitive critique.

## Core Thesis

**An MCP server exposing a single `execute` tool backed by LSP. The LLM writes JavaScript that chains semantic code operations, executed in a vm sandbox with transactional semantics.**

The insight: LLMs are better at writing code than orchestrating tool calls. With discrete tools, the LLM must reason about filtering, looping, and branching in natural language across many round-trips. With code execution, it writes a script that does all of this in one shot — using the same imperative patterns it's seen millions of times in training data.

### What this is NOT

- **Not a Serena competitor.** Serena is a multi-tool MCP server for broad IDE-like workflows across 30+ languages. We are a focused code-execution runtime with LSP primitives — optimized for batch semantic operations on TypeScript codebases.
- **Not a generic tool proxy.** Cloudflare's codemode wraps arbitrary tools into code execution. We expose a curated, domain-specific `lsp.*` API with concrete types, rich error messages, and transactional writes. The domain specialization is the value.
- **Not an IDE replacement.** No completion, no hover tooltips, no interactive features. This is a headless tool for programmatic code manipulation.

### Primary user

Agentic workflows where a calling LLM writes scripts to perform semantic code operations. The MCP client (Claude, GPT, etc.) is the user. Humans set up the server; the LLM writes the scripts.

Secondary: power users running complex refactoring operations via Claude Desktop or similar MCP clients.

### The exploration question

The product skeptic correctly identified that single-script execution is optimized for batch operations (filter references, rename in bulk, extract patterns) where the plan is known upfront. Exploration — where the LLM needs to discover, understand, then decide — is handled differently:

**The `execute` tool supports both patterns.** Exploratory scripts are small:

```javascript
// Exploration: discover project structure
const files = await lsp.listFiles("src/**/*.ts");
const symbols = await lsp.getSymbols("src/auth.ts");
symbols;
```

```javascript
// Exploration: understand a symbol before deciding what to do
const body = await lsp.getSymbolBody("src/auth.ts", "AuthService/validate");
const refs = await lsp.findReferences("src/auth.ts", "AuthService/validate");
({
  body,
  refCount: refs.length,
  refFiles: [...new Set(refs.map((r) => r.file))],
});
```

The LLM makes multiple small `execute` calls for exploration (chain-of-thought between calls), then a larger script for the actual operation. This is strictly better than multi-tool because even exploratory calls can compose operations (count refs AND get body in one call).

## Architecture

### Runtime & Transport

- **Runtime**: Bun (primary), Node-compatible (no Bun-specific APIs)
- **MCP**: `@modelcontextprotocol/sdk`, stdio transport
- **LSP transport**: `vscode-jsonrpc` for JSON-RPC framing + `vscode-languageserver-protocol` for LSP types. Do NOT build JSON-RPC from scratch.
- **Sandbox**: `vm.runInNewContext` with `Promise.race` timeout

**Why Bun**: Faster startup, native TypeScript execution (no build step for development), good `vm` module support. But: no Bun-specific APIs used — code must run on Node too for broader compatibility. Package manager: Bun.

### The `execute` Tool

Single MCP tool. Accepts JavaScript code as a string. Runs in a vm sandbox where `lsp.*` primitives are available. Returns the result.

The tool description includes:

1. TypeScript type definitions for the `lsp.*` API (auto-generated, ~1,000-1,200 tokens)
2. 3+ worked examples showing different patterns (exploration, batch refactoring, write-then-check)
3. Explicit warnings about common LLM footguns (async filter/map, missing await)

### Code Normalization

Adopt Cloudflare's `normalizeCode()` pattern. Accept multiple code formats:

- Bare statements (most common): `const x = await lsp.readFile("a.ts"); x;`
- Async arrow function: `async () => { ... }`
- Script with implicit return (last expression)

Use lightweight AST parsing (acorn) to detect the format and normalize. If the last statement is an expression, auto-return it. If the last expression is a Promise, auto-await it.

### Timeout

**Mandatory.** Wrap execution in `Promise.race` with configurable timeout (default 30s).

```javascript
const result = await Promise.race([
  executeInVm(code, context),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Script timed out after 30s")), 30000),
  ),
]);
```

This catches:

- Hanging LSP requests (server crashed mid-request)
- LLM-written `await` chains that never resolve
- Infinite async loops

It does NOT catch synchronous infinite loops (`while(true){}`). Accepted risk for v1 — LLMs rarely write these, and the real fix (worker_threads) is v2 complexity.

### Concurrency

**Serialize all `execute` calls with an async mutex.** Concurrent scripts would corrupt shared LSP state (position offsets invalidated by concurrent edits). Scripts are fast (sub-second typically), so serialization isn't a bottleneck.

```typescript
// Simple async mutex
let pending = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = pending.then(fn, fn);
  pending = p.then(
    () => {},
    () => {},
  );
  return p;
}
```

## LSP Primitives (the `lsp.*` API)

### Read Operations (8)

| Function                               | Description                                              | Returns          |
| -------------------------------------- | -------------------------------------------------------- | ---------------- |
| `lsp.readFile(file)`                   | Read file contents as raw string (no line numbers)       | `string`         |
| `lsp.getSymbolBody(file, symbolPath)`  | Read source code of a specific symbol                    | `string`         |
| `lsp.getSymbols(file)`                 | Document symbol tree (file outline)                      | `SymbolInfo[]`   |
| `lsp.findSymbol(query)`                | Workspace-wide symbol search                             | `SymbolInfo[]`   |
| `lsp.findReferences(file, symbolPath)` | All references to a symbol                               | `Reference[]`    |
| `lsp.goToDefinition(file, symbolPath)` | Jump to definition                                       | `Location`       |
| `lsp.searchText(pattern, glob?)`       | Regex search across files (not LSP — direct file search) | `SearchResult[]` |
| `lsp.listFiles(glob?)`                 | Discover project files matching glob                     | `string[]`       |

### Write Operations (6)

| Function                                           | Description                                                 | Returns       |
| -------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| `lsp.renameSymbol(file, symbolPath, newName)`      | LSP rename across codebase                                  | `WriteResult` |
| `lsp.replaceSymbolBody(file, symbolPath, newText)` | Replace a symbol's full declaration                         | `WriteResult` |
| `lsp.insertBeforeSymbol(file, symbolPath, text)`   | Insert code before a symbol                                 | `WriteResult` |
| `lsp.insertAfterSymbol(file, symbolPath, text)`    | Insert code after a symbol                                  | `WriteResult` |
| `lsp.deleteSymbol(file, symbolPath)`               | Remove a symbol (including decorators/JSDoc)                | `WriteResult` |
| `lsp.writeFile(file, content)`                     | Create/overwrite a file (escape hatch for non-symbol edits) | `WriteResult` |

### Diagnostics (1)

| Function                    | Description                                 | Returns        |
| --------------------------- | ------------------------------------------- | -------------- |
| `lsp.getDiagnostics(file?)` | Get current diagnostics (type errors, etc.) | `Diagnostic[]` |

**Total: 15 functions.** Each justified by concrete workflow gaps documented in the API surface review.

### Design decision: `readFile` returns raw content

NOT line-numbered. Line numbers embedded in content break string manipulation (`content.replace(...)` fails, `writeFile` would write line numbers to disk). Structured APIs already provide line info:

- `SymbolInfo.startLine / endLine`
- `Reference.line`
- `Diagnostic.range`

### Design decision: write operations auto-return diagnostics

```typescript
interface WriteResult {
  file: string;
  filesChanged: string[]; // for rename: all affected files
  diagnostics: Diagnostic[]; // collected after a brief wait for LSP to process
}
```

The write-check-fix loop in a single script:

```javascript
const result = await lsp.replaceSymbolBody("src/auth.ts", "validate", newBody);
if (result.diagnostics.length > 0) {
  // self-correct: read the diagnostics, fix the code, try again
  const diags = result.diagnostics.map(
    (d) => `${d.message} (line ${d.range.start.line})`,
  );
  console.error("Diagnostics after edit:", diags);
}
```

### Design decision: `getDiagnostics` implementation

LSP diagnostics are **push-based** (`textDocument/publishDiagnostics` notification), not request-response. Implementation:

1. Register a notification handler that stores diagnostics per-URI in a `Map<string, Diagnostic[]>`
2. After each `didChange`, wait for the next `publishDiagnostics` for that URI (timeout: 2s)
3. `getDiagnostics(file)` reads from the stored map
4. Auto-return in `WriteResult` waits for the push notification with the same timeout

## Type Definitions

### SymbolInfo

```typescript
interface SymbolInfo {
  name: string;
  path: string; // exact slash-separated path for use in other lsp.* calls
  kind: string; // "class", "function", "variable", "method", "property", etc.
  exported: boolean;
  startLine: number;
  endLine: number;
  signature?: string; // one-line signature (avoids needing getSymbolBody to understand the symbol)
  children?: SymbolInfo[];
}
```

`path` is the critical field — it's the reusable handle that eliminates symbol path guessing. `getSymbols` returns it, every other function accepts it.

### Reference

```typescript
interface Reference {
  file: string;
  line: number;
  column: number;
  context: string; // the actual line of code containing the reference
  symbolPath: string; // path of the containing symbol (reusable in other calls)
  isWriteAccess: boolean; // distinguish assignments from reads
}
```

`context` enables in-script filtering without `readFile`. `isWriteAccess` helps refactoring scripts distinguish "where is this set?" from "where is this read?".

### Diagnostic

```typescript
interface Diagnostic {
  file: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: "error" | "warning" | "info" | "hint";
}
```

### Location

```typescript
interface Location {
  file: string;
  line: number;
  column: number;
  symbolPath?: string; // if the definition lands inside a known symbol
}
```

### SearchResult

```typescript
interface SearchResult {
  file: string;
  line: number;
  column: number;
  match: string; // the matched text
  context: string; // full line containing the match
}
```

### WriteResult

```typescript
interface WriteResult {
  file: string;
  filesChanged: string[];
  diagnostics: Diagnostic[];
}
```

## Symbol Path Resolution

Slash-separated, unlimited nesting depth. Walks the `textDocument/documentSymbol` tree.

```
"MyClass"                      → top-level class
"MyClass/constructor"          → class constructor
"MyClass/myMethod"             → class method
"OuterClass/InnerClass/method" → deeply nested
"myFunction"                   → top-level function
"config"                       → variable (arrow fns use their variable name)
```

### Dot alias

Accept `.` as separator (normalized to `/` internally). LLMs frequently write `MyClass.myMethod` from training data patterns. Trivial to support, prevents the most common mistake.

### Overload index

Support `[N]` suffix for overloaded symbols: `"MyClass/constructor[0]"`, `"MyClass/constructor[1]"`. Required for TypeScript constructors and method overloads.

### Error messages target LLMs

When a symbol path doesn't resolve:

```
Symbol "AuthService.login" not found in "src/auth.ts".
Available top-level symbols: AuthService, UserRole, createAuthMiddleware.
AuthService has children: validate, validateToken, refreshSession, logout.
```

The LLM reads this, self-corrects in the next script. Saves an entire retry round-trip.

### Ambiguity

If a bare name matches multiple symbols (e.g., two files export `Config`), return candidates:

```
Multiple symbols match "Config":
  - src/auth/config.ts: Config (interface, exported)
  - src/db/config.ts: Config (type alias, exported)
Provide the full file path to disambiguate.
```

## Transactional Writes

### Buffer Strategy

1. On first access to a file, `didOpen` with disk content. Store original content.
2. Write operations update the in-memory buffer and send `didChange` to LSP (incremental or full depending on server capability).
3. All reads within the same script go through the LSP (which has the buffered state) — never from disk.
4. Script completes successfully → flush all dirty buffers to disk atomically.
5. Script throws → `didChange` every dirty file back to its stored original. Disk untouched.

### Rollback mechanism

**Use `didChange` back to original content**, NOT `didClose`+`didOpen`. Rapid close/open cycles can leave tsserver with stale state. Changing the content back to original via `didChange` is cleaner and more reliable.

### Rename fan-out

`renameSymbol` calls `textDocument/rename` which returns a `WorkspaceEdit` that can touch many files. Implementation:

1. Get the `WorkspaceEdit` from LSP
2. For each affected file: `didOpen` if not already open, buffer original content
3. Apply all edits to in-memory buffers
4. Send `didChange` for each affected file
5. All affected files join the dirty set for flush/rollback

### Partial flush failure

If flushing to disk fails mid-way (permission error, disk full):

- Report which files were/weren't written
- Roll back LSP state for all files (even those successfully written — they're already on disk, the LSP just needs to stay consistent)
- Return a clear error

## Sandbox

### Available in `vm` context

- `lsp.*` — all 15 primitives listed above
- JS builtins — Math, JSON, Array, Object, Map, Set, Promise, String, Number, Date, RegExp, Error, etc.
- `console.log/warn/error` — captured to a logs array, returned alongside the script result
- `path.join`, `path.basename`, `path.dirname`, `path.extname` — LLMs frequently need path manipulation when working with references across files

### Not available

- No `fetch` or network access
- No `fs` / `require` / `import` — file reading goes through `lsp.readFile()`
- No `setTimeout` / `setInterval` — timing is handled by the runtime
- No `process`, `Bun`, `Deno`, or other runtime globals

## Tool Description

The `execute` tool description is the LLM's documentation. It must be optimized for correct code generation, not for human reading.

### Structure

1. **One-line purpose**: "Execute JavaScript to perform semantic code operations via LSP."
2. **Type definitions**: Auto-generated from `lsp-api.ts` (~1,000 tokens)
3. **Worked examples** (3 minimum):
   - Exploration: `listFiles` + `getSymbols`
   - Batch refactoring: `findReferences` + filter + `replaceSymbolBody`
   - Write-then-check: `replaceSymbolBody` + inspect diagnostics
4. **Warnings**:
   - "Array .filter() and .map() callbacks cannot be async. Use a for...of loop with await instead."
   - "Symbol paths use `/` separator: `MyClass/myMethod`. Use `getSymbols()` to discover exact paths."
   - "The last expression is the return value. Do not use `return`."

### Type generation

Build step: `tsc --declaration --emitDeclarationOnly` on `lsp-api.ts`, read the `.d.ts` output, embed in tool description via `{{types}}` placeholder. Single source of truth.

## LSP Integration Details

### Language Server (v1)

TypeScript only: `typescript-language-server` over stdio. The architecture is language-agnostic — adding another language = map extensions → spawn the right server. But v1 focuses on one language done well.

### Initialization & Warmup

1. Spawn `typescript-language-server --stdio`
2. Send `initialize` with workspace root = cwd
3. Send `initialized`
4. Listen for `experimental/serverStatus` notification with `{ quiescent: true }` — this signals the server has finished indexing
5. Fall back: if no `serverStatus` within 3 seconds of `initialized`, assume ready
6. Proactively `didOpen` a representative file (e.g., `tsconfig.json` or the first `.ts` file) to trigger project loading

This warmup happens in the background when the MCP server starts, not on first `execute` call.

### Document Sync

- Declare `textDocumentSync: 2` (incremental) in client capabilities if typescript-language-server requires it
- Store per-file: URI, content, version counter
- On `didChange`: increment version, send changed ranges
- On rollback: send full content replacement via `didChange` (version still increments)

### Diagnostics Collection

- Register handler for `textDocument/publishDiagnostics` notification
- Store in `Map<string, Diagnostic[]>` keyed by file URI
- After writes that trigger `didChange`, wait up to 2s for updated diagnostics for affected files
- `getDiagnostics(file)` reads from this map (instant, no LSP request)

### Crash Recovery

- LSP process dies → all pending LSP requests reject → script fails → transactional rollback
- Next `execute` call: detect dead process, respawn + full init handshake
- No replay of previously-open documents — `didOpen` happens naturally as the new script touches files
- Eagerly check server health at script start (not lazily on first LSP call)

### Capabilities We Use

| LSP Method                                           | Used For                                                |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `textDocument/documentSymbol`                        | `getSymbols`, symbol path resolution for all operations |
| `textDocument/references`                            | `findReferences`                                        |
| `textDocument/definition`                            | `goToDefinition`                                        |
| `textDocument/rename` + `textDocument/prepareRename` | `renameSymbol`                                          |
| `workspace/symbol`                                   | `findSymbol`                                            |
| `textDocument/publishDiagnostics` (notification)     | `getDiagnostics`, auto-diagnostics in WriteResult       |
| `textDocument/didOpen`                               | File lifecycle                                          |
| `textDocument/didChange`                             | Transactional writes                                    |
| `textDocument/didClose`                              | File cleanup (LRU eviction)                             |

### Capabilities We Do NOT Use (v1)

- `textDocument/completion` — IDE feature, not useful in scripts
- `textDocument/hover` — potentially useful but not v1
- `textDocument/codeAction` — auto-import, organize imports — v2 candidate
- `textDocument/implementation` — distinct from references — v2 candidate
- `textDocument/signatureHelp` — IDE feature
- `callHierarchy/*` — deferred
- `typeHierarchy/*` — deferred

## Modules

### v1 module structure

```
src/
  mcp-server.ts    — MCP server setup, execute tool registration, stdio transport
  lsp-client.ts    — vscode-jsonrpc connection, spawn tsserver, init handshake, crash recovery, server health
  buffer.ts        — transactional write buffer, per-file content tracking, flush/rollback, dirty set
  lsp-api.ts       — the lsp.* API surface (wraps LSP calls + buffer operations into clean async functions)
  sandbox.ts       — vm context setup, inject lsp.* + path.*, code normalization, Promise.race timeout, log capture
  symbol.ts        — symbol path resolution (slash/dot-separated path → LSP position via document symbols)
```

**No `lsp-manager.ts` in v1.** Single language server means no manager abstraction needed. Extract when adding a second language.

**`buffer.ts` is new.** Split from `lsp-api.ts` because transactional state management (original content storage, dirty tracking, flush, rollback, rename fan-out) is complex enough to warrant its own module and tests.

## What's Explicitly Deferred (v2+)

| Feature                                                   | Reason                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Multi-language support                                    | Architecture is ready (lsp-manager extraction), but v1 focuses on TypeScript                 |
| `textDocument/codeAction` (auto-import, organize imports) | Valuable but complex; scripts can work around with manual imports                            |
| `textDocument/implementation`                             | Useful for interface refactoring; `findReferences` covers most cases                         |
| `textDocument/hover` (type info)                          | Useful for understanding before refactoring; `getSymbolBody` + `signature` covers most cases |
| Shell command execution                                   | Out of scope. MCP clients have their own shell tools. This server is LSP-focused.            |
| Human approval workflow                                   | MCP-level concern, not server-level. MCP clients can implement approval.                     |
| Config file / multi-root workspace                        | No config needed with one thing to configure (server path). Multi-root is premature.         |
| `worker_threads` isolation                                | For catching sync infinite loops. `Promise.race` timeout covers async cases in v1.           |
| `lsp.checkpoint()` (mid-script flush)                     | For partial progress in long scripts. Scripts should be short in v1.                         |
| Git integration / undo                                    | Out of scope. The file system and git are the user's responsibility.                         |

## Risks and Mitigations

### Risk 1: Diagnostics timing is unreliable

**Impact**: `WriteResult.diagnostics` may be empty or stale if tsserver hasn't finished processing changes.
**Mitigation**: Wait up to 2s for `publishDiagnostics` after each `didChange`. Accept that diagnostics may be incomplete for complex type-level changes. `getDiagnostics` is always available for an explicit check.

### Risk 2: Cross-file operations return incomplete results after cold start

**Impact**: First `findReferences` or `goToDefinition` call may miss results if tsserver hasn't finished indexing.
**Mitigation**: Warmup during server init — listen for `experimental/serverStatus { quiescent: true }` with 3s fallback timeout. Background warmup, doesn't block first request (but first request waits if warmup hasn't completed).

### Risk 3: LLMs write async filter/map callbacks

**Impact**: Silent incorrect behavior — no error thrown, but filtering doesn't work.
**Mitigation**: Explicit warning in tool description with correct pattern. Consider runtime detection: if a filter/map callback returns a Promise, log a warning. Can't prevent it but can make it visible.

### Risk 4: Large WorkspaceEdit from rename touches many files

**Impact**: Opening 20+ files, buffering them all, risk of partial failure during flush.
**Mitigation**: Buffer all affected files in dirty set. On flush failure, report exact state. Accept that rename is the highest-risk operation.

### Risk 5: Sync infinite loop blocks the event loop

**Impact**: MCP server hangs permanently. Client must kill and restart.
**Mitigation**: Accepted risk for v1. LLMs rarely write `while(true){}`. The `Promise.race` timeout catches all async hangs. Document this limitation. v2: `worker_threads` isolation.

### Risk 6: "Why not just use Serena?"

**Impact**: Adoption challenge. Serena has same underlying tech, more features, established community.
**Mitigation**: Different positioning. Serena is a comprehensive multi-tool IDE-replacement MCP server. We are a focused code-execution runtime — fewer moving parts, transactional semantics, token-efficient (one tool vs 49), and optimized for agentic batch operations. The code-mode paradigm is the differentiator, not the LSP integration.

## Success Criteria (v1)

The server is "done" when:

1. An LLM can discover project structure, understand symbols, and perform multi-file refactoring in a single `execute` call
2. Failed scripts roll back cleanly — disk is never left in a partial state
3. The LLM can self-correct from error messages without human intervention
4. Type definitions in the tool description are sufficient for correct code generation in >90% of cases
5. The server handles typescript-language-server lifecycle (startup, warmup, crash recovery) transparently
