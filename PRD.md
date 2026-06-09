# codemode-lsp — Spec (v1)

This is the spec of record. `VISION.md` and `api-surface-review.md` are historical working documents; where they disagree with this file, this file wins. Resolved contradictions are logged in [Decision Log](#decision-log).

## Core Thesis

An MCP server exposing a **single `execute` tool** backed by LSP. The LLM writes JavaScript that chains semantic code operations, executed in a vm sandbox with transactional write semantics.

LLMs are better at writing code than orchestrating tool calls. With discrete tools (Serena exposes ~49), the LLM must filter, loop, and branch in natural language across many round-trips. With code execution, it writes one script:

```javascript
const refs = await lsp.findReferences("src/api.ts", "handleRequest");
const relevant = refs.filter((r) => r.context.includes("deprecated"));
for (const ref of relevant) {
  await lsp.replaceSymbolBody(ref.file, ref.symbolPath, newImpl);
}
({ modified: relevant.length });
```

One round-trip. Filtering, looping, and chaining happen in code — the same imperative patterns the model has seen millions of times in training data.

### What this is NOT

- **Not a Serena competitor.** Serena is a multi-tool, multi-language IDE-like MCP server. This is a focused code-execution runtime with LSP primitives, optimized for batch semantic operations on TypeScript codebases.
- **Not a generic tool proxy.** Cloudflare's codemode wraps arbitrary tools. We expose a curated, domain-specific `lsp.*` API with concrete types, LLM-targeted error messages, and transactional writes. The domain specialization is the value.
- **Not an IDE replacement.** No completion, hover, or interactive features. Headless programmatic code manipulation only.

### Primary user

The MCP client LLM (Claude, GPT, etc.). Humans set up the server; the LLM writes the scripts. Exploration happens via multiple small `execute` calls (chain-of-thought between calls); batch operations via one larger script.

## Architecture

### Runtime & Transport

- **Runtime**: Bun (primary). No Bun-specific APIs — must also run on Node. Package manager: Bun.
- **MCP**: `@modelcontextprotocol/sdk`, stdio transport.
- **LSP transport**: `vscode-jsonrpc` for JSON-RPC framing + `vscode-languageserver-protocol` for LSP types. Do NOT build JSON-RPC framing from scratch.
- **Sandbox**: `vm.runInNewContext` with `Promise.race` timeout. Not a security boundary — safety comes from the narrow API surface and path containment, not process isolation.

### Language Server (v1)

TypeScript only: `typescript-language-server --stdio`. Nothing in the architecture is TypeScript-specific — adding a language later means mapping file extensions to a server spawn. v1 does one language well.

### The `execute` Tool

Accepts JavaScript code as a string. Runs it in the sandbox where `lsp.*` is available. Returns `{ result, logs }`.

- **result**: what the script's last expression evaluates to (JSON-serialized).
- **logs**: captured `console.log/warn/error` calls, in order.

**Code normalization** (Cloudflare's `normalizeCode()` pattern): accept bare statements, an async arrow function, or a script with implicit last-expression return. Parse with acorn to detect the format. If the last statement is an expression, return it. If the returned value is a Promise, auto-await it (prevents the silent `[object Promise]` footgun).

**Timeout**: mandatory, default 30s, `Promise.race`. Catches hung LSP requests and async infinite loops. Does NOT catch synchronous `while(true){}` — accepted v1 risk, documented; v2 fix is `worker_threads`.

**Per-request LSP timeout**: every LSP request has an internal 10s timeout so a wedged language server fails the script with a clear error before the script timeout fires.

**Concurrency**: all `execute` calls are serialized through an async mutex. Concurrent scripts would corrupt shared LSP/buffer state. Scripts are typically sub-second; serialization is not a bottleneck.

**Result size cap**: the serialized result is truncated at **50,000 characters**. Truncation appends a marker: `"[truncated — result exceeded 50000 chars. Refine the script to return less data, e.g. map to only the fields you need.]"`. Logs are capped at 10,000 characters total under the same policy. Non-serializable results (functions, circular references) return an error explaining what to return instead.

### Errors

All `lsp.*` failures throw real JS `Error`s inside the sandbox, so scripts can `try/catch` and self-correct mid-script. Uncaught errors fail the script: the tool returns the error message + any logs captured so far, and all buffered writes roll back.

Error messages target LLMs, not humans — include enough state to self-correct without another discovery call. See [Symbol Path Resolution](#symbol-path-resolution) for examples.

## The `lsp.*` API (16 functions)

### Path rules

- All `file` arguments are **relative to the workspace root** (the server's cwd). Absolute paths inside the root are accepted and normalized.
- Any path resolving **outside the workspace root is rejected** with an error — applies to reads and writes. This is the containment boundary for the sandbox.
- `listFiles` and `searchText` respect `.gitignore` and always exclude `node_modules` and `.git`.

### Read operations (8)

| Function | Description | Returns |
| --- | --- | --- |
| `lsp.readFile(file)` | File contents as a raw string (no line numbers) | `string` |
| `lsp.getSymbolBody(file, symbolPath)` | Source code of a specific symbol | `string` |
| `lsp.getSymbols(file)` | Document symbol tree (file outline) | `SymbolInfo[]` |
| `lsp.findSymbol(query)` | Workspace-wide symbol search | `SymbolInfo[]` |
| `lsp.findReferences(file, symbolPath)` | All references to a symbol | `Reference[]` |
| `lsp.goToDefinition(file, symbolPath)` | Jump to definition | `Location` |
| `lsp.searchText(pattern, glob?)` | Regex search across files (direct file search, not LSP) | `SearchResult[]` |
| `lsp.listFiles(glob?)` | Project files matching glob | `string[]` |

`readFile` returns **raw** content: line numbers embedded in the string would break the read → JS-transform → `writeFile` loop. Line info comes from the structured APIs (`SymbolInfo.startLine/endLine`, `Reference.line`, `Diagnostic.range`).

### Write operations (7)

| Function | Description | Returns |
| --- | --- | --- |
| `lsp.renameSymbol(file, symbolPath, newName)` | LSP rename across codebase | `WriteResult` |
| `lsp.replaceSymbolBody(file, symbolPath, newText)` | Replace a symbol's full declaration | `WriteResult` |
| `lsp.insertBeforeSymbol(file, symbolPath, text)` | Insert code before a symbol | `WriteResult` |
| `lsp.insertAfterSymbol(file, symbolPath, text)` | Insert code after a symbol | `WriteResult` |
| `lsp.deleteSymbol(file, symbolPath)` | Remove a symbol incl. JSDoc/decorators/trailing whitespace | `WriteResult` |
| `lsp.writeFile(file, content)` | Create or overwrite a file (escape hatch for non-symbol edits) | `WriteResult` |
| `lsp.deleteFile(file)` | Delete a file (buffered like all writes) | `WriteResult` |

Both `deleteSymbol` and `deleteFile` are in (the working docs each dropped one): dead-code removal needs `deleteFile`, and `deleteSymbol` avoids the error-prone readFile + string-surgery workaround since LSP knows exact symbol bounds.

### Diagnostics (1)

| Function | Description | Returns |
| --- | --- | --- |
| `lsp.getDiagnostics(file?)` | Current diagnostics; no arg = all files touched this session | `Diagnostic[]` |

**Limitation (documented in tool description)**: tsserver only publishes diagnostics for opened files. `getDiagnostics()` is not a project-wide type check — it covers files the script (or session) has touched.

Write operations **auto-return diagnostics** so the write-check-fix loop fits in one script:

```javascript
const result = await lsp.replaceSymbolBody("src/auth.ts", "validate", newBody);
if (result.diagnostics.some((d) => d.severity === "error")) {
  // read diagnostics, fix, retry — all in this script
}
```

## Type Definitions

```typescript
interface SymbolInfo {
  name: string;
  path: string;        // exact slash-separated path for use in other lsp.* calls
  kind: string;        // "class" | "function" | "method" | "variable" | ...
  exported: boolean;
  startLine: number;
  endLine: number;
  signature?: string;  // one-line signature; often avoids a getSymbolBody call
  children?: SymbolInfo[];
}

interface Reference {
  file: string;
  line: number;
  column: number;
  context: string;       // the actual line of code containing the reference
  symbolPath: string;    // path of the containing symbol (reusable handle)
  isWriteAccess: boolean; // assignment vs read
}

interface Location {
  file: string;
  line: number;
  column: number;
  symbolPath?: string; // if the definition lands inside a known symbol
}

interface SearchResult {
  file: string;
  line: number;
  column: number;
  match: string;
  context: string; // full line containing the match
}

interface Diagnostic {
  file: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  severity: "error" | "warning" | "info" | "hint";
}

interface WriteResult {
  file: string;
  filesChanged: string[];  // for rename: all affected files
  diagnostics: Diagnostic[]; // collected after waiting ≤2s for publishDiagnostics
}
```

`SymbolInfo.path` is the critical field: `getSymbols` returns it, every other function accepts it. It eliminates the #1 LLM failure mode — guessing symbol paths.

## Symbol Path Resolution

Slash-separated, unlimited nesting, resolved by walking the `textDocument/documentSymbol` tree.

```
"MyClass"                      → top-level class
"MyClass/constructor"          → class constructor
"MyClass/myMethod"             → class method
"OuterClass/InnerClass/method" → deeply nested
"myFunction"                   → top-level function
"config"                       → variable (arrow fns use their variable name)
"router/get"                   → object literal property
```

- **Dot alias**: `MyClass.myMethod` is accepted and normalized to `/`. LLMs write dots constantly; supporting it is free.
- **Overload index**: `[N]` suffix for overloads — `"MyClass/constructor[1]"`. Required for TS constructors/method overloads.
- **Not found** → throw with self-correction context:

  ```
  Symbol "AuthService/login" not found in "src/auth.ts".
  Available top-level symbols: AuthService, UserRole, createAuthMiddleware.
  AuthService has children: validate, validateToken, refreshSession, logout.
  ```

- **Ambiguous bare name** (workspace search) → throw listing candidates with file, kind, and exported status, instructing the script to pass the full file path.

## Transactional Writes

Nothing hits disk until the script completes successfully. Per-file buffer states: **clean**, **modified** (original content stored), **created** (no original), **deleted**.

1. First access to a file → `didOpen` with disk content; store original.
2. Write op → update in-memory buffer, send `didChange` (version incremented). LSP sees buffered state; all subsequent reads in the script reflect it.
3. `writeFile` on a new file → buffer as *created*, `didOpen` with the new content.
4. `deleteFile` → buffer as *deleted*, `didClose`. Later reads of that file in the same script throw ("deleted earlier in this script").
5. Script succeeds → flush: write modified/created buffers, unlink deleted files.
6. Script throws → rollback: `didChange` modified files back to originals (NOT `didClose`+`didOpen` — rapid close/open cycles leave tsserver stale); `didClose` created files; `didOpen` deleted files back. Disk untouched.

**Rename fan-out**: `textDocument/rename` returns a `WorkspaceEdit` that may touch many files. Each affected file is opened if needed, its original stored, edits applied to buffers, `didChange` sent. All join the dirty set for flush/rollback. Rename is the highest-risk operation; that's accepted.

**Partial flush failure** (permission error, disk full): report exactly which files were and weren't written, keep LSP state consistent with what's on disk, return a clear error.

## Sandbox

**Available**: `lsp.*`; JS builtins (Math, JSON, Array, Object, Map, Set, Promise, String, Number, Date, RegExp, Error, …); `console.log/warn/error` (captured, not printed); `path.join/basename/dirname/extname` (LLMs need path manipulation across references).

**Not available**: `fetch`/network, `fs`/`require`/`import`, `setTimeout`/`setInterval`, `process`/`Bun`/`Deno` or any runtime globals.

## Tool Description

The tool description is the LLM's documentation. Structure:

1. One-line purpose: "Execute JavaScript to perform semantic code operations via LSP."
2. **Type definitions** — auto-generated from `lsp-api.ts` (~1,000–1,200 tokens). Build step: `tsc --declaration --emitDeclarationOnly`, embed the `.d.ts` via a `{{types}}` placeholder. Single source of truth.
3. **Worked examples** (3 minimum): exploration (`listFiles` + `getSymbols`), batch refactor (`findReferences` → filter → `replaceSymbolBody`), write-then-check (inspect `WriteResult.diagnostics`).
4. **Warnings**:
   - "`.filter()`/`.map()` callbacks cannot be async — use `for...of` with `await`."
   - "Symbol paths use `/`: `MyClass/myMethod`. Use `getSymbols()` to discover exact paths."
   - "The last expression is the return value."
   - "Diagnostics cover touched files only, not the whole project."

## LSP Integration

### Initialization & warmup (at server start, in background)

1. Spawn `typescript-language-server --stdio`; `initialize` with root = cwd; `initialized`.
2. Wait for `experimental/serverStatus { quiescent: true }`; fall back to ready after 3s.
3. Proactively `didOpen` a representative file to trigger project load.
4. First `execute` call waits for warmup if it hasn't completed.

### Diagnostics collection

Push-based: handle `textDocument/publishDiagnostics`, store per-URI in a `Map`. After each `didChange`, wait up to 2s for fresh diagnostics for affected files. `getDiagnostics` reads the map instantly. Accept that diagnostics may lag for complex type-level changes.

### Crash recovery

- LSP process dies → pending requests reject → script fails → transactional rollback.
- Health check runs eagerly at the start of each `execute` (not lazily on first LSP call). Dead server → respawn + full handshake. No replay of open documents — `didOpen` happens naturally as the new script touches files.

### LSP methods used

`textDocument/documentSymbol`, `references`, `definition`, `rename` + `prepareRename`, `workspace/symbol`, `publishDiagnostics` (notification), `didOpen`/`didChange`/`didClose`. Explicitly unused in v1: completion, hover, codeAction, implementation, signatureHelp, call/type hierarchy.

## Configuration

No config file in v1. Two env vars:

- `CODEMODE_TIMEOUT_MS` — script timeout (default 30000)
- `CODEMODE_LSP_BIN` — language server command (default `typescript-language-server`)

Workspace root = server cwd. Single root. Client controls it by spawning the server from the desired directory.

## Modules

```
src/
  mcp-server.ts  — MCP server setup, execute tool registration, stdio transport
  lsp-client.ts  — vscode-jsonrpc connection, spawn/handshake/warmup, health, crash recovery
  buffer.ts      — transactional buffer: per-file state (modified/created/deleted), flush, rollback, rename fan-out
  lsp-api.ts     — the lsp.* surface (wraps LSP + buffer into clean async fns; source of truth for type gen)
  symbol.ts      — symbol path resolution (slash/dot path → LSP positions via document symbols)
  sandbox.ts     — vm context, code normalization (acorn), timeout, log capture, result serialization/truncation
```

No `lsp-manager.ts` in v1 — single language server needs no manager. Extract when adding a second language.

## Testing

- **Fixture workspace**: a small TypeScript project under `test/fixtures/` (classes, overloads, nested symbols, cross-file references) used by all integration tests.
- **Integration tests against the real `typescript-language-server`** are the core suite — the failure modes that matter (symbol resolution, rename fan-out, diagnostics timing, rollback) only show up against the real server. Run with `bun test`.
- **Unit tests** for the pure parts: symbol path parsing, code normalization, buffer state machine, result truncation.
- **Golden scripts**: each worked example from the tool description runs as a test, so the documentation can never silently rot.

## Build Plan

1. **LSP client core** — spawn, handshake, warmup, `documentSymbol`. Exit: integration test gets a symbol tree from the fixture project.
2. **Symbol resolution + read API** — `symbol.ts`, all 8 read ops. Exit: read ops pass integration tests incl. error-message format.
3. **Sandbox + MCP wiring** — `sandbox.ts`, `mcp-server.ts`, execute tool with read-only API. Exit: an MCP client can explore the fixture project end-to-end.
4. **Transactional writes** — `buffer.ts`, 7 write ops, diagnostics collection, rollback. Exit: failed scripts leave disk byte-identical; rename fan-out works.
5. **Polish** — type-def generation build step, tool description with examples/warnings, crash-recovery test, result truncation, README.

Each phase lands with its tests. Phase 3 produces a usable (read-only) server — dogfood it from that point on.

## Deferred (v2+)

| Feature | Reason |
| --- | --- |
| Multi-language support | Architecture ready (lsp-manager extraction); v1 = TypeScript done well |
| `codeAction` (auto-import, organize imports) | Valuable but complex; scripts can write imports manually |
| `implementation`, `hover`, call/type hierarchy | `findReferences`/`getSymbolBody`/`signature` cover most cases |
| Shell command execution | Out of scope; MCP clients have their own shell tools |
| Human approval workflow | MCP-client concern, not server concern |
| Config file / multi-root | Premature with two env vars to configure |
| `worker_threads` isolation | Only needed to catch sync infinite loops |
| `lsp.checkpoint()` mid-script flush | Scripts should be short in v1 |
| Git integration / undo | The file system and git are the user's responsibility |

## Risks

1. **Diagnostics timing** — `WriteResult.diagnostics` may be incomplete if tsserver lags. Mitigation: 2s wait; explicit `getDiagnostics` always available; limitation documented in tool description.
2. **Cold-start incompleteness** — first cross-file query may miss results pre-indexing. Mitigation: warmup with `serverStatus` + 3s fallback; first request waits.
3. **Async filter/map footgun** — silent misbehavior. Mitigation: tool-description warning; runtime detection (warn when a filter/map callback returns a Promise) if cheap.
4. **Rename fan-out** — many files buffered at once; flush can partially fail. Mitigation: exact-state reporting.
5. **Sync infinite loops** — hang the server. Accepted v1 risk; documented; v2 = worker_threads.
6. **"Why not Serena?"** — different positioning: focused code-execution runtime, transactional semantics, one tool vs ~49. The code-mode paradigm is the differentiator, not the LSP integration.

## Success Criteria (v1)

1. An LLM can discover structure, understand symbols, and perform multi-file refactoring in a single `execute` call.
2. Failed scripts roll back cleanly — disk never left partial.
3. The LLM self-corrects from error messages without human intervention.
4. Type defs in the tool description suffice for correct code generation >90% of the time.
5. Language-server lifecycle (startup, warmup, crash recovery) is invisible to the client.

## Decision Log

Contradictions between the working docs, resolved here:

- **API surface = 16 functions.** Includes BOTH `deleteSymbol` (VISION had it, api-review's final list dropped it) and `deleteFile` (vice versa). Each was independently justified; the buffer handles file create/delete as first-class states.
- **`readFile` returns raw content** (VISION) — not line-numbered (api-review). Line numbers break read→transform→write.
- **JSON-RPC via `vscode-jsonrpc`** (VISION) — not hand-rolled framing (old PRD).
- **No `lsp-manager.ts`** (VISION) — old PRD's module list was stale.
- **Symbol ambiguity throws** with a candidate list — "return candidates" in the old PRD was underspecified; throwing keeps every API's success type clean.
- **New in this spec** (no prior doc covered them): path containment (reject paths outside workspace root), result truncation at 50k chars, per-LSP-request 10s timeout, env-var configuration, file create/delete buffer states, testing strategy, build plan.

### Phase 1 implementation decisions (spec silent or contradicted by reality)

- **Warmup readiness signal.** § Initialization & warmup specifies waiting for `experimental/serverStatus { quiescent: true }`. `typescript-language-server` does **not** emit that notification — it is a rust-analyzer LSP extension. TLS instead emits `$/typescriptVersion` after `initialized`. Phase 1 registers handlers for **both** and releases the warmup gate on whichever arrives first, still bounded by the 3s fallback. Behavior matches the PRD's intent (a bounded readiness gate); only the signal source differs. The `experimental/serverStatus` handler is retained so the spec'd path works verbatim if a future server emits it.
- **Warmup representative file.** The spec says to proactively `didOpen` "a representative file" but not which. Phase 1 opens the first `.ts`/`.tsx` file found by a shallow scan of the root (skipping `node_modules`/`.git`/`dist`). If none exists, warmup proceeds on the readiness signal / fallback alone. `listFiles`-based selection is deferred (that API lands in Phase 2).
- **Per-request timeout is a constructor option, not an env var.** The 10s per-request LSP timeout is configurable via `LspClientOptions.requestTimeoutMs` (default 10000). The spec only defines two env vars (`CODEMODE_TIMEOUT_MS`, `CODEMODE_LSP_BIN`); the per-request timeout intentionally stays internal.
- **Crash recovery is eager and self-healing at the call boundary.** `documentSymbol` (and every future `lsp.*` op) calls `ensureAlive()` first; a dead server is respawned + fully re-handshaked transparently, with open documents re-opened on demand (no replay), per § Crash recovery. A `killServer()` primitive force-terminates the process (crash simulation / forced restart) distinct from the graceful `stop()`.
- **Path containment is OWED to Phase 2, not yet enforced.** § Path rules require rejecting any path resolving outside the workspace root. Phase 1's `documentSymbol` resolves `join(rootDir, file)` (and accepts absolute paths) **without** a containment check — `../../etc/passwd` would currently resolve. This is deliberately deferred: containment belongs with the `lsp.*` API surface (`lsp-api.ts`, Phase 2), which is the single choke point all read/write ops pass through. The Phase 1 integration test named "resolves absolute paths" exercises path handling, not a security boundary. **Phase 2 must add and test containment before any `lsp.*` op ships.**
- **Known Phase 1 lifecycle gaps deferred (surfaced by adversarial review, bounded, non-blocking for the exit criterion):** (a) on server death, in-flight requests are not rejected promptly — they fail via the per-request timeout (≤10s) rather than immediately; § Crash recovery line 251 wants prompt rejection (fix: `connection.dispose()` in the death handler). (b) the child's `stderr` pipe is created but never drained, so a very chatty server could backpressure and wedge (fix: drain or `ignore` stderr). (c) a bad `CODEMODE_LSP_BIN` fails via the handshake timeout instead of fast-failing on the spawn `error` event. (d) no single-flight guard on concurrent `ensureAlive()`/`start()` (mooted in v1 by the § Concurrency execute-mutex, but the guard belongs with this lifecycle code). Phase 2 should fold in (a)/(b) cheaply.
