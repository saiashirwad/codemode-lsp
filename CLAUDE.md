MCP server exposing a single code-mode tool backed by LSP. The LLM writes TypeScript that chains semantic code operations, executed in a vm sandbox.

See `PRD.md` for full design and architecture.

## Reference repos

- cloudflare/agents: `/tmp/cloudflare-agents`
  - code-mode package: `packages/codemode/`
  - code-mode docs: `docs/codemode.md`
- serena: `/tmp/serena` (Python, LSP-backed MCP server, ~49 tools, uses multilspy)
