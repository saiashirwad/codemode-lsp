import { type ChildProcess, spawn } from "node:child_process";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationReceiverStrategy,
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
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Definition,
  Diagnostic,
  DocumentSymbol,
  InitializeResult,
  Location,
  LocationLink,
  Position,
  PublishDiagnosticsParams,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
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
const MAX_STDERR_CHARS = 8 * 1024;

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

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

function normalizeDefinition(
  result: Definition | LocationLink[] | null,
): Location[] {
  if (!result) return [];
  const values = Array.isArray(result) ? result : [result];
  return values.map((value) => {
    if (isLocationLink(value)) {
      return { uri: value.targetUri, range: value.targetSelectionRange };
    }
    return value;
  });
}

/**
 * Default language-server command: the typescript-language-server installed
 * alongside this package, so a published `npx codemode-lsp` works without the
 * binary being on the user's PATH. Falls back to a bare PATH lookup when the
 * package is not resolvable (e.g. an exotic install layout).
 */
function defaultLspBin(): string {
  try {
    return createRequire(import.meta.url).resolve(
      "typescript-language-server/lib/cli.mjs",
    );
  } catch {
    return "typescript-language-server";
  }
}

/**
 * The tsserver.js shipped with this package's own `typescript` dependency.
 * Passed to the language server as `tsserver.fallbackPath` so workspaces
 * without a local typescript install still work; a workspace install, when
 * present, takes precedence (typescript-language-server's documented order).
 */
function bundledTsserverPath(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve(
      "typescript/package.json",
    );
    return join(dirname(pkg), "lib", "tsserver.js");
  } catch {
    return undefined;
  }
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

export interface UriPosition {
  uri: string;
  position: Position;
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
  private startPromise: Promise<void> | null = null;
  private spawnError: Error | null = null;
  private recentStderr = "";

  private warmupPromise: Promise<void> | null = null;
  private readyDeferred: Deferred<void> | null = null;
  private readyResolved = false;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;

  /** URIs the current server has an open document for, with their version. */
  private readonly openVersions = new Map<string, number>();
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>();
  private readonly diagnosticsPublishedUris = new Set<string>();
  private readonly touchedUris = new Set<string>();

  constructor(options: LspClientOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.lspBin =
      options.lspBin ?? process.env.CODEMODE_LSP_BIN ?? defaultLspBin();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.warmupTimeoutMs = options.warmupTimeoutMs ?? 3_000;
  }

