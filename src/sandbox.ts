import { basename, dirname, extname, join } from "node:path";
import vm from "node:vm";
import { parse as acornParse } from "acorn";
import type { LspApi } from "./lsp-api";

/** Default script timeout (ms). Overridable via the sandbox options / CODEMODE_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard cap on the serialized result, in characters (PRD § Result size cap). */
export const RESULT_CHAR_CAP = 50_000;

/** Hard cap on captured logs, in characters (PRD § Result size cap). */
export const LOG_CHAR_CAP = 10_000;

/** Exact marker appended when the serialized result is truncated (PRD § Result size cap). */
export const RESULT_TRUNCATION_MARKER =
  "[truncated — result exceeded 50000 chars. Refine the script to return less data, e.g. map to only the fields you need.]";

/** Exact marker appended when captured logs are truncated. */
export const LOG_TRUNCATION_MARKER =
  "[truncated — logs exceeded 10000 chars. Refine the script to log less.]";

/** A single recorded `lsp.*` invocation, for the failure trace. */
export interface TraceEntry {
  /** `lsp.*` method name, e.g. `findReferences`. */
  op: string;
  /** Key arguments rendered for the trace line, e.g. `["src/api.ts", "handleRequest"]`. */
  args: string[];
  /** One-line outcome — `→ 14 results`, `→ ok`, or the thrown error message. */
  outcome: string;
  /** Whether the call threw. */
  failed: boolean;
}

export interface SandboxResult {
  /** JSON-serialized final value (truncated at the cap). */
  result: string;
  /** Captured console output, in order (truncated at the cap). */
  logs: string;
}

export interface SandboxFailure {
  /** LLM-targeted error message (the thrown error's message). */
  error: string;
  /** Captured console output up to the failure. */
  logs: string;
  /** Operation trace formatted per PRD § Errors. */
  trace: string;
  /** The completed + failed steps, structured, for callers that want to reformat. */
  traceEntries: TraceEntry[];
}

export class SandboxError extends Error {
  constructor(public readonly failure: SandboxFailure) {
    super(failure.error);
    this.name = "SandboxError";
  }
}

export interface SandboxOptions {
  lsp: LspApi;
  /** Script timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * When true, the 7 write ops are absent from the sandbox `lsp` object entirely
   * (CODEMODE_READONLY). Read ops + getDiagnostics remain. Defaults to false.
   */
  readonly?: boolean;
  /**
   * Full API reference returned by `lsp.help()` — the escape hatch for clients
   * that truncate the tool description (a field report showed an agent burning
   * a whole invocation probing signatures it should have been handed).
   */
  helpText?: string;
}

/** Read ops + getDiagnostics — always exposed, even under CODEMODE_READONLY. */
export const READ_OP_NAMES = [
  "readFile",
  "getSymbolBody",
  "getSymbols",
  "findSymbol",
  "findReferences",
  "goToDefinition",
  "searchText",
  "listFiles",
  "getDiagnostics",
] as const;

/** The 7 write ops — absent from the sandbox under CODEMODE_READONLY. */
export const WRITE_OP_NAMES = [
  "renameSymbol",
  "replaceSymbolBody",
  "insertBeforeSymbol",
  "insertAfterSymbol",
  "deleteSymbol",
  "writeFile",
  "deleteFile",
] as const;

type OpName = (typeof READ_OP_NAMES)[number] | (typeof WRITE_OP_NAMES)[number];

/** Render an argument for a trace line. Strings are quoted; everything else JSON-ish. */
function renderArg(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One-line success outcome for a trace entry, e.g. `→ 14 results` or `→ ok`. */
function describeOutcome(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} result${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "string") {
    const len = value.length;
    return `${len} char${len === 1 ? "" : "s"}`;
  }
  if (value === undefined || value === null) return "ok";
  return "ok";
}

