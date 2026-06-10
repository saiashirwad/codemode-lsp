# codemode-lsp

An MCP server exposing a **single `execute` tool** backed by LSP. The LLM
writes JavaScript that chains semantic code operations (`lsp.*`), executed in a
sandbox with transactional write semantics.

LLMs are better at writing code than orchestrating tool calls. Instead of
filtering, looping, and branching in natural language across many round-trips,
the model writes one script:

```javascript
const refs = await lsp.findReferences("src/api.ts", "handleRequest");
const relevant = refs.filter((r) => r.context.includes("deprecated"));
for (const ref of relevant) {
  await lsp.replaceSymbolBody(ref.file, ref.symbolPath, newImpl);
}
({ modified: relevant.length });
```

One round-trip. Nothing hits disk unless the whole script succeeds; if it
throws, every buffered write rolls back and the tool returns an operation trace
showing exactly where the script died. Successful writes come back as
reviewable unified diffs.

v1 targets TypeScript projects via `typescript-language-server`.

## Setup

Add the server to your MCP client — no install step needed. The package bundles
its own `typescript-language-server`, so `npx`/`bunx` is all it takes. The
workspace root is the directory the server is spawned from, so for a
project-level `.mcp.json` (Claude Code spawns servers from the project
directory):

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

To try it on a repo it physically cannot write to, add:

```json
      "env": { "CODEMODE_READONLY": "1" }
```

Running from a clone instead: requires [Bun](https://bun.sh) — `bun install`,
then use `"command": "bun"`, `"args": ["run", "/absolute/path/to/codemode-lsp/src/index.ts"]`.

## The `execute` tool

Accepts JavaScript, runs it in a `vm` sandbox where `lsp.*` is available, and
returns `{ result, logs, changes }`:

- **result** — what the script's last expression evaluates to (JSON-serialized,
  capped at 50k chars).
- **logs** — captured `console.log/warn/error` output.
- **changes** — every file that hit disk, as `{ file, kind, diff }` with a
  unified diff against the pre-script content. Empty for read-only scripts.

The API surface is 16 functions plus `getDiagnostics`: 8 read ops (`readFile`,
`getSymbolBody`, `getSymbols`, `findSymbol`, `findReferences`,
`goToDefinition`, `searchText`, `listFiles`) and 7 write ops (`renameSymbol`,
`replaceSymbolBody`, `insertBeforeSymbol`, `insertAfterSymbol`,
`deleteSymbol`, `writeFile`, `deleteFile`). Symbols are addressed by
slash-separated paths (`MyClass/myMethod`) discovered via `getSymbols`. The
full type definitions are embedded in the tool description, generated straight
from the source (`bun run generate:types`).

See `PRD.md` for the complete spec.

## Configuration

No config file. Three environment variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEMODE_TIMEOUT_MS` | `30000` | Script timeout |
| `CODEMODE_LSP_BIN` | `typescript-language-server` | Language server command |
| `CODEMODE_READONLY` | unset | `1`/`true` removes the 7 write ops from the sandbox, the type defs, and the tool description |

Workspace root = the server's cwd. Paths resolving outside it are rejected,
reads and writes alike.

## Limitations (v1)

- TypeScript only (the architecture is language-agnostic; more servers later).
- Diagnostics cover files touched in the session, not the whole project —
  `tsserver` only publishes for opened files.
- A synchronous infinite loop (`while (true) {}`) is not interrupted by the
  script timeout; async work is.
- `Reference.isWriteAccess` is always `false` (not exposed over standard LSP).

## Eval

`bun run eval` measures the project's core success criterion: can an LLM, given
only the tool description, write correct scripts? It runs 15 benchmark tasks
(exploration, reference-finding, diagnostics, renames, multi-file refactors)
against a throwaway copy of the fixture project. The agent is headless Claude
Code (`claude -p`, billed to your Claude subscription — no API key) with every
built-in tool disabled, so the only way to solve a task is the `execute` tool.
It runs on Sonnet by default (pinned so pass rates are comparable);
`--model opus` etc. overrides.
Grading is deterministic: read tasks are scored on the final answer, write
tasks on the resulting disk state.

Each task ships with a reference solution that runs against the real server as
part of `bun test`, so the benchmark itself can never rot. The eval is run on
demand, never in CI.

Current pass rate: **15/15 (100%)** — headless Claude Code (Fable 5), 2026-06-10.

## Development

```sh
bun run check        # typecheck + lint + all tests — run before declaring done
bun test             # all tests (integration tests run the real language server)
bun run generate:types  # regenerate src/lsp-types.generated.ts after API changes
bun run eval         # LLM benchmark (on demand; needs the claude CLI)
```

The worked examples in the tool description run verbatim as golden tests
(`test/integration/golden-scripts.test.ts`), so the documentation cannot rot.
