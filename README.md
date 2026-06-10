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

Requires [Bun](https://bun.sh). From a clone:

```sh
bun install
```

Then add the server to your MCP client. The workspace root is the directory the
server is spawned from, so for a project-level `.mcp.json` (Claude Code spawns
servers from the project directory):

```json
{
  "mcpServers": {
    "codemode-lsp": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/codemode-lsp/src/index.ts"]
    }
  }
}
```

To try it on a repo it physically cannot write to, add:

```json
      "env": { "CODEMODE_READONLY": "1" }
```

(Publishing so `bunx codemode-lsp` works from a clean machine is planned —
PRD build-plan phase 6.)

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

## Development

```sh
bun run check        # typecheck + lint + all tests — run before declaring done
bun test             # all tests (integration tests run the real language server)
bun run generate:types  # regenerate src/lsp-types.generated.ts after API changes
```

The worked examples in the tool description run verbatim as golden tests
(`test/integration/golden-scripts.test.ts`), so the documentation cannot rot.
