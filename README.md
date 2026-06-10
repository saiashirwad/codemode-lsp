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

It shines on **codebase-wide** work that grep-based agents get subtly wrong:
impact analysis, call graphs, usage audits, and atomic multi-file refactors.
Names are *resolved*, not text-matched. Writes are transactional — nothing
hits disk unless the whole script succeeds, and successful writes come back as
reviewable unified diffs.

## Setup

No install step — the package bundles its own `typescript-language-server`.
The workspace root is the directory the server is spawned from:

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

Add `"env": { "CODEMODE_READONLY": "1" }` to try it on a repo it physically
cannot write to.

## Operations

| | |
| --- | --- |
| read | `readFile`, `getSymbols` (pass `1` as depth for top level only), `getSymbolBody`, `findSymbol`, `findReferences`, `goToDefinition`, `incomingCalls`, `outgoingCalls` (true calls only), `getDependencies` (what a symbol's body needs from outside itself), `searchText`, `listFiles`, `getDiagnostics` |
| verify | `checkProject` — whole-project type check over the *buffered* state; path aliases resolve even in files created mid-script |
| write | `moveSymbol` (full move: imports computed, importers repointed, source pruned), `organizeImports`, `addMissingImports`, `renameSymbol`, `replaceSymbolBody`, `insertBeforeSymbol`, `insertAfterSymbol`, `deleteSymbol`, `writeFile`, `deleteFile` |

The tool returns `{ result, logs, changes }`. Symbols are addressed as
`(file, "MyClass/myMethod")` pairs discovered via `getSymbols`. Full type
definitions are embedded in the tool description (generated from source); if a
client truncates it, `await lsp.help()` returns the complete reference.

See `PRD.md` for the complete spec and decision log.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEMODE_TIMEOUT_MS` | `30000` | Script timeout |
| `CODEMODE_LSP_BIN` | bundled server | Language server command |
| `CODEMODE_READONLY` | unset | `1`/`true` removes the write ops entirely |

## Limitations

- TypeScript/JavaScript only (the architecture is language-agnostic).
- Per-file diagnostics cover session-touched files; `checkProject()` is the
  whole-project check. On files created mid-script, per-file "Cannot find
  module" alias errors are tagged `likelyFalsePositive: true` —
  `checkProject()` has no such false positives.
- `getDependencies` is syntactic; `moveSymbol` moves top-level symbols only.
- `Reference.isWriteAccess` is always `false` (not exposed over standard LSP).

## Development

```sh
bun run check           # typecheck + lint + all tests — run before declaring done
bun run generate:types  # regenerate src/lsp-types.generated.ts after API changes
bun run eval            # LLM benchmark: headless Claude Code, execute tool only
```

The tool description's worked examples run verbatim as golden tests, and every
eval task's reference solution runs in the normal suite — neither can rot.
