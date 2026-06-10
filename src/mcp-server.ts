import { relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { unifiedDiff } from "./diff";
import { LspApi } from "./lsp-api";
import { LspClient } from "./lsp-client";
import {
  DEFAULT_TIMEOUT_MS,
  formatTrace,
  runSandbox,
  SandboxError,
} from "./sandbox";

/** A single flushed change with a reviewable unified diff (PRD § The execute Tool). */
export interface Change {
  file: string;
  kind: "modified" | "created" | "deleted";
  diff: string;
}

/** Read CODEMODE_READONLY (1/true → read-only mode). */
export function resolveReadonly(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEMODE_READONLY?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export interface ExecuteResult {
  result: string;
  logs: string;
  changes: Change[];
}

function buildToolDescription(readonly: boolean): string {
  const writeSection = readonly
    ? ""
    : `
Write operations available (changes are buffered and applied atomically when the
script succeeds; rolled back if it throws): renameSymbol, replaceSymbolBody,
insertBeforeSymbol, insertAfterSymbol, deleteSymbol, writeFile, deleteFile. Each
returns { file, filesChanged, diagnostics }. The execute result's \`changes\` lists
every flushed file as { file, kind, diff } with a reviewable unified diff.`;
  return `Execute JavaScript to perform semantic code operations via LSP.

Write a script that chains \`lsp.*\` calls (e.g. \`await lsp.getSymbols("src/api.ts")\`).
The script runs in a sandbox with \`lsp.*\`, \`console.log/warn/error\` (captured), and
\`path.join/basename/dirname/extname\`. Returns { result, logs, changes }.

Read operations available: readFile, getSymbolBody, getSymbols, findSymbol,
findReferences, goToDefinition, searchText, listFiles, getDiagnostics.${writeSection}

Important:
- The last expression in the script is the return value. End with the value you
  want back (e.g. \`({ files: files.length })\`), not just side effects.
- Symbol paths use \`/\`: \`MyClass/myMethod\`. Use \`getSymbols(file)\` to discover the
  exact paths — never guess them.
- \`.filter()\`/\`.map()\` callbacks cannot be async; use \`for...of\` with \`await\`.
- File paths are relative to the workspace root; paths outside it are rejected.
- Diagnostics cover touched files only, not the whole project.`;
}

export interface ExecuteToolDeps {
  api: LspApi;
  client: LspClient;
  timeoutMs: number;
  /** Resolves once the server has warmed up; awaited before the first execute. */
  warmup: Promise<void>;
  /** Workspace root, used to render relative file paths in `changes`. */
  rootDir?: string;
  /** When true, write ops are stripped from the sandbox (CODEMODE_READONLY). */
  readonly?: boolean;
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

  const rootDir = deps.rootDir ?? process.cwd();

  const execute = (code: string): Promise<ExecuteResult> => {
    // Async mutex: chain every call so they run strictly serially. Concurrent
    // scripts would corrupt shared LSP/buffer state (PRD § Concurrency).
    const run = queue.then(async () => {
      // Begin a fresh transaction per script. Reads reflect buffered writes; the
      // buffer is flushed on success and rolled back on failure.
      const buffer = deps.api.beginTransaction();
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
          readonly: deps.readonly,
        });
        // Success → flush buffered writes to disk, producing reviewable diffs.
        const flushed = buffer.flush();
        const changes: Change[] = flushed.map((change) => ({
          file: toRelPath(rootDir, change.absPath),
          kind: change.kind,
          diff: unifiedDiff(
            toRelPath(rootDir, change.absPath),
            change.original,
            change.updated,
          ),
        }));
        return { result, logs, changes };
      } catch (error) {
        // Failure → roll back the LSP buffer; disk is untouched.
        const wasDirty = buffer.isDirty();
        buffer.rollback();
        if (error instanceof SandboxError) {
          const { failure } = error;
          // Re-format the trace with the rollback sentence when writes were
          // buffered (PRD § Errors). Surface it alongside the LLM-targeted error.
          const trace = formatTrace(failure.traceEntries, wasDirty);
          const message = trace
            ? `${failure.error}\n\n${trace}`
            : failure.error;
          return {
            result: message,
            logs: failure.logs,
            changes: [] as Change[],
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { result: message, logs: "", changes: [] as Change[] };
      } finally {
        deps.api.endTransaction();
      }
    });
    // Keep the queue chained even if this run rejects (it shouldn't — runSandbox
    // failures are caught above — but stay defensive so the mutex never wedges).
    queue = run.catch(() => undefined);
    return run;
  };

  return { execute };
}

/** Workspace-relative POSIX path for `changes` entries. */
function toRelPath(rootDir: string, absPath: string): string {
  return relative(rootDir, absPath).split(/[\\/]/).join("/");
}

export interface CreateServerOptions {
  rootDir?: string;
  lspBin?: string;
  timeoutMs?: number;
  /** When true, write ops are removed from the sandbox, types, and description. */
  readonly?: boolean;
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
  const readonly = options.readonly ?? resolveReadonly();

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

  const { execute } = createExecuteRunner({
    api,
    client,
    timeoutMs,
    warmup,
    rootDir,
    readonly,
  });

  const server = new McpServer({
    name: "codemode-lsp",
    version: "0.1.0",
  });

  server.registerTool(
    "execute",
    {
      description: buildToolDescription(readonly),
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
