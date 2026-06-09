import { type ChildProcess, spawn } from "node:child_process";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CancellationToken,
  CancellationTokenSource,
  type MessageConnection,
} from "vscode-jsonrpc";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
  DocumentSymbol,
  InitializeResult,
  SymbolInformation,
} from "vscode-languageserver-protocol";

/**
 * Run an LSP request under a deadline. vscode-jsonrpc has no built-in
 * per-request timeout, so we race the request against a timer and cancel the
 * request (sending `$/cancelRequest`) when the timer wins. A wedged language
 * server fails the request with a clear error instead of hanging the script.
 */
export function withTimeout<R>(
  run: (token: CancellationToken) => Promise<R>,
  timeoutMs: number,
  label: string,
): Promise<R> {
  const source = new CancellationTokenSource();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      source.cancel();
      reject(
        new Error(`LSP request "${label}" timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });
  return Promise.race([run(source.token), timeout]).finally(() => {
    clearTimeout(timer);
    source.dispose();
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

const WARMUP_SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Find any TypeScript source file under `root` to proactively open for warmup. */
function findWarmupFile(root: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (WARMUP_SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        return full;
      }
    }
  }
  return null;
}

export interface LspClientOptions {
  /** Workspace root. The server is spawned with this cwd. Defaults to process.cwd(). */
  rootDir?: string;
  /** Language server command. Defaults to $CODEMODE_LSP_BIN or "typescript-language-server". */
  lspBin?: string;
  /** Per-request deadline in ms (default 10_000). */
  requestTimeoutMs?: number;
  /** Max time to wait for the readiness signal before proceeding anyway (default 3_000). */
  warmupTimeoutMs?: number;
}

/**
 * Owns the typescript-language-server lifecycle: spawn, handshake, warmup,
 * health, and crash recovery. Higher layers (symbol resolution, the lsp.* API)
 * build on the typed request/notification surface exposed here.
 *
 * The lifecycle is intended to be invisible to callers: a dead server is
 * respawned and re-handshaked transparently on the next operation.
 */
export class LspClient {
  private readonly rootDir: string;
  private readonly lspBin: string;
  private readonly requestTimeoutMs: number;
  private readonly warmupTimeoutMs: number;

  private proc: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private alive = false;

  private warmupPromise: Promise<void> | null = null;
  private readyDeferred: Deferred<void> | null = null;
  private readyResolved = false;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;

  /** URIs the current server has an open document for, with their version. */
  private readonly openVersions = new Map<string, number>();

  constructor(options: LspClientOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.lspBin =
      options.lspBin ??
      process.env.CODEMODE_LSP_BIN ??
      "typescript-language-server";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.warmupTimeoutMs = options.warmupTimeoutMs ?? 3_000;
  }

  /** Spawn the server and complete the handshake; warmup runs in the background. */
  async start(): Promise<void> {
    this.teardownProcess();
    this.openVersions.clear();
    this.readyResolved = false;
    const ready = deferred<void>();
    this.readyDeferred = ready;
    this.warmupPromise = ready.promise;
    await this.spawnAndHandshake();
    this.launchWarmup();
  }

  /** Resolve once warmup has completed (or the warmup fallback has elapsed). */
  async ready(): Promise<void> {
    if (this.warmupPromise) await this.warmupPromise;
  }

  /** True while the server process is running and the connection is open. */
  isAlive(): boolean {
    return (
      this.alive &&
      this.proc !== null &&
      this.proc.exitCode === null &&
      this.proc.signalCode === null
    );
  }

  /** Respawn + re-handshake if the server has died. No-op when healthy. */
  async ensureAlive(): Promise<void> {
    if (this.isAlive()) return;
    await this.start();
    await this.ready();
  }

  /** Document symbol tree for a file (relative to the root or absolute inside it). */
  async documentSymbol(
    file: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[]> {
    await this.ensureAlive();
    // The first request waits for warmup (§ Initialization & warmup): a caller
    // who does start() then documentSymbol() without ready() must still gate.
    await this.ready();
    const abs = isAbsolute(file) ? file : join(this.rootDir, file);
    this.openIfNeeded(abs);
    const uri = pathToFileURL(abs).href;
    const result = await this.request<
      DocumentSymbol[] | SymbolInformation[] | null
    >("textDocument/documentSymbol", { textDocument: { uri } });
    return result ?? [];
  }

  /**
   * Force-terminate the server process and wait for it to exit. Simulates a
   * crash; the next operation respawns. Distinct from {@link stop}, which is a
   * graceful shutdown.
   */
  async killServer(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGKILL");
    });
    this.alive = false;
  }

  /** Graceful shutdown: `shutdown` request, `exit` notification, dispose. */
  async stop(): Promise<void> {
    const conn = this.connection;
    if (conn && this.isAlive()) {
      try {
        await this.request("shutdown");
        conn.sendNotification("exit");
      } catch {
        // Server already gone; fall through to hard teardown.
      }
    }
    this.teardownProcess();
  }

  private async spawnAndHandshake(): Promise<void> {
    const proc = spawn(this.lspBin, ["--stdio"], {
      cwd: this.rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!proc.stdout || !proc.stdin) {
      proc.kill();
      throw new Error("Failed to open language-server stdio streams");
    }
    this.proc = proc;
    proc.on("exit", () => {
      this.alive = false;
    });
    proc.on("error", () => {
      this.alive = false;
    });

    const connection = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    connection.onClose(() => {
      this.alive = false;
    });
    connection.onError((error) => {
      console.error("[lsp] connection error:", error[0]?.message ?? error[0]);
    });
    // Readiness signals. typescript-language-server emits `$/typescriptVersion`
    // after `initialized`; `experimental/serverStatus` is honored per the PRD
    // even though TLS does not send it (see Decision Log). Whichever arrives
    // first releases the warmup gate; otherwise the fallback timer does.
    connection.onNotification("$/typescriptVersion", () => this.markReady());
    connection.onNotification(
      "experimental/serverStatus",
      (params: { quiescent?: boolean } | undefined) => {
        if (params?.quiescent) this.markReady();
      },
    );
    connection.listen();
    this.connection = connection;
    this.alive = true;

    // If the handshake fails (timeout, crash, parse error), tear the process
    // down so isAlive() reports dead and the next ensureAlive() retries —
    // otherwise a wedged-but-running server would be reported healthy forever.
    try {
      await this.request<InitializeResult>(
        "initialize",
        this.initializeParams(),
      );
      connection.sendNotification("initialized", {});
    } catch (error) {
      this.teardownProcess();
      throw error;
    }
  }

  private initializeParams(): Record<string, unknown> {
    const rootUri = pathToFileURL(this.rootDir).href;
    return {
      processId: process.pid,
      clientInfo: { name: "codemode-lsp", version: "0.1.0" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "root" }],
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    };
  }

  private launchWarmup(): void {
    this.warmupTimer = setTimeout(() => this.markReady(), this.warmupTimeoutMs);
    const file = findWarmupFile(this.rootDir);
    if (file) {
      try {
        this.openIfNeeded(file);
      } catch {
        // Warmup is best-effort; readiness still resolves via signal/fallback.
      }
    }
  }

  private markReady(): void {
    if (this.readyResolved) return;
    this.readyResolved = true;
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    this.readyDeferred?.resolve();
  }

  private openIfNeeded(abs: string): void {
    const uri = pathToFileURL(abs).href;
    if (this.openVersions.has(uri)) return;
    const conn = this.connection;
    if (!conn) throw new Error("LSP not started");
    const text = readFileSync(abs, "utf8");
    const languageId = abs.endsWith(".tsx") ? "typescriptreact" : "typescript";
    conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openVersions.set(uri, 1);
  }

  private request<R>(method: string, params?: unknown): Promise<R> {
    const conn = this.connection;
    if (!conn) throw new Error("LSP not started");
    return withTimeout<R>(
      (token) =>
        params === undefined
          ? conn.sendRequest<R>(method, token)
          : conn.sendRequest<R>(method, params, token),
      this.requestTimeoutMs,
      method,
    );
  }

  private teardownProcess(): void {
    this.connection?.dispose();
    const proc = this.proc;
    if (proc && proc.exitCode === null) proc.kill();
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    this.connection = null;
    this.proc = null;
    this.alive = false;
  }
}