/**
 * A factory that wraps a host implementation in an in-realm sandbox function.
 * `(impl) => async function (...args) { return impl(...args); }`, compiled with
 * `vm.runInContext` so the returned function's `Function`/`constructor` chain
 * belongs to the sandbox realm — not the host's. This closes the
 * `fn.constructor("return process")()` escape (the constructor is the sandbox's
 * own Function, which cannot reach host globals). The factories are built in
 * `runSandbox` via `vm.runInContext`.
 */
type AsyncWrapperFactory = <A extends unknown[], R>(
  impl: (...args: A) => R,
) => (...args: A) => R;
type SyncWrapperFactory = <A extends unknown[], R>(
  impl: (...args: A) => R,
) => (...args: A) => R;

/**
 * Wrap each read op so every call is appended to `trace`. The wrapper records the
 * op name, the key args, and a one-line outcome (or the error message on failure),
 * then re-throws so scripts can `try/catch` real Errors.
 *
 * Each traced op is additionally wrapped in an in-realm function (via
 * `wrapAsync`) so the function the script touches — and its `.constructor` — is a
 * sandbox-realm function that cannot reach the host realm.
 */
function buildTracedLsp(
  api: LspApi,
  trace: TraceEntry[],
  /**
   * Construct an Error belonging to the sandbox realm. lsp.* implementations run
   * in the host realm, so a host `Error` fails `e instanceof Error` inside the vm
   * context. Rebuilding the error with the context's own `Error` constructor lets
   * scripts `try/catch` and test `instanceof Error` as expected.
   */
  makeSandboxError: (message: string) => Error,
  /** Lift a host async impl into a sandbox-realm async function. */
  wrapAsync: AsyncWrapperFactory,
  /** The op names to expose. Excludes write ops under CODEMODE_READONLY. */
  opNames: readonly OpName[],
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const traced: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of opNames) {
    const fn = (api as unknown as Record<string, unknown>)[name];
    if (typeof fn !== "function") continue;
    const bound = (fn as (...a: unknown[]) => Promise<unknown>).bind(api);
    const hostTraced = async (...args: unknown[]): Promise<unknown> => {
      const entry: TraceEntry = {
        op: name,
        args: args.map(renderArg),
        outcome: "",
        failed: false,
      };
      trace.push(entry);
      try {
        const result = await bound(...args);
        entry.outcome = describeOutcome(result);
        return result;
      } catch (error) {
        entry.failed = true;
        const message = error instanceof Error ? error.message : String(error);
        entry.outcome = message;
        // Surface as a real Error inside the sandbox so scripts can try/catch.
        throw makeSandboxError(message);
      }
    };
    // Hand the script a sandbox-realm function so `fn.constructor` is the
    // sandbox's Function, not the host's.
    traced[name] = wrapAsync(hostTraced);
  }
  return traced;
}

/** Host path helpers exposed to scripts (only join/basename/dirname/extname). */
const hostPath = { join, basename, dirname, extname } as const;

interface NormalizedCode {
  /** Source ready to run as `(async () => { ... })()`. */
  source: string;
  /**
   * Human description of the script's last top-level statement when it is one
   * that produces no capturable value (an if/for/try block, a declaration, …).
   * Used to explain an `undefined` result instead of returning it silently —
   * field report: a script ending in `if (…) { refs.map(…) } else { … }`
   * returned bare `undefined` and cost an avoidable round-trip.
   */
  uncapturedLastStatement?: string;
}

const UNCAPTURED_STATEMENT_NAMES: Record<string, string> = {
  IfStatement: "an if statement",
  ForStatement: "a for loop",
  ForOfStatement: "a for...of loop",
  ForInStatement: "a for...in loop",
  WhileStatement: "a while loop",
  DoWhileStatement: "a do...while loop",
  TryStatement: "a try/catch block",
  SwitchStatement: "a switch statement",
  BlockStatement: "a block",
  VariableDeclaration: "a variable declaration",
  FunctionDeclaration: "a function declaration",
  ClassDeclaration: "a class declaration",
};

/**
 * Describe a last statement whose value cannot be captured. Returns undefined
 * for statement kinds that DO produce/route a value (expression statements are
 * handled separately; a top-level `return` already works inside the IIFE — and
 * so do returns nested in a final if/try block, which is why the runner only
 * surfaces this description when the result actually came back undefined).
 */
