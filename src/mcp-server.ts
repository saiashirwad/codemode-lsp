import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { LspApi } from "./lsp-api";
import { LspClient } from "./lsp-client";
import { DEFAULT_TIMEOUT_MS, runSandbox, SandboxError } from "./sandbox";

/** A single flushed change. Always empty in Phase 3 (writes land in Phase 4). */
export interface Change {
  file: string;
  kind: "modified" | "created" | "deleted";
  diff: string;
}

export interface ExecuteResult {
  result: string;
  logs: string;
  changes: Change[];
}

const TOOL_DESCRIPTION = `Execute JavaScript to perform semantic code operations via LSP.

Write a script that chains \`lsp.*\` calls (e.g. \`await lsp.getSymbols("src/api.ts")\`).
The script runs in a sandbox with \`lsp.*\`, \`console.log/warn/error\` (captured), and
\`path.join/basename/dirname/extname\`. Returns { result, logs, changes }.

Read operations available: readFile, getSymbolBody, getSymbols, findSymbol,
findReferences, goToDefinition, searchText, listFiles, getDiagnostics.

Important:
- The last expression in the script is the return value. End with the value you
  want back (e.g. \`({ files: files.length })\`), not just side effects.
- Symbol paths use \`/\`: \`MyClass/myMethod\`. Use \`getSymbols(file)\` to discover the
  exact paths — never guess them.
- \`.filter()\`/\`.map()\` callbacks cannot be async; use \`for...of\` with \`await\`.
- File paths are relative to the workspace root; paths outside it are rejected.`;

export interface ExecuteToolDeps {
  api: LspApi;
  client: LspClient;
  timeoutMs: number;
  /** Resolves once the server has warmed up; awaited before the first execute. */
  warmup: Promise<void>;
}

/**
 * The core of the `execute` tool, extracted so tests can drive it without the MCP
 * transport. Serializes all calls through a mutex, runs an eager health check,
 * and waits for warmup before the first execution.
 */
export function createExecuteRunner(deps: ExecuteToolDeps): {
  execute: (code: string) => Promise<ExecuteResult>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  let warmedUp = false;

  const execute = (code: string): Promise<ExecuteResult> => {
    // Async mutex: chain every call so they run strictly serially. Concurrent
    // scripts would corrupt shared LSP state (PRD § Concurrency).
    const run = queue.then(async () => {
      try {
        if (!warmedUp) {
          await deps.warmup;
          warmedUp = true;
        }
        // Eager health check: a dead server is respawned + re-handshaked here,
        // before any lsp.* call (PRD § Crash recovery). Kept inside the try so a
        // spawn/crash failure becomes a normalized LLM-readable payload rather
        // than a raw MCP protocol error.
        await deps.client.ensureAlive();

        const { result, logs } = await runSandbox(code, {
          lsp: deps.api,
          timeoutMs: deps.timeoutMs,
        });
        // changes is always [] in Phase 3 — write ops are Phase 4.
        return { result, logs, changes: [] as Change[] };
      } catch (error) {
        if (error instanceof SandboxError) {
          const { failure } = error;
          // Surface the operation trace alongside the error so the model sees
          // exactly where the script died and what had completed (PRD § Errors).
          const message = failure.trace
            ? `${failure.error}\n\n${failure.trace}`
            : failure.error;
          return {
            result: message,
            logs: failure.logs,
            changes: [] as Change[],
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { result: message, logs: "", changes: [] as Change[] };
      }
    });
    // Keep the queue chained even if this run rejects (it shouldn't — runSandbox
    // failures are caught above — but stay defensive so the mutex never wedges).
    queue = run.catch(() => undefined);
    return run;
  };

  return { execute };
}

export interface CreateServerOptions {
  rootDir?: string;
  lspBin?: string;
  timeoutMs?: number;
}

export interface CreatedServer {
  server: McpServer;
  client: LspClient;
  connect: (transport: Transport) => Promise<void>;
  close: () => Promise<void>;
}

/** Read the script timeout from CODEMODE_TIMEOUT_MS, falling back to the default. */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEMODE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

/**
 * Build the MCP server with the single `execute` tool wired to a fresh LSP client.
 * The LSP server is spawned eagerly so warmup runs in the background; the first
 * execute waits for it.
 */
export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const rootDir = options.rootDir ?? process.cwd();
  const lspBin = options.lspBin ?? process.env.CODEMODE_LSP_BIN ?? undefined;
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs();

  const client = new LspClient({ rootDir, lspBin });
  const api = new LspApi({ rootDir, client });

  // Spawn + handshake eagerly; warmup completes in the background. start()
  // resolves after the handshake; ready() (awaited inside ensureAlive) gates on
  // warmup. The first execute awaits this so a cold first call still works.
  const warmup = client.start().then(() => client.ready());
  // Avoid an unhandled rejection if the server fails to spawn before any execute
  // call observes it. The first execute awaits `warmup` inside its try/catch, so a
  // spawn failure is normalized into the { result, logs, changes } payload there.
  warmup.catch(() => undefined);

  const { execute } = createExecuteRunner({ api, client, timeoutMs, warmup });

  const server = new McpServer({
    name: "codemode-lsp",
    version: "0.1.0",
  });

  server.registerTool(
    "execute",
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            "JavaScript to run in the LSP sandbox. The last expression is the return value.",
          ),
      },
    },
    async ({ code }) => {
      const { result, logs, changes } = await execute(code);
      const payload = { result, logs, changes };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );

  return {
    server,
    client,
    connect: (transport: Transport) => server.connect(transport),
    close: async () => {
      await server.close();
      await client.stop();
    },
  };
}