  /** Spawn the server and complete the handshake; warmup runs in the background. */
  async start(): Promise<void> {
    if (this.isAlive()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startFresh().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
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
    if (!this.isAlive()) await this.start();
    await this.ready();
  }

  /** Document symbol tree for a file (relative to the root or absolute inside it). */
  async documentSymbol(
    file: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[]> {
    await this.ensureAlive();
    const abs = isAbsolute(file) ? file : join(this.rootDir, file);
    this.openTextDocument(abs);
    const uri = pathToFileURL(abs).href;
    const result = await this.request<
      DocumentSymbol[] | SymbolInformation[] | null
    >("textDocument/documentSymbol", { textDocument: { uri } });
    return result ?? [];
  }

  async workspaceSymbol(
    query: string,
  ): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
    await this.ensureAlive();
    const result = await this.request<Array<
      SymbolInformation | WorkspaceSymbol
    > | null>("workspace/symbol", { query });
    return result ?? [];
  }

  async references(params: UriPosition): Promise<Location[]> {
    await this.ensureAlive();
    const result = await this.request<Location[] | null>(
      "textDocument/references",
      {
        textDocument: { uri: params.uri },
        position: params.position,
        context: { includeDeclaration: true },
      },
    );
    return result ?? [];
  }

  async definition(params: UriPosition): Promise<Location[]> {
    await this.ensureAlive();
    const result = await this.request<Definition | LocationLink[] | null>(
      "textDocument/definition",
      { textDocument: { uri: params.uri }, position: params.position },
    );
    return normalizeDefinition(result);
  }

  /** Resolve the call-hierarchy item at a position (empty when not callable). */
  async prepareCallHierarchy(
    params: UriPosition,
  ): Promise<CallHierarchyItem[]> {
    await this.ensureAlive();
    const result = await this.request<CallHierarchyItem[] | null>(
      "textDocument/prepareCallHierarchy",
      { textDocument: { uri: params.uri }, position: params.position },
    );
    return result ?? [];
  }

  async incomingCalls(
    item: CallHierarchyItem,
  ): Promise<CallHierarchyIncomingCall[]> {
    await this.ensureAlive();
    const result = await this.request<CallHierarchyIncomingCall[] | null>(
      "callHierarchy/incomingCalls",
      { item },
    );
    return result ?? [];
  }

  async outgoingCalls(
    item: CallHierarchyItem,
  ): Promise<CallHierarchyOutgoingCall[]> {
    await this.ensureAlive();
    const result = await this.request<CallHierarchyOutgoingCall[] | null>(
      "callHierarchy/outgoingCalls",
      { item },
    );
    return result ?? [];
  }

  openTextDocument(abs: string): void {
    const uri = pathToFileURL(abs).href;
    if (this.openVersions.has(uri)) return;
    const text = readFileSync(abs, "utf8");
    this.didOpen(abs, text);
  }

  /**
   * Open a document with explicit content (rather than reading disk). Used by the
   * transactional buffer to open files at their original disk content or to open
   * a *created* file's new content. No-op if the URI is already open.
   */
  didOpen(abs: string, text: string): void {
    const uri = pathToFileURL(abs).href;
    if (this.openVersions.has(uri)) return;
    const conn = this.connection;
    if (!conn || !this.isAlive()) throw new Error("LSP not started");
    const languageId = abs.endsWith(".tsx") ? "typescriptreact" : "typescript";
    conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openVersions.set(uri, 1);
    this.touchedUris.add(uri);
  }

  /**
   * Send a full-document `didChange` (version incremented). The document must be
   * open. Returns the new version. Used by the buffer on every write and on
   * rollback (didChange back to the original — never close/reopen, which leaves
   * tsserver stale; see PRD § Transactional Writes).
   */
  didChangeFullText(abs: string, text: string): number {
    const uri = pathToFileURL(abs).href;
    const conn = this.connection;
    if (!conn || !this.isAlive()) throw new Error("LSP not started");
    const current = this.openVersions.get(uri);
    if (current === undefined) {
      throw new Error(`Cannot didChange a document that is not open: ${uri}`);
    }
    const version = current + 1;
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    this.openVersions.set(uri, version);
    this.touchedUris.add(uri);
    return version;
  }

  /** Send `didClose` and forget the document's version. No-op if not open. */
  didClose(abs: string): void {
    const uri = pathToFileURL(abs).href;
    if (!this.openVersions.has(uri)) return;
    const conn = this.connection;
    if (!conn || !this.isAlive()) throw new Error("LSP not started");
    conn.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    this.openVersions.delete(uri);
  }

  isOpen(abs: string): boolean {
    return this.openVersions.has(pathToFileURL(abs).href);
  }

  async rename(
    params: UriPosition & { newName: string },
  ): Promise<WorkspaceEdit | null> {
    await this.ensureAlive();
    return this.request<WorkspaceEdit | null>("textDocument/rename", {
      textDocument: { uri: params.uri },
      position: params.position,
      newName: params.newName,
    });
  }

  async prepareRename(params: UriPosition): Promise<unknown> {
    await this.ensureAlive();
    return this.request<unknown>("textDocument/prepareRename", {
      textDocument: { uri: params.uri },
      position: params.position,
    });
  }

  getOpenDocumentVersion(abs: string): number | undefined {
    return this.openVersions.get(pathToFileURL(abs).href);
  }

  getDiagnosticsForUris(uris?: string[]): Diagnostic[] {
    const sourceUris = uris ?? [...this.touchedUris];
    return sourceUris.flatMap((uri) => this.diagnosticsByUri.get(uri) ?? []);
  }

  getTouchedUris(): string[] {
    return [...this.touchedUris];
  }

  async waitForDiagnosticsForUris(
    uris: string[],
    timeoutMs = 2_000,
  ): Promise<Diagnostic[]> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (uris.every((uri) => this.diagnosticsPublishedUris.has(uri))) {
        return this.getDiagnosticsForUris(uris);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.getDiagnosticsForUris(uris);
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
    this.markDead(true);
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

  private async startFresh(): Promise<void> {
    this.teardownProcess();
    this.openVersions.clear();
    this.readyResolved = false;
    this.spawnError = null;
    this.diagnosticsPublishedUris.clear();
    this.diagnosticsByUri.clear();
    const ready = deferred<void>();
    this.readyDeferred = ready;
    this.warmupPromise = ready.promise;
    await this.spawnAndHandshake();
    this.launchWarmup();
  }

  private async spawnAndHandshake(): Promise<void> {
    // A .js/.mjs lspBin (the resolved default) is run through the current
    // runtime; anything else (PATH command, .bin shim) is spawned directly.
    const isScript = /\.[cm]?js$/.test(this.lspBin);
    const [command, args] = isScript
      ? [process.execPath, [this.lspBin, "--stdio"]]
      : [this.lspBin, ["--stdio"]];
    const proc = spawn(command, args, {
      cwd: this.rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!proc.stdout || !proc.stdin) {
      proc.kill();
      throw new Error("Failed to open language-server stdio streams");
    }
    this.proc = proc;
    // Once the process is killed during teardown, stdin is destroyed. A pending
    // request cancellation (`$/cancelRequest`, sent when a request times out)
    // can still race a write onto the dead stream — that surfaces as an
    // unhandled ERR_STREAM_DESTROYED. Absorb it: teardown is already underway.
    proc.stdin?.on("error", () => {
      // Stream write after destroy during teardown; nothing to recover.
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      this.appendStderr(String(chunk));
    });
    proc.on("exit", () => {
      if (this.proc === proc) this.markDead(true);
    });
    const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
      proc.once("error", (error) => {
        this.spawnError = error;
        if (this.proc === proc) this.markDead(true);
        reject(this.formatSpawnError(error));
      });
    });

    // Wait until the OS confirms the process actually started before writing
    // any LSP message. A bad CODEMODE_LSP_BIN emits `error` (ENOENT) with stdio
    // streams that are already being torn down; writing `initialize` into them
    // races a destroyed stdin and leaks an unhandled ERR_STREAM_DESTROYED.
    // Gating on `spawn` vs `error` makes the failure path purely the spawn error.
    await Promise.race([
      new Promise<void>((resolve) => proc.once("spawn", resolve)),
      spawnErrorPromise,
    ]);

    const connection = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
      undefined,
      {
        // Default cancellation sends `$/cancelRequest` and ignores the returned
        // promise. When a request times out and we tear the server down, that
        // notification can race a write onto a destroyed stdin, surfacing as an
        // unhandled ERR_STREAM_DESTROYED. Swallow the write failure: the request
        // is already being cancelled/torn down.
        cancellationStrategy: {
          receiver: CancellationReceiverStrategy.Message,
          sender: {
            sendCancellation: (conn, id) =>
              conn.sendNotification("$/cancelRequest", { id }).catch(() => {
                // Stream gone during teardown; cancellation is moot.
              }),
            cleanup: () => {},
          },
        },
      },
    );
    connection.onClose(() => {
      if (this.connection === connection) this.markDead(false);
    });
    connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        this.diagnosticsByUri.set(params.uri, params.diagnostics);
        this.diagnosticsPublishedUris.add(params.uri);
        this.touchedUris.add(params.uri);
      },
    );
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
      // If the spawn-error promise wins the race, the abandoned initialize
      // request still settles later. On a bad binary, its write rejects with
      // ERR_STREAM_DESTROYED once stdin is gone — attach a no-op catch so that
      // loser rejection is handled rather than surfacing as an unhandled one.
      const initializeRequest = this.request<InitializeResult>(
        "initialize",
        this.initializeParams(),
      );
      initializeRequest.catch(() => {
        // Handled by the race below (or abandoned on spawn error/teardown).
      });
      await Promise.race([initializeRequest, spawnErrorPromise]);
      connection.sendNotification("initialized", {});
    } catch (error) {
      this.teardownProcess();
      if (this.spawnError) throw this.formatSpawnError(this.spawnError);
      throw this.withRecentStderr(error);
    }
  }

  private initializeParams(): Record<string, unknown> {
    const rootUri = pathToFileURL(this.rootDir).href;
    const fallbackPath = bundledTsserverPath();
    return {
      processId: process.pid,
      clientInfo: { name: "codemode-lsp", version: "0.1.0" },
      ...(fallbackPath && {
        initializationOptions: { tsserver: { fallbackPath } },
      }),
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "root" }],
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { linkSupport: false },
          references: {},
          rename: { prepareSupport: true },
          callHierarchy: {},
          synchronization: { didSave: false, willSave: false },
          // typescript-language-server 4.x only pushes textDocument/
          // publishDiagnostics when the client advertises support for it.
          // Without this, getDiagnostics never sees the fixture's type error.
          publishDiagnostics: {},
        },
        workspace: {
          symbol: {},
        },
      },
    };
  }

  private launchWarmup(): void {
    this.warmupTimer = setTimeout(() => this.markReady(), this.warmupTimeoutMs);
    const file = findWarmupFile(this.rootDir);
    if (file) {
      try {
        this.openTextDocument(file);
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

  private appendStderr(chunk: string): void {
    this.recentStderr = `${this.recentStderr}${chunk}`;
    if (this.recentStderr.length > MAX_STDERR_CHARS) {
      this.recentStderr = this.recentStderr.slice(-MAX_STDERR_CHARS);
    }
  }

  private formatSpawnError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return this.withRecentStderr(
      new Error(
        `Could not spawn TypeScript language server at "${this.lspBin}": ${message}`,
      ),
    );
  }

  private withRecentStderr(error: unknown): Error {
    const base = error instanceof Error ? error : new Error(String(error));
    if (!this.recentStderr.trim()) return base;
    return new Error(
      `${base.message}\nRecent language-server stderr:\n${this.recentStderr.trim()}`,
    );
  }

  private markDead(disposeConnection: boolean): void {
    this.alive = false;
    this.openVersions.clear();
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    if (disposeConnection) {
      const conn = this.connection;
      this.connection = null;
      try {
        conn?.dispose();
      } catch {
        // dispose is best-effort; the server is already dead.
      }
    }
  }

  private teardownProcess(): void {
    const conn = this.connection;
    this.connection = null;
    try {
      conn?.dispose();
    } catch {
      // ignore teardown disposal errors
    }
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) proc.kill();
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    this.alive = false;
  }
}