function describeUncapturedStatement(type: string): string | undefined {
  if (type === "ReturnStatement") return undefined;
  return UNCAPTURED_STATEMENT_NAMES[type] ?? `a ${type}`;
}

function isExpressionStatement(node: { type: string }): boolean {
  return node.type === "ExpressionStatement";
}

/**
 * Normalize user code into an async-IIFE body that returns the right value
 * (Cloudflare's `normalizeCode()` pattern). Three accepted shapes:
 *
 *  1. A bare async arrow — `async () => { ... }` — invoked directly.
 *  2. A single expression — `1 + 1` — returned.
 *  3. A script — if the last statement is an expression, its value is returned;
 *     otherwise the script runs for effect and returns undefined.
 *
 * Auto-await is handled at the call site (the IIFE is always awaited).
 */
export function normalizeCode(code: string): NormalizedCode {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { source: "return undefined;" };
  }

  let program: ReturnType<typeof acornParse>;
  try {
    program = acornParse(trimmed, {
      ecmaVersion: 2023,
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse script: ${message}`);
  }

  const body = (program as unknown as { body: Array<{ type: string }> }).body;

  // Shape 1: the whole program is a single *async* arrow/function expression —
  // treat it as an entry point to invoke. Only async is auto-invoked: a bare
  // synchronous arrow (`() => 1`) is an ordinary value (and a non-serializable
  // one) that the script means to return, not a wrapper to call.
  if (body.length === 1) {
    const only = body[0] as {
      type: string;
      expression?: { type: string; async?: boolean };
    };
    if (
      isExpressionStatement(only) &&
      only.expression &&
      only.expression.async === true &&
      (only.expression.type === "ArrowFunctionExpression" ||
        only.expression.type === "FunctionExpression")
    ) {
      return { source: `return await (${trimmed})();` };
    }
  }

  const last = body[body.length - 1] as
    | { type: string; start: number; end: number }
    | undefined;

  if (last && isExpressionStatement(last)) {
    const head = trimmed.slice(0, last.start);
    const tail = trimmed.slice(last.start, last.end);
    // Strip a single trailing semicolon from the returned expression so
    // `return (<expr>);` is always valid.
    const expr = tail.replace(/;\s*$/, "");
    return { source: `${head}\nreturn (${expr});` };
  }

  // No trailing expression: run for effect, return undefined. Remember what
  // the last statement was so an undefined result can explain itself.
  return {
    source: `${trimmed}\nreturn undefined;`,
    ...(last
      ? (() => {
          const described = describeUncapturedStatement(last.type);
          return described ? { uncapturedLastStatement: described } : {};
        })()
      : {}),
  };
}

/** Truncate `text` to `cap` chars, appending `marker` when it overflows. */
function capText(text: string, cap: number, marker: string): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + marker;
}

/**
 * Find the first un-awaited Promise nested inside the result and return its
 * path, or null. Duck-typed (`.then`) because sandbox-realm Promises fail an
 * `instanceof Promise` check in the host realm. The top-level value is already
 * auto-awaited by the runner; this catches Promises inside objects/arrays,
 * which would otherwise JSON-serialize as `{}` — a silent, undiagnosable
 * footgun observed in real sessions.
 */
function findThenablePath(
  value: unknown,
  path: string,
  seen: Set<object>,
): string | null {
  if (value === null || typeof value !== "object") return null;
  if (typeof (value as { then?: unknown }).then === "function") return path;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findThenablePath(value[i], `${path}[${i}]`, seen);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findThenablePath(child, `${path}.${key}`, seen);
    if (found) return found;
  }
  return null;
}

/**
 * JSON-serialize the final value. Non-serializable values (functions, circular
 * references) throw an LLM-targeted error explaining what to return instead.
 */
function serializeResult(value: unknown): string {
  if (value === undefined) return "undefined";
  const thenableAt = findThenablePath(value, "result", new Set());
  if (thenableAt !== null) {
    throw new Error(
      `Script result contains a Promise at "${thenableAt}" — did you forget ` +
        "await? Every lsp.* function is async; write e.g. " +
        '`const files = await lsp.listFiles("src/**");`.',
    );
  }
  if (typeof value === "function") {
    throw new Error(
      "Script returned a function, which cannot be serialized. Return a " +
        "JSON-serializable value instead (string, number, boolean, array, or " +
        "plain object) — e.g. call the function and return its result.",
    );
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/circular|cyclic/i.test(message)) {
      throw new Error(
        "Script returned a value with circular references, which cannot be " +
          "serialized. Return a plain JSON-serializable value instead — map to " +
          "only the fields you need.",
      );
    }
    throw new Error(
      `Script result could not be serialized to JSON: ${message}. Return a ` +
        "plain JSON-serializable value (string, number, boolean, array, or " +
        "plain object).",
    );
  }
  if (serialized === undefined) {
    // JSON.stringify returns undefined for e.g. a bare function or symbol.
    throw new Error(
      "Script returned a value that cannot be serialized to JSON. Return a " +
        "plain JSON-serializable value (string, number, boolean, array, or " +
        "plain object).",
    );
  }
  return serialized;
}

/** Exact rollback sentence appended to a failed script's trace (PRD § Errors). */
export const ROLLBACK_TRACE_LINE =
  "All buffered changes were rolled back; the codebase is unchanged.";

/**
 * Format the operation trace per PRD § Errors (completed: / failed at: lines).
 * When `rolledBack` is true (the failed script had buffered writes that were
 * rolled back), the exact rollback sentence is appended.
 */
export function formatTrace(entries: TraceEntry[], rolledBack = false): string {
  const completed = entries.filter((entry) => !entry.failed);
  const failed = entries.find((entry) => entry.failed);
  const lines: string[] = [];

  lines.push("completed:");
  if (completed.length === 0) {
    lines.push("  (none)");
  } else {
    completed.forEach((entry, index) => {
      lines.push(
        `  ${index + 1}. ${entry.op}(${entry.args.join(", ")}) → ${entry.outcome}`,
      );
    });
  }

  if (failed) {
    lines.push("failed at:");
    lines.push(
      `  ${completed.length + 1}. ${failed.op}(${failed.args.join(", ")}) → ${failed.outcome}`,
    );
  }
  if (rolledBack) lines.push(ROLLBACK_TRACE_LINE);

  return lines.join("\n");
}

/**
 * Run user code in a `vm.runInNewContext` sandbox.
 *
 * On success returns `{ result, logs }` (the trace is dropped). On failure throws
 * a {@link SandboxError} carrying the error message, logs captured so far, and the
 * formatted operation trace.
 */
export async function runSandbox(
  code: string,
  options: SandboxOptions,
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trace: TraceEntry[] = [];
  const logParts: string[] = [];

  const recordLog =
    (level: "log" | "warn" | "error") =>
    (...args: unknown[]): void => {
      const rendered = args
        .map((arg) =>
          typeof arg === "string"
            ? arg
            : (() => {
                try {
                  return JSON.stringify(arg);
                } catch {
                  return String(arg);
                }
              })(),
        )
        .join(" ");
      const prefix =
        level === "log" ? "" : level === "warn" ? "[warn] " : "[error] ";
      logParts.push(`${prefix}${rendered}`);
    };

  // The vm context provides JS builtins (Math, JSON, Array, …) natively. We add
  // only the curated globals; host runtime globals (process, Bun, fetch, require,
  // setTimeout, …) are NOT injected, so the context cannot reach them.
  const sandbox: Record<string, unknown> = {};
  const context = vm.createContext(sandbox);

  // Capture the context's own Error constructor so thrown lsp.* errors satisfy
  // `e instanceof Error` inside the sandbox realm (see buildTracedLsp).
  const SandboxRealmError = vm.runInContext(
    "Error",
    context,
  ) as ErrorConstructor;
  const makeSandboxError = (message: string): Error =>
    new SandboxRealmError(message);

  // In-realm wrapper factories: compiled inside the context, so functions they
  // produce (and the functions' `.constructor`) belong to the sandbox realm. Host
  // implementations are reached only through the `impl` closure variable, which a
  // script cannot recover from the wrapper. This closes the
  // `fn.constructor("return process")()` realm-escape for every host function the
  // script can touch (path.*, console.*, lsp.*).
  const wrapSync = vm.runInContext(
    "(impl) => function (...args) { return impl(...args); }",
    context,
  ) as SyncWrapperFactory;
  const wrapAsync = vm.runInContext(
    "(impl) => async function (...args) { return impl(...args); }",
    context,
  ) as AsyncWrapperFactory;

  sandbox.path = {
    join: wrapSync(hostPath.join),
    basename: wrapSync(hostPath.basename),
    dirname: wrapSync(hostPath.dirname),
    extname: wrapSync(hostPath.extname),
  };
  sandbox.console = {
    log: wrapSync(recordLog("log")),
    warn: wrapSync(recordLog("warn")),
    error: wrapSync(recordLog("error")),
  };
  const opNames: OpName[] = options.readonly
    ? [...READ_OP_NAMES]
    : [...READ_OP_NAMES, ...WRITE_OP_NAMES];
  sandbox.lsp = buildTracedLsp(
    options.lsp,
    trace,
    makeSandboxError,
    wrapAsync,
    opNames,
  );
  // Untraced meta-op: the full API reference, for when the client truncated
  // the tool description.
  const helpText =
    options.helpText ??
    "No extended help is available; the tool description is the full reference.";
  (sandbox.lsp as Record<string, unknown>).help = wrapAsync(
    async () => helpText,
  );

  const { source, uncapturedLastStatement } = normalizeCode(code);
  // Wrap in an async IIFE; the returned Promise is awaited here (auto-await).
  const wrapped = `(async () => {\n${source}\n})()`;

  const buildLogs = () =>
    capText(logParts.join("\n"), LOG_CHAR_CAP, LOG_TRUNCATION_MARKER);

  let scriptPromise: Promise<unknown>;
  try {
    scriptPromise = vm.runInContext(wrapped, context, {
      // vm's own timeout only covers synchronous execution; the Promise.race
      // below enforces the wall-clock deadline for async work.
      filename: "codemode-script.js",
    }) as Promise<unknown>;
  } catch (error) {
    // Synchronous throw (syntax error surfaced at run, or top-level sync throw).
    throw new SandboxError({
      error: error instanceof Error ? error.message : String(error),
      logs: buildLogs(),
      trace: formatTrace(trace),
      traceEntries: trace,
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Script timed out after ${timeoutMs}ms. Reduce the work per call ` +
            "or split it across multiple execute calls.",
        ),
      );
    }, timeoutMs);
  });

  let value: unknown;
  try {
    value = await Promise.race([scriptPromise, timeout]);
  } catch (error) {
    throw new SandboxError({
      error: error instanceof Error ? error.message : String(error),
      logs: buildLogs(),
      trace: formatTrace(trace),
      traceEntries: trace,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let result: string;
  try {
    // A silent `undefined` from a script ending in a block is undiagnosable —
    // explain it in-band rather than throwing (throwing would roll back
    // legitimate writes the script already made).
    result =
      value === undefined && uncapturedLastStatement
        ? `undefined — note: the script's last statement is ${uncapturedLastStatement}, ` +
          "which produces no capturable value. Only a top-level trailing " +
          "expression becomes the result — end the script with a bare " +
          "expression (e.g. `({ count })`), or use a top-level `return`."
        : serializeResult(value);
  } catch (error) {
    throw new SandboxError({
      error: error instanceof Error ? error.message : String(error),
      logs: buildLogs(),
      trace: formatTrace(trace),
      traceEntries: trace,
    });
  }

  return {
    result: capText(result, RESULT_CHAR_CAP, RESULT_TRUNCATION_MARKER),
    logs: buildLogs(),
  };
}
