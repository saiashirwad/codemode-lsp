MCP server exposing a single code-mode tool backed by LSP. The LLM writes TypeScript that chains semantic code operations, executed in a vm sandbox.

See `PRD.md` for the full spec — it is the document of record (VISION.md and api-surface-review.md are superseded working docs). The PRD ends with the build plan; check git log to see which phase is in progress.

## Commands

- `bun run check` — typecheck + lint + all tests. **Run this before declaring any task done.**
- `bun test` — all tests; `bun test test/unit` / `bun test test/integration` for subsets
- `bun test --watch <file>` — fast iteration on one test file
- `bun run typecheck` / `bun run lint` — individual gates
- `bun run fix` — auto-fix lint + formatting (run instead of hand-fixing style)

## Repo layout

- `src/` — implementation (modules defined in PRD.md § Modules)
- `test/unit/` — pure-logic tests (symbol path parsing, normalization, buffer state machine)
- `test/integration/` — tests against the real typescript-language-server
- `test/fixtures/sample/` — the shared fixture TS project. Excluded from root typecheck/lint. `src/broken.ts` has an intentional type error for diagnostics tests — never "fix" it.
- `test/helpers/fixture.ts` — fixture paths, `tempFixture()` for tests that write to disk, `lspBin` path

## Conventions & gotchas

- **Everything is hermetic**: `typescript-language-server` and `typescript` are devDependencies. Always spawn the server via `lspBin` from `test/helpers/fixture.ts`, never a global binary. Fresh clone setup is just `bun install`.
- Tests that write to disk must use `tempFixture()` (copies the fixture to a temp dir) — never mutate `test/fixtures/sample/` in place.
- LSP integration tests need generous timeouts (server init takes seconds) — pass `{ timeout: 30_000 }` to the test.
- Bun runtime, but no Bun-specific APIs in `src/` — code must also run on Node. Bun APIs are fine in tests/scripts.
- Use `vscode-jsonrpc` for LSP framing; never hand-roll Content-Length parsing.
- `test/integration/lsp-smoke.test.ts` is the canary — if it fails, the environment is broken, not your change.

## Working style

- Each PRD build-plan phase lands with its tests; integration tests against the real server are the core suite.
- Sandbox-facing error messages target LLMs: include available alternatives in the message (see PRD § Symbol Path Resolution).
