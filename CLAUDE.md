MCP server providing semantic code retrieval and editing via LSP. For claude code and other MCP-capable agents.

## Decisions

- **Runtime**: Bun + TypeScript
- **MCP**: `@modelcontextprotocol/sdk`, stdio transport
- **LSP**: Direct client implementation (no multilspy). Spawn language servers as child processes, JSON-RPC over stdio.
- **No sandbox**: We're a tool server, not a code executor. Code-mode (cloudflare) is a client-side concern.
- **Keep it simple**: ~8 core tools, no onboarding/memory/thinking/dashboard like Serena has.

## Tools

- `find_symbol` — workspace symbol search
- `find_references` — all references to a symbol
- `get_symbols` — document symbols (file outline)
- `go_to_definition` — jump to definition
- `rename_symbol` — LSP rename across codebase
- `replace_symbol_body` — replace a symbol's code
- `insert_before_symbol` / `insert_after_symbol` — symbol-relative insertion

## Modules

- `mcp-server.ts` — MCP server setup, tool registration, stdio transport
- `lsp-client.ts` — spawn language server, JSON-RPC with Content-Length framing, init handshake
- `lsp-manager.ts` — manage multiple language servers (one per language), auto-detect from file extensions
- `tools/` — tool implementations, each wraps LSP call(s) + formats result
- `symbol.ts` — symbol resolution (name-path matching like Serena's `Class/method` pattern → LSP positions)

## Reference repos

- cloudflare/agents: `/tmp/cloudflare-agents`
  - code-mode package: `packages/codemode/`
  - code-mode docs: `docs/codemode.md`
- serena: `/tmp/serena` (Python, LSP-backed MCP server, ~49 tools, uses multilspy)
