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

Accepts JavaScript code as a string. Runs it in the sandbox where `lsp.*` is available. Returns `{ result, logs, changes }`.

- **result**: what the script's last expression evaluates to (JSON-serialized).
- **logs**: captured `console.log/warn/error` calls, in order.
- **changes**: what actually hit disk, one entry per flushed file: `{ file, kind: "modified" | "created" | "deleted", diff }` where `diff` is a unified diff against the pre-script content. Empty for read-only scripts. Nearly free to produce — the buffer already holds original + final content — and it lets the calling agent verify the edit did what it intended (and lets a human review it) without re-reading files. Diffs count toward the result size cap.

**Code normalization** (Cloudflare's `normalizeCode()` pattern): accept bare statements, an async arrow function, or a script with implicit last-expression return. Parse with acorn to detect the format. If the last statement is an expression, return it. If the returned value is a Promise, auto-await it (prevents the silent `[object Promise]` footgun).

**Timeout**: mandatory, default 30s, `Promise.race`. Catches hung LSP requests and async infinite loops. Does NOT catch synchronous `while(true){}` — accepted v1 risk, documented; v2 fix is `worker_threads`.

**Per-request LSP timeout**: every LSP request has an internal 10s timeout so a wedged language server fails the script with a clear error before the script timeout fires.

**Concurrency**: all `execute` calls are serialized through an async mutex. Concurrent scripts would corrupt shared LSP/buffer state. Scripts are typically sub-second; serialization is not a bottleneck.

**Result size cap**: the serialized result is truncated at **50,000 characters**. Truncation appends a marker: `"[truncated — result exceeded 50000 chars. Refine the script to return less data, e.g. map to only the fields you need.]"`. Logs are capped at 10,000 characters total under the same policy. Non-serializable results (functions, circular references) return an error explaining what to return instead.

### Errors

All `lsp.*` failures throw real JS `Error`s inside the sandbox, so scripts can `try/catch` and self-correct mid-script. Uncaught errors fail the script: the tool returns the error message + any logs captured so far, and all buffered writes roll back.

**Operation trace on failure**: every `lsp.*` call is recorded as it runs (function name, key arguments, one-line outcome — e.g. `findReferences(src/api.ts, handleRequest) → 14 results`). When a script fails, the trace is returned alongside the error:

```
completed:
  1. findReferences("src/api.ts", "handleRequest") → 14 results
  2. replaceSymbolBody("src/a.ts", "wrapA") → ok
failed at:
  3. replaceSymbolBody("src/b.ts", "Foo/bar") → Symbol "Foo/bar" not found in "src/b.ts". Available top-level symbols: Foo, helper. Foo has children: baz, qux.
All buffered changes were rolled back; the codebase is unchanged.
```

The model sees exactly where its script died, what had succeeded up to that point, and that the rollback happened — so the rewritten script can resume reasoning instead of rediscovering state. On success the trace is dropped (the result is what matters).

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

No config file in v1. Three env vars:

- `CODEMODE_TIMEOUT_MS` — script timeout (default 30000)
- `CODEMODE_LSP_BIN` — language server command (default `typescript-language-server`)
- `CODEMODE_READONLY` — when set to `1`/`true`, the 7 write operations are removed from the sandbox, the generated type definitions, and the tool description (the LLM never sees them, so it never tries them; read ops and `getDiagnostics` remain). The trust story for first contact: point it at a repo and it physically cannot write.

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
- **Eval suite** (post-v1 gate, see Build Plan phase 6): ~15 benchmark tasks (`scripts/eval.ts`) where a real LLM is given only the tool description and a task ("rename X and report affected files", "find unused exports", "extract this function to a new module") against the fixture project, scored pass/fail. This is how Success Criterion #4 (>90% correct codegen) becomes measurable: every change to the tool description, type defs, or error messages moves a number instead of vibes. Run on demand, not in CI (it costs tokens and needs an API key).

## Build Plan

1. **LSP client core** — spawn, handshake, warmup, `documentSymbol`. Exit: integration test gets a symbol tree from the fixture project.
2. **Symbol resolution + read API** — `symbol.ts`, all 8 read ops. Exit: read ops pass integration tests incl. error-message format.
3. **Sandbox + MCP wiring** — `sandbox.ts`, `mcp-server.ts`, execute tool with read-only API, operation trace recording. Exit: an MCP client can explore the fixture project end-to-end; a failing script's result includes the trace.
4. **Transactional writes** — `buffer.ts`, 7 write ops, diagnostics collection, rollback, `changes` diffs in the execute result, `CODEMODE_READONLY` gate. Exit: failed scripts leave disk byte-identical; rename fan-out works; a successful write script returns reviewable diffs.
5. **Polish** — type-def generation build step, tool description with examples/warnings, crash-recovery test, result truncation, README with a copy-paste `.mcp.json` snippet.
6. **Eval & distribution** — `scripts/eval.ts` benchmark suite (see Testing); publish so `bunx codemode-lsp` works from a clean machine. Exit: eval pass rate is measured and reported in the README; a stranger can install and run it from the README alone.

Each phase lands with its tests. Phase 3 produces a usable (read-only) server — dogfood it from that point on.

## Deferred (v2+)

| Feature | Reason |
| --- | --- |
| Multi-language support | Architecture ready (lsp-manager extraction); v1 = TypeScript done well |
| `codeAction` (auto-import, organize imports) | Valuable but complex; scripts can write imports manually |
| `implementation`, `hover`, call/type hierarchy | `findReferences`/`getSymbolBody`/`signature` cover most cases. `hover` (as `lsp.getType`) is the first candidate to pull forward — but only if the eval suite shows scripts stumbling on inferred types, not on speculation |
| Semantic search (embedding index) | Real gap — `findSymbol`/`searchText` are lexical — but it's chunky infra (indexing, invalidation on writes) deserving its own design. Deterministic at query time, so it doesn't violate the no-AI-inside rule |
| AI/LLM calls inside the server | Breaks determinism (rollback safety, testability, reproducible retries) and blurs who self-corrects. Litmus test: anything the calling LLM can do with the primitives stays in the caller. If a smart op ever justifies itself, use MCP **sampling** (server requests a completion from the client's own model — no API key, client controls it) |
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

### Usefulness review additions (post-Phase-1, pre-Phase-2)

Five additions from a usefulness review, all preserving the "deterministic hands, smart caller" split:

- **`changes` diffs in the execute result** (§ The execute Tool, Build Plan phase 4) — the buffer already holds original + final content, so unified diffs at flush are nearly free and make every write reviewable.
- **Operation trace on script failure** (§ Errors, Build Plan phase 3) — record each `lsp.*` call; on failure return where the script died and what had completed, so the rewritten script resumes reasoning instead of rediscovering state.
- **`CODEMODE_READONLY`** (§ Configuration, Build Plan phase 4) — strips write ops from sandbox, type defs, and tool description.
- **Eval suite** (§ Testing, new Build Plan phase 6) — makes Success Criterion #4 measurable; gates pulling deferred APIs (e.g. `hover`) forward on evidence.
- **Distribution** (Build Plan phases 5–6) — `bunx codemode-lsp` + copy-paste `.mcp.json` in the README.

Also recorded: **no AI inside the server** (deferred table) — the litmus test is "can the calling LLM do this with the primitives?"; MCP sampling is the escape hatch if a smart op ever justifies itself.

### Phase 1 implementation decisions (spec silent or contradicted by reality)

- **Warmup readiness signal.** § Initialization & warmup specifies waiting for `experimental/serverStatus { quiescent: true }`. `typescript-language-server` does **not** emit that notification — it is a rust-analyzer LSP extension. TLS instead emits `$/typescriptVersion` after `initialized`. Phase 1 registers handlers for **both** and releases the warmup gate on whichever arrives first, still bounded by the 3s fallback. Behavior matches the PRD's intent (a bounded readiness gate); only the signal source differs. The `experimental/serverStatus` handler is retained so the spec'd path works verbatim if a future server emits it.
- **Warmup representative file.** The spec says to proactively `didOpen` "a representative file" but not which. Phase 1 opens the first `.ts`/`.tsx` file found by a shallow scan of the root (skipping `node_modules`/`.git`/`dist`). If none exists, warmup proceeds on the readiness signal / fallback alone. `listFiles`-based selection is deferred (that API lands in Phase 2).
- **Per-request timeout is a constructor option, not an env var.** The 10s per-request LSP timeout is configurable via `LspClientOptions.requestTimeoutMs` (default 10000). The spec only defines two env vars (`CODEMODE_TIMEOUT_MS`, `CODEMODE_LSP_BIN`); the per-request timeout intentionally stays internal.
- **Crash recovery is eager and self-healing at the call boundary.** `documentSymbol` (and every future `lsp.*` op) calls `ensureAlive()` first; a dead server is respawned + fully re-handshaked transparently, with open documents re-opened on demand (no replay), per § Crash recovery. A `killServer()` primitive force-terminates the process (crash simulation / forced restart) distinct from the graceful `stop()`.
- **Path containment is OWED to Phase 2, not yet enforced.** § Path rules require rejecting any path resolving outside the workspace root. Phase 1's `documentSymbol` resolves `join(rootDir, file)` (and accepts absolute paths) **without** a containment check — `../../etc/passwd` would currently resolve. This is deliberately deferred: containment belongs with the `lsp.*` API surface (`lsp-api.ts`, Phase 2), which is the single choke point all read/write ops pass through. The Phase 1 integration test named "resolves absolute paths" exercises path handling, not a security boundary. **Phase 2 must add and test containment before any `lsp.*` op ships.**
- **Known Phase 1 lifecycle gaps deferred (surfaced by adversarial review, bounded, non-blocking for the exit criterion):** (a) on server death, in-flight requests are not rejected promptly — they fail via the per-request timeout (≤10s) rather than immediately; § Crash recovery line 251 wants prompt rejection (fix: `connection.dispose()` in the death handler). (b) the child's `stderr` pipe is created but never drained, so a very chatty server could backpressure and wedge (fix: drain or `ignore` stderr). (c) a bad `CODEMODE_LSP_BIN` fails via the handshake timeout instead of fast-failing on the spawn `error` event. (d) no single-flight guard on concurrent `ensureAlive()`/`start()` (mooted in v1 by the § Concurrency execute-mutex, but the guard belongs with this lifecycle code). Phase 2 should fold in (a)/(b) cheaply.

### Phase 2 implementation decisions (spec-vs-reality collisions)

- **`Reference.isWriteAccess` is conservative in Phase 2.** Standard `textDocument/references` responses are plain `Location[]`; `typescript-language-server` does not include read/write classification in the LSP payload. Phase 2 returns `false` for every reference rather than guessing from source text. If evals show this field matters, a later phase should add a TypeScript-aware classifier with tests instead of embedding a brittle heuristic now.
- **`SymbolInfo.exported` and `signature` are inferred, not reported by LSP.** `DocumentSymbol` and `workspace/symbol` do not carry export status or a declaration signature. Phase 2 infers `exported` from the declaration line and derives `signature` from the source line at the symbol range/selection. This satisfies the LLM-facing usefulness goal while keeping the LSP transport as the source of ranges and hierarchy.
- **`workspace/symbol` is flat, so `findSymbol()` returns best-effort handles.** `typescript-language-server` returns workspace symbols as flat `SymbolInformation` records with optional `containerName`, not the hierarchical `DocumentSymbol` tree used for exact slash paths. Phase 2 maps these to a file-bearing `WorkspaceSymbolInfo extends SymbolInfo` with `path` set to `containerName/name` when present; scripts that need exact reusable symbol handles should call `getSymbols(file)` on the returned `file`.
- **Ambiguous bare-name behavior is exact-match scoped.** The PRD says symbol ambiguity throws, but `workspace/symbol` is also the broad search primitive. Phase 2 throws only when a bare query exactly matches multiple workspace symbols; the error lists each candidate's file, kind, and exported status and tells the caller to use `getSymbols(file)` plus the returned `SymbolInfo.path`. Broader/fuzzy searches with multiple non-exact results still return candidates so `findSymbol()` remains useful as search.
- **Phase 1 lifecycle debt resolved in Phase 2.** The client now drains bounded stderr, reports spawn errors for bad `CODEMODE_LSP_BIN` values, disposes the JSON-RPC connection on server death so in-flight requests reject promptly, and guards startup with a single-flight promise shared by `start()`/`ensureAlive()`.

- **Un-addressable symbols are dropped from the symbol tree.** `typescript-language-server` 4.x emits `DocumentSymbol` nodes for anonymous functions and callbacks with synthetic names like `registry.find() callback` and `<function>` (dots, parens, spaces, angle brackets). These cannot serve as slash/dot symbol paths — the dot-alias normalization mangles them and they are not meaningful edit targets — so `SymbolInfo.path` for them never round-trips through `getSymbolBody`/`findReferences`/etc. Phase 2 filters any symbol whose name contains `/ . ( ) < >` or whitespace (and its subtree) out of `getSymbols` output and out of containing-symbol resolution. Consequently `findReferences` reports the nearest *addressable* enclosing symbol as `Reference.symbolPath` (e.g. a reference inside an anonymous arrow returned by `createAuthMiddleware` resolves to `createAuthMiddleware`, not `createAuthMiddleware/<function>/user`). This keeps the invariant that every emitted `path` is a usable handle.

- **`workspace/symbol` cold-start poll.** tsserver builds its project-wide symbol index lazily, a few hundred ms after the project loads, so the first `findSymbol()` after warmup returns an empty list (PRD Risk #2). Phase 2 polls `workspace/symbol` on an empty result for up to 3s before giving up, so the first cross-file query is not silently empty. `getDiagnostics`/`publishDiagnostics`: the client now advertises the `textDocument.publishDiagnostics` capability in `initialize` — TLS 4.x only pushes diagnostics when the client declares support, otherwise the fixture's intentional error is never published.

### Phase 3 implementation decisions (spec silent or contradicted by reality)

- **Only an *async* function/arrow is auto-invoked as an entry point.** § The execute Tool lists "an async arrow function" as one of three accepted code shapes alongside bare statements and last-expression scripts. A bare *synchronous* arrow (`() => 1`) is syntactically also a single arrow expression, but it is indistinguishable from a value the script means to *return* — and returning a function is a non-serializable result the PRD already errors on. Phase 3 therefore auto-invokes shape 1 only when the single top-level expression is `async`; a sync arrow falls through to the last-expression path and serializes as a (rejected) function result. This keeps the documented async-arrow ergonomics without hijacking a legitimate (if doomed) return value.

- **lsp.* errors are rebuilt with the sandbox realm's `Error` constructor.** § Errors requires that all `lsp.*` failures surface as real `Error`s inside the sandbox so scripts can `try/catch`. `vm.runInNewContext` creates a separate realm, so a host-realm `Error` thrown from an `lsp.*` implementation fails `e instanceof Error` *inside* the script. The traced wrapper catches the host error, preserves its message, and re-throws an `Error` constructed from the context's own `Error` (captured via `vm.runInContext("Error", ctx)`). Scripts see a genuine `instanceof Error` and the original LLM-targeted message.

- **Trace failure line numbering, and the Phase 4 rollback seam.** § Errors shows the trace as `completed:` (numbered successful steps) then `failed at:` (the step that threw). Phase 3 numbers the failed step as `completed.length + 1` and ends there — the rollback sentence ("All buffered changes were rolled back…") is explicitly a Phase 4 concern (no writes exist yet to roll back). `formatTrace` has a marked seam where that line is appended once `buffer.ts` lands. The structured `traceEntries` are also returned so Phase 4 can reformat without re-parsing.

- **MCP result shape.** The `execute` tool returns its `{ result, logs, changes }` object JSON-encoded inside a single MCP `text` content block; `changes` is always `[]` in Phase 3 (writes are Phase 4). On script failure the tool does **not** throw an MCP error — it returns the LLM-targeted error message plus the formatted operation trace in the `result` field (and logs captured so far), so the model self-corrects in-band rather than seeing an opaque protocol error. The execute core is factored into `createExecuteRunner` (async mutex + eager `ensureAlive` + first-call warmup wait) so it is unit-testable without the transport.

- **Entry point.** `src/index.ts` is the runnable bin (stdio transport, workspace root = cwd); `package.json` gains a `codemode-lsp` bin entry and a `start` script. The package is not renamed or published (that is Phase 6).

### Phase 4 implementation decisions (spec silent or contradicted by reality)

- **Transaction boundary lives in the execute runner, not the buffer.** `buffer.ts` (`TransactionalBuffer`) only knows how to track/flush/rollback; the lifecycle (begin per script, flush on success, rollback on failure, append the rollback trace line) is owned by `createExecuteRunner`. A fresh buffer is created per `execute` via `LspApi.beginTransaction()`; the `LspApi` holds the active buffer so reads (`readFile`, `getSymbolBody`, `getSymbols`, `searchText`, reference context) reflect buffered writes. Reads outside a transaction go straight to disk (unchanged Phase 2/3 behavior).

- **Write ops + buffered reads call `ensureAlive()` themselves.** The runner already `ensureAlive`s before the script, but the first buffered read/write opens a document in tsserver (`didOpen`), which requires a live server. `writeFile`/`deleteFile`/`deleteSymbol` and the buffered read ops each `ensureAlive` (idempotent) so direct-API callers and crash-recovery edge cases stay correct, not just the runner path.

- **`insertBeforeSymbol`/`insertAfterSymbol` anchor to whole lines, not the raw symbol range.** A `DocumentSymbol` range for an arrow-function const starts at the *name* (`isAdmin`), not the `export const ` modifier, so inserting at `range.start` lands mid-declaration. Phase 4 inserts at column 0 of the symbol's start line (before) and just past the end of its last line (after), so inserted blocks sit on their own lines around the full declaration.

- **`deleteSymbol` comment/decorator absorption is lexical.** LSP gives only the symbol's own range; the PRD wants JSDoc/decorators/trailing whitespace gone too. `expandDeletionRange` walks lines upward absorbing contiguous `//`, `/* */`, `/** */`, and `@decorator` lines (stopping at a blank line, which separates symbols), and extends the end past the trailing newline. This is a deliberate heuristic over disk text, not an AST walk — adequate for the v1 fixtures and the common cases; a TS-aware range is a later refinement if evals show edge cases.

- **Rename fan-out warms the cross-file index before renaming (PRD Risk #2).** `textDocument/rename` only fans out to files tsserver has in its project view, and the reference index is built lazily — the first `references`/`rename` call after warmup returns just the origin file (confirmed against the real server: cross-file edits appear a few hundred ms later). `renameSymbol` polls `textDocument/references`, opening each referencing file in the buffer, until the referencing-file set stops growing for 3 consecutive 150ms polls (≤3s bound), then renames. This makes fan-out deterministic in tests (5/5) at ~900ms instead of flaky. Same poll-until-stable shape as the existing `workspaceSymbolWithIndexWait`.

- **Rollback uses `didChange`, never close+open (per the PRD).** modified files `didChange` back to their original text, created files `didClose`, deleted files `didOpen` back — matching § Transactional Writes' note that rapid close/open leaves tsserver stale. Rollback is best-effort/never-throws: disk was never touched, so even if a notification fails (e.g. server died) the codebase is already consistent and a respawn re-opens documents on demand.

- **Partial flush failure does not roll back the buffer.** On a mid-flush disk error (permission/ENOTDIR/disk full), `flush` throws naming exactly which files were and weren't written and leaves the partial write on disk (it does *not* attempt to undo the already-written files, which would diverge further from disk). The LLM-facing error tells the script to re-read the listed files before retrying. This trades the all-or-nothing guarantee (already void once bytes hit disk) for an accurate, recoverable report.

- **Unified diff is a hand-rolled LCS, no new dependency.** `diff.ts` is a minimal line-level LCS → hunks (3 lines context) → unified-diff renderer, sufficient for reviewable `changes`. It emits the standard `+0,0`/`-0,0` empty-side headers for whole-file create/delete and a `\ No newline at end of file` marker (including the trailing-newline-only-change case, which has no line hunks). Diffs count toward the 50k result cap.

- **`CODEMODE_READONLY` strips ops by *absence*.** Under read-only mode the 7 write ops are never added to the sandbox `lsp` object (so `typeof lsp.writeFile === "undefined"`) and the write section is removed from the tool description. The env var is read once at server start via `resolveReadonly` (`1`/`true`, case-insensitive); `createServer({ readonly })` also takes it explicitly for tests. Type-def generation stripping is deferred to Phase 5 (the `.d.ts` build step does not exist yet); the runtime + description gates are in place now.

- **`deleteFile` returns no diagnostics.** A deleted file is closed in tsserver and has nothing to diagnose; its `WriteResult.diagnostics` is `[]`. Other write ops wait ≤2s for fresh `publishDiagnostics` on the affected URIs (the spec'd auto-diagnostics path). Integration tests assert the spec'd path first and fall back to an explicit bounded `getDiagnostics()` poll only if it lagged (PRD Risk #1), to stay non-flaky.

### Phase 5 implementation decisions (spec silent or contradicted by reality)

- **Generated type defs are committed, not built on the fly.** There is no build step — the bin runs straight from `src/index.ts` — so the `{{types}}` content lives in a checked-in module, `src/lsp-types.generated.ts`, produced by `scripts/generate-types.ts` (`bun run generate:types`). The script runs `tsc --declaration --emitDeclarationOnly` in memory over `src/lsp-api.ts` (per the spec), then extracts the LLM-facing interfaces and the `LspApi` op signatures from the emitted `.d.ts`. A unit test re-runs the generator and diffs against the committed file, so drift fails `bun test` with a "run generate:types" message. `src/lsp-api.ts` remains the single source of truth.

- **Readonly type stripping closes the Phase 4 deferral.** The generated module holds four constants — common interfaces, `WriteResult`, read-op signatures, write-op signatures — and `renderLspTypes(readonly)` in `src/tool-description.ts` assembles them. Under `CODEMODE_READONLY` the write signatures *and* `WriteResult` are absent from the types, completing the sandbox/description/types triple gate. The op-name lists are imported from `sandbox.ts` (now exported), so the sandbox and the generator can never disagree about which ops exist.

- **Per-op one-liners come from source JSDoc; `Position`/`Range` are re-declared statically.** The generator carries the first JSDoc line of each op method (and the property comments inside the interfaces) into the type block — documenting the API surface means editing `lsp-api.ts`, not a template. `Diagnostic.range`'s `Range`/`Position` come from `vscode-languageserver-protocol` in the source, so the emitted d.ts references them by bare name; the generator appends a static two-interface snippet (they are frozen LSP primitives) so the block is self-contained.

- **Worked examples are structured data shared with the golden tests.** `WORKED_EXAMPLES` in `src/tool-description.ts` (3 examples per the spec: exploration, batch refactor, write-then-check) feeds both the description builder and `test/integration/golden-scripts.test.ts`, which runs each example **verbatim** against a temp fixture copy and asserts its concrete outcome (disk content included). An exhaustiveness check fails if an example is added without a golden test. Write examples carry a `writes` flag and are filtered from the readonly description.

- **Diff cap semantics.** "Diffs count toward the result size cap" is implemented as: budget = 50,000 − `result.length`, spent on `changes[].diff` in order. The first overflowing diff is cut at the budget and suffixed with a marker; later diffs become marker-only — but `file` and `kind` always survive, so the change *list* stays complete. The marker tells the model the file WAS written and to `readFile` it if needed (truncation happens after a successful flush, unlike result truncation). Result/log truncation itself (listed under this phase in the build plan) had already landed with the Phase 3 sandbox.

- **Crash recovery test is execute-level.** Phase 1 covered the client primitive; Phase 5 adds the spec'd end-to-end test: `killServer()` between two MCP `execute` calls, second call must succeed via the eager health check with no client-visible error.

### Phase 6 implementation decisions (spec silent or contradicted by reality)

- **The eval agent is headless Claude Code, not a raw API call.** § Testing says the eval "needs an API key"; the project owner runs on a Claude subscription instead, so `scripts/eval.ts` drives `claude -p` (headless Claude Code) per task. To keep the benchmark measuring the tool description rather than Claude Code's built-ins, every native tool (Read/Grep/Glob/Edit/Bash/…) is disabled via `--disallowedTools` and only `mcp__codemode__execute` is allowed (`--strict-mcp-config`, the repo's own server spawned from the task's temp fixture). Trade-off accepted: Claude Code's system prompt is present, making this an end-to-end agent benchmark — which matches the PRD's primary user (the MCP client LLM) more closely than a bare-API harness would.

- **Grading is deterministic and the benchmark self-checks without tokens.** Each of the 15 tasks (`scripts/eval-tasks.ts`) carries a grader — read tasks check the agent's final answer text (word-boundary matching), write tasks check resulting disk state — plus `reference`: the execute scripts a competent model could plausibly write. `test/integration/eval-tasks.test.ts` runs every reference solution against the real server in the normal `bun test` suite and asserts its grader passes, proving each task is solvable with the documented API and each grader accepts a correct solution. The token-spending eval itself stays out of CI per the spec.

- **Post-release hardening from the first real-world session (0.1.1).** Watching a real agent use the published server on a 592-file project surfaced two silent failure modes the fixture eval missed: (a) un-awaited `lsp.*` calls nested in the result serialize as `{}` — the model mis-debugged this for five consecutive scripts; the serializer now walks the result and throws naming the path (`result contains a Promise at "result.files" — did you forget await?`). (b) `listFiles("src")` matches nothing (globs match the full relative path) and a made-up options object as `searchText`'s second argument silently matched nothing; globs are now validated (non-strings throw with the expected signature) and a wildcard-free path naming an existing directory is treated as `dir/**`. Tool-description rules cover both, and a new eval task (`count-src-directory`, 16 total) exercises the bare-directory call deliberately.

- **Field-report fixes, same release.** The agent's own writeup of that session drove four more changes. (a) *Scan reads no longer open documents:* during a transaction, `searchText`'s file scan and `findReferences`' context reads went through `buffer.getText` → `track` → `didOpen`, pulling every scanned file — lockfiles, markdown, SQL — into tsserver as TypeScript documents; a whole-repo search produced ~54k garbage "diagnostics". Incidental reads now use `buffer.peekText` (buffered overlay, no tracking). (b) *Only TS-family files are ever announced to tsserver* (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`): other files are still fully buffered (flush/rollback unchanged) but produce no didOpen/didChange/didClose, and their `WriteResult.diagnostics` is `[]` without burning the 2s wait. `getDiagnostics(file)` on a non-TS file returns `[]` immediately. (c) *Argument validation on every op:* wrong-shape calls previously surfaced raw JS errors (`input.trim is not a function`, ENOENT on a symbol name used as a path); each op now validates its string arguments up front and throws the signature plus a runnable example (`findReferences(file, symbolPath): "symbolPath" must be a non-empty string but got nothing (missing argument). Example: …`). (d) *Doc corrections:* `SymbolInfo.path` is documented as pairing with the same `file` (the report read it as a standalone handle), `searchText` is explicitly a regex with an escaping example, and `findSymbol` documents the lazy index (empty early on; `getSymbols(file)` is exhaustive). The report's product suggestion — a file-qualified symbol handle accepted by every op — is noted as a v2 candidate, not taken now: it changes the whole API surface, and the validation errors + doc pairing close most of the observed confusion.

- **Second field report (post-fix session, same repo).** A re-run with the fixes in place carried 4 of 5 tasks cleanly and confirmed the await-error closes the loop in one attempt ("best error in the set"). Two new findings, both fixed: (a) *silent `undefined` from a block-final expression* — a script ending in `if (…) { refs.map(…) } else { … }` captures nothing (only a top-level trailing expression is the return value); throwing would wrongly roll back writes the script already made, so the result now explains itself in-band: `undefined — note: the script's last statement is an if statement, which produces no capturable value…`. A top-level `return` (including from inside a final block) still wins, and a genuinely-undefined trailing expression stays a plain `undefined`. (b) *clients truncate long tool descriptions* — the agent received the description cut mid-interface and lost the op signatures, examples, and rules entirely (it spent a call on `Object.keys(lsp)` and probed signatures). The description is reordered for truncation resilience: purpose → rules → `lsp` op signatures → interfaces → write semantics → examples, asserted by a unit test, with new rules covering whole-workspace search scope and the zero-based `Diagnostic.range`.

- **Self-serve docs: `lsp.help()` (0.1.3).** Reordering wasn't enough — a third field session still saw the description truncated and spent its first invocation probing signatures. Two-part fix: (a) the description's first three lines now name every op (read + write inventory, built from `READ_OP_NAMES`/`WRITE_OP_NAMES`) and advertise the escape hatch, so any truncation point leaves the agent knowing the full surface and how to recover the rest; (b) the sandbox exposes `lsp.help()`, an untraced meta-op returning the complete tool description (the server passes it via `SandboxOptions.helpText`; readonly mode serves the readonly variant). Same session also exposed two doc gaps now fixed in the JSDoc/rules: `goToDefinition` only addresses symbols *defined* in the given file (imports/callees in a body aren't addressable — the cross-file resolver is `findSymbol`), and `findSymbol` substring-matches, so callers should filter for an exact `name`.

- **Call hierarchy + reference fidelity (0.2.0).** Two independent field sessions built call-graph tracers by hand and hit the same wall: `findReferences` returns *references* (calls mixed with imports, re-exports, type mentions), and the enclosing-symbol attribution pointed at the nearest *binding* (`fn/result`) rather than the nearest *function*. The session's own diagnosis became the design rule: *any time the model is string-matching the output of a semantic tool, a richer return type is missing.* Fixes: (a) `incomingCalls`/`outgoingCalls` (LSP `callHierarchy/*`, client capability advertised) return only true calls as `CallInfo { file, symbolPath, name, kind, callSites }` — anonymous-callback callers are mapped through the addressable symbol tree to the nearest named handle, callees resolve across modules, out-of-workspace targets (lib.d.ts, node_modules) are filtered, duplicate tsserver ranges deduped; (b) `Reference.symbolPath` now reports the nearest enclosing function/method via `containingFunctionPath` (falls back to the deepest symbol when nothing function-like encloses). Also from the same audit session: results that blow the 50k cap are a wasted round trip — the Rules now state up front to aggregate inside the script and return summaries, never raw inventories.

- **0.2.0 field validation + module-level attribution fix (0.2.1).** The split-planning session ran the call-hierarchy ops in anger: 23 `findReferences` hits vs 17 true call sites from `incomingCalls` (the gap was exactly 5 import lines + 1 declaration), with correct enclosing-function attribution for every named caller — zero errors across 6 invocations. One contract violation found and fixed: calls at module top level (bare `test(...)` blocks) made tsserver return the source FILE as the hierarchy item, leaking a filename into `CallInfo.symbolPath` where it cannot round-trip; it is now `""` (the `Reference` top-level convention). The session's vote for the next primitive: a *symbol dependencies* op (`outgoingCalls` plus non-call references — imported bindings, type refs) so a module split can compute each moved symbol's import rewiring instead of eyeballing the import header. Recorded as the leading v2 candidate alongside the file-qualified handle.

- **Symbol dependencies + positioning (0.3.0).** The split-planning session's publishability verdict named one gap as the difference between "neat" and "default tool": no way to ask what a symbol's body references besides calls, so import rewiring for a module split stayed manual. `getDependencies(file, symbolPath)` closes it — a pure TypeScript-AST analysis (no checker) in `src/dependencies.ts` that intersects the identifiers used inside the symbol's range with the file's import bindings (module specifier + type-only flag, including element-level `{ type X }`) and same-file top-level symbol names. Property-access right-hand sides and declaration names don't count as uses; the symbol's own top-level ancestor is excluded so recursion isn't a dependency; results are sorted. Known limitation, documented in the op JSDoc: it's syntactic, so a local shadowing an import can produce a false positive. The same verdict drove repositioning: the tool description, README, and package description now lead with the use case (codebase-wide intelligence + verified refactors; plain reads are cheaper for single-file peeks) instead of the mechanism. Also pinned by test after the report claimed otherwise: `Date.now()`/`Math.random()` work fine in the sandbox (the report confused it with another harness's script environment).

- **Distribution is a built `dist/`, not the TS sources.** The bin must run under `npx`/`bunx` on machines without Bun, so `prepublishOnly` runs `bun build src/index.ts --target=node` and the package ships `dist/` only (`bin` → `dist/index.js`, engines node ≥18). `typescript-language-server` and `typescript` moved from devDependencies to dependencies; the client resolves the language server from its own installed dependency (`createRequire` → `lib/cli.mjs`, run via the current runtime) instead of relying on PATH, and passes the bundled `tsserver.js` as `tsserver.fallbackPath` so workspaces without a local typescript install still work (a workspace install takes precedence). `CODEMODE_LSP_BIN` still overrides everything.

- **Created-file path-alias false positives (0.3.1 → 0.3.2).** Field report: a correct four-file module split was rolled back by the script's own verify gate over six "Cannot find module '@/…'" errors — all on the newly created file, all spurious. Root cause: a buffered created file doesn't exist on disk, so tsserver checks it in the *inferred* project where tsconfig `paths` don't apply; aliases resolve only after the script succeeds and the file flushes. Fix in 0.3.1 was two-sided: such diagnostics get an in-band "[likely a FALSE POSITIVE …]" tag (`LspApi.convertDiagnosticsForUri`, gated on `buffer.isPendingCreation`), and `flush()` bounces created files (didClose/didOpen) so they join the configured project and post-flush diagnostics tell the truth. The re-run proved the tag fires but prose isn't machine-checkable — the agent's gate tested `severity === "error"` and rolled back anyway, then succeeded by splitting write and verify into separate calls. 0.3.2 makes the classification structural: `Diagnostic.likelyFalsePositive?: boolean`, with the Rules prescribing the gate (`d.severity === "error" && !d.likelyFalsePositive`) and the two-call pattern for strict verify-or-rollback (write in one script so it flushes; check and restore in a follow-up).

- **0.4.0: checkProject, moveSymbol, import hygiene, getSymbols depth.** All four driven by the third extraction field run (the one that validated 0.3.1's tag but exposed that prose isn't machine-checkable). (a) `checkProject()` — the *cure* for the created-file alias problem rather than 0.3.2's band-aid: an in-process `ts.createProgram` (src/project-check.ts) whose compiler host reads through `buffer.overlay()`, so created files are checked at their real paths under the real tsconfig; aliases resolve in-transaction, real errors still surface (verified by test: a correct aliased import in a created file is clean while a bad named import in another created file is caught). Returns `{ ok, errorCount, checkedFileCount, diagnostics≤50 }`. (b) `moveSymbol(file, symbolPath, targetFile)` — the report's "I hand-rolled line-range surgery, which is exactly the error-prone part it could have owned" is the second independent vote, clearing the primitive bar. tsserver's interactive "Move to file" is not served by typescript-language-server (spike: only "Move to a new file" with a server-chosen name, via an unresolvable command), so it is composed from our own machinery (src/move-symbol.ts, pure + unit-tested): expandDeletionRange brings the JSDoc, getDependencies computes the target's import header deterministically (relative specifiers re-anchored, type-only flags preserved, same-file deps classified type-vs-value by AST), importers are repointed alias-aware (tsconfig paths, single-star patterns) with shared import declarations split, the source gets a back-import when it still uses the symbol, stayed-behind private deps are auto-exported (reported in `autoExported`), and the source's orphaned imports are pruned natively. (c) `organizeImports`/`addMissingImports` — TLS serves `source.removeUnusedImports.ts`/`source.organizeImports.ts`/`source.addMissingImports.ts` as code actions with inline WorkspaceEdits (client now advertises codeActionLiteralSupport); organizeImports chains remove-unused before sort/merge because tsserver's plain organizeImports is non-destructive; a brief retry absorbs auto-import index warm-up. (d) `getSymbols(file, depth)` — the report's "output bloat" complaint; depth 1 = top-level outline. Worked example "Move a symbol and verify the project" added as a golden script.

- **0.4.2: batch moves, import dedupe, 60s timeout (fourth field run, non-Claude agent).** First cross-client validation: a Cursor model ran the same extraction on 0.4.0, succeeded on call 4 with a clean 4-file split, and filed three blockers — two of them tool bugs. (a) *Duplicate identifier on sequential moves to one target:* moveSymbol's constructed header never deduped against what the target already imported, so two moved functions sharing a dependency imported it twice; the agent's per-move gate correctly aborted a correct refactor. Fixed deterministically: the header now skips names already bound in the target (`importBindingNames`), and a pre-existing import OF the moved symbol from the source module is stripped (`removeImportOfName`) so the arriving definition can't collide. (b) *30s timeout killed a finished refactor:* seven legitimate moves plus per-move cleanups exceeded the budget mid-`addMissingImports`; default timeout is now 60s, the source-action warm-up retry is capped at 3 (each retry compounds a whole-project auto-import scan), and — the structural fix — `moveSymbols(file, paths[], targetFile)` moves a cluster in one pass with cleanups and diagnostics ONCE per batch instead of per symbol. The field agent requested exactly this op; its other request, a cluster-discovery op, is declined per the standing rule (cluster membership is judgment, which stays in scripts; the mechanics are the primitive). (c) *Doc gaps now rules:* call hierarchy is callable-only (the first failed call burned on a type alias — the error message produced an instant self-fix, but the rule now pre-empts it), and a "keep mutating scripts lean" rule encodes the agent's winning pattern: discovery call, then writes + one final checkProject — no per-move diagnostics, no baseline check.

- **0.4.2 field validation: one-shot convergence.** Fifth run of the same extraction prompt (cursor composer-2.5-fast, cold session): full dynamic cluster discovery, seven sequential moveSymbol calls, organize/add-missing imports, and checkProject — in ONE invocation, ~48s, 0 errors across 682 checked files, correct cluster including the exclusively-used helper. Both 0.4.2 fixes were load-bearing: the run used the exact sequential-move pattern that previously produced "Duplicate identifier" (the header dedupe absorbed it silently), and it would have died at the old 30s timeout. Trajectory across the loop: run 1–2 hand-rolled splices with a wrongly-rolled-back correct refactor; run 4 needed four calls; run 5 is one shot. The same task that motivated moveSymbol/checkProject is now solved by a non-Claude model on the first attempt.
