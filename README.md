# codemode-lsp

Semantic code intelligence and refactoring for TypeScript/JavaScript agents:
an MCP server exposing a **single `execute` tool** backed by the language
server. The LLM writes one JavaScript script that chains semantic operations
(`lsp.*`) — filtering, looping, and aggregating in code instead of across many
tool-call round trips:

```javascript
const refs = await lsp.findReferences("src/api.ts", "handleRequest");
const relevant = refs.filter((r) => r.context.includes("deprecated"));
for (const ref of relevant) {
  await lsp.replaceSymbolBody(ref.file, ref.symbolPath, newImpl);
}
({ modified: relevant.length });
```

It shines on **codebase-wide** work that grep-based agents reconstruct by hand
and get subtly wrong: impact analysis ("what breaks if I change X"), call
graphs, usage audits, refactor planning, and atomic multi-file edits. Names
are *resolved*, not text-matched, and a whole analysis runs in one round trip.
For a single-file lookup, an agent's plain file reads are cheaper — this is
the tool to reach for when the answer spans files.

Writes are transactional: nothing hits disk unless the whole script succeeds.
If it throws, every buffered write rolls back and the tool returns an
operation trace showing exactly where the script died. Successful writes come
back as reviewable unified diffs.

v1 targets TypeScript/JavaScript via `typescript-language-server`.

## Setup

No install step — the package bundles its own `typescript-language-server`,
so `npx`/`bunx` is all it takes. The workspace root is the directory the
server is spawned from (Claude Code spawns project-level `.mcp.json` servers
from the project directory):

```json
{
  "mcpServers": {
    "codemode-lsp": {
      "command": "npx",
      "args": ["-y", "codemode-lsp"]
    }
  }
}
```

(`"command": "bunx"` with `"args": ["codemode-lsp"]` works too.)

To try it on a repo it physically cannot write to:

```json
      "env": { "CODEMODE_READONLY": "1" }
```

Running from a clone instead: requires [Bun](https://bun.sh) — `bun install`,
then `"command": "bun"`, `"args": ["run", "/absolute/path/to/codemode-lsp/src/index.ts"]`.

## The `execute` tool

Accepts JavaScript, runs it in a `vm` sandbox where `lsp.*` is available, and
returns `{ result, logs, changes }`:

- **result** — the script's last expression (JSON-serialized, capped at 50k chars)
- **logs** — captured `console.log/warn/error` output
- **changes** — every file that hit disk, as `{ file, kind, diff }` with a
  unified diff against the pre-script content; empty for read-only scripts

**Read ops (12):**

| | |
| --- | --- |
| `readFile`, `getSymbols`, `getSymbolBody` | file contents, outline (`getSymbols(file, 1)` for top level only), one symbol's source |
| `findSymbol`, `findReferences`, `goToDefinition` | workspace symbol search, all references, definition |
| `incomingCalls`, `outgoingCalls` | call hierarchy — true calls only, attributed to the enclosing function, resolved across modules (`findReferences` mixes calls with imports and re-exports) |
| `getDependencies` | what a symbol's body needs from outside itself: used imports (module + type-only flag) and same-file helpers — makes moving a symbol a computation, not an eyeballing exercise |
| `checkProject` | whole-project type check over the *buffered* state — the verify gate for multi-file refactors; tsconfig path aliases resolve even in files created mid-script |
| `searchText`, `listFiles` | regex search and glob listing (`.gitignore`-aware) |

**Write ops (10):**

| | |
| --- | --- |
| `moveSymbol` | move a top-level symbol to another file end to end: the target's import header is computed from the dependency analysis, importers are repointed (alias-aware, shared declarations split), the source gets a back-import if it still uses the symbol, and its now-unused imports are pruned |
| `organizeImports`, `addMissingImports` | native tsserver import hygiene: drop-unused + sort/merge, and auto-import every unresolved name |
| `renameSymbol`, `replaceSymbolBody`, `insertBeforeSymbol`, `insertAfterSymbol`, `deleteSymbol` | symbol-level edits |
| `writeFile`, `deleteFile` | whole-file escape hatches |

All buffered, flushed atomically, each returning fresh diagnostics for the
files it touched. Plus `getDiagnostics` for type errors on session-touched
files.

Symbols are addressed by slash-separated paths (`MyClass/myMethod`) discovered
via `getSymbols`. The full type definitions are embedded in the tool
description, generated straight from the source (`bun run generate:types`).
If a client truncates the description, the script `await lsp.help()` returns
the complete reference — the description's first lines advertise this, so an
agent can always recover the full API without probing.

See `PRD.md` for the complete spec.

## Configuration

No config file. Three environment variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEMODE_TIMEOUT_MS` | `30000` | Script timeout |
| `CODEMODE_LSP_BIN` | bundled `typescript-language-server` | Language server command |
| `CODEMODE_READONLY` | unset | `1`/`true` removes the write ops from the sandbox, the type defs, and the tool description |

Workspace root = the server's cwd. Paths resolving outside it are rejected,
reads and writes alike.

## Limitations

- TypeScript/JavaScript only (the architecture is language-agnostic; more
  servers later).
- Per-file diagnostics cover files touched in the session, not the whole
  project — `tsserver` only publishes for opened files. `checkProject()` is
  the whole-project check.
- A synchronous infinite loop (`while (true) {}`) is not interrupted by the
  script timeout; async work is.
- `Reference.isWriteAccess` is always `false` (not exposed over standard LSP).
- `getDependencies` is syntactic — a local variable shadowing an import can
  produce a false positive.
- A file created mid-script reports spurious per-file "Cannot find module"
  errors for tsconfig path aliases until it is flushed to disk; those
  diagnostics carry `likelyFalsePositive: true` so verification gates can skip
  them. `checkProject()` has no such false positives — it resolves aliases
  over the buffered state.
- `moveSymbol` moves top-level symbols only, and same-file dependencies it
  leaves behind are auto-exported when the moved body needs them (reported in
  `autoExported`).

## Eval

`bun run eval` measures the project's core success criterion: can an LLM,
given only the tool description, write correct scripts? It runs 16 benchmark
tasks (exploration, reference-finding, diagnostics, renames, multi-file
refactors) against a throwaway copy of the fixture project. The agent is
headless Claude Code (`claude -p`, billed to your Claude subscription — no API
key) with every built-in tool disabled, so the only way to solve a task is the
`execute` tool. Sonnet by default (pinned so pass rates are comparable across
runs); override with `--model`. Grading is deterministic: read tasks are
scored on the final answer, write tasks on the resulting disk state.

Each task ships with a reference solution that runs against the real server as
part of `bun test`, so the benchmark itself can never rot. The eval runs on
demand, never in CI.

Last measured: **15/15 (100%)** — headless Claude Code (Fable 5), 2026-06-10,
before the 16th task was added.

## Development

```sh
bun run check           # typecheck + lint + all tests — run before declaring done
bun test                # all tests (integration tests run the real language server)
bun run generate:types  # regenerate src/lsp-types.generated.ts after API changes
bun run eval            # LLM benchmark (on demand; needs the claude CLI)
```

The worked examples in the tool description run verbatim as golden tests
(`test/integration/golden-scripts.test.ts`), so the documentation cannot rot.
