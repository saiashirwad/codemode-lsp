# codemode-lsp PRD

MCP server providing semantic code retrieval and editing via LSP. For claude code, code-mode (cloudflare), and other MCP-capable agents.

## Core Philosophy

Tools are **composable primitives for programmatic use**. Code-mode agents write TypeScript that calls these tools, filters results, and chains operations. Design for machine consumption first — return full data, let code filter.

## Architecture Decisions

### Runtime & Transport

- **Runtime**: Bun + TypeScript
- **MCP**: `@modelcontextprotocol/sdk`, stdio transport
- **LSP**: Direct JSON-RPC client over stdio. Spawn language servers as child processes.

### Workspace

- Auto-detect workspace root from server's cwd — walk up to find `.git`, `package.json`, etc.
- No explicit init step required from client.

### Language Servers (v1)

- **TypeScript**: `typescript-language-server`
- **Python**: `pyright`
- Auto-detect language from file extensions. One server instance per language.

### Concurrency

- **Read tools** (find_symbol, find_references, get_symbols, go_to_definition): concurrent, safe to parallelize.
- **Write tools** (rename_symbol, replace_symbol_body, insert_before/after): serialized via mutex. Second writer waits.

### Document Sync

- `textDocument/didOpen` on first access to a file.
- `textDocument/didChange` after our own edits so LSP index reflects truth.
- `workspace/didChangeWatchedFiles` for external filesystem changes.
- `textDocument/didClose` on idle timeout to prevent memory bloat on large codebases.

### Staleness

- Server watches filesystem and sends `didChangeWatchedFiles` to LSP for external changes.
- After own edits, always send `didChange` before returning — ensures next tool call sees updated state.

### LSP Crash Recovery

- Auto-restart crashed/unresponsive language server transparently.
- Replay `didOpen` for all previously-open documents to restore state.
- Failed call returns error so the agent knows something happened, but recovery is automatic for subsequent calls.

### Edit Application

- Server writes edits directly to disk (not diffs for client to apply).

## Tools

### Read Tools

#### `find_symbol`

Workspace symbol search. Returns all matching symbols across the project.

- Input: `query` (string), `format?` ('json' | 'text')
- Returns: symbol name, kind, location (file, range), container name

#### `find_references`

All references to a symbol.

- Input: `file` (string), `symbol_path` (string), `format?` ('json' | 'text')
- Returns: all reference locations (file, range, context line)

#### `get_symbols`

Document symbols — file outline / symbol tree.

- Input: `file` (string), `format?` ('json' | 'text')
- Returns: hierarchical symbol tree (name, kind, range, children)

#### `go_to_definition`

Jump to where a symbol is defined.

- Input: `file` (string), `symbol_path` (string), `format?` ('json' | 'text')
- Returns: definition location (file, range, preview)

### Write Tools

#### `rename_symbol`

LSP rename across the entire codebase.

- Input: `file` (string), `symbol_path` (string), `new_name` (string)
- Writes all affected files to disk. Returns list of changed files.

#### `replace_symbol_body`

Replace a symbol's **full declaration** — signature, body, decorators, JSDoc. Everything.

- Input: `file` (string), `symbol_path` (string), `new_text` (string)
- Writes to disk. Returns the file path and replaced range.

#### `insert_before_symbol` / `insert_after_symbol`

Insert code relative to a symbol.

- Input: `file` (string), `symbol_path` (string), `text` (string)
- **Indentation**: Server detects target symbol's base indentation. Agent provides code starting at column 0 with relative indentation. Server applies base indent.
- Writes to disk. Returns the file path and inserted range.

## Symbol Path Resolution

Slash-separated, unlimited nesting depth. Walks the document symbol tree.

```
"MyClass"                    → top-level class
"MyClass/constructor"        → class constructor
"MyClass/myMethod"           → class method
"OuterClass/InnerClass/method" → deeply nested
"myFunction"                 → top-level function
"config"                     → variable (arrow fns use their variable name)
"router/get"                 → object literal property
```

Ambiguity: if a bare name matches multiple symbols, server returns candidates for the agent to disambiguate.

## Result Format

Content-type negotiation per-call via `format` parameter:

- **`json`** (default): Structured objects with URIs, ranges, symbol kinds. For programmatic consumption by code-mode scripts.
- **`text`**: Human/LLM-readable summaries with `file:line` references and code snippets. For direct agent consumption.

All results returned in full — no pagination, no truncation. Code-mode scripts handle filtering.

## Modules

- `mcp-server.ts` — MCP server setup, tool registration, stdio transport
- `lsp-client.ts` — spawn language server, JSON-RPC with Content-Length framing, init handshake, crash recovery
- `lsp-manager.ts` — manage multiple language servers (one per language), auto-detect from file extensions, idle timeout
- `tools/` — tool implementations, each wraps LSP call(s) + formats result
- `symbol.ts` — symbol path resolution (slash-separated path → LSP positions via document symbols)

## Open Questions

_To be filled as interview continues._
