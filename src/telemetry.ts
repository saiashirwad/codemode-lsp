/**
 * Opt-in usage telemetry: one JSONL line per `execute` call, appended to the
 * file named by CODEMODE_TELEMETRY. Until now the operation trace was only
 * surfaced on failure; logging it on success too turns hand-curated field
 * reports into data — which ops (and docs queries) models actually run, what
 * fails, and which waste-hints fire. Off by default; purely local; never
 * affects the execute result (write errors are swallowed).
 */
import { appendFile } from "node:fs/promises";
import type { TraceEntry } from "./sandbox";

export interface TelemetryEvent {
  /** ISO timestamp of the execute call's completion. */
  ts: string;
  ok: boolean;
  durationMs: number;
  /** Every lsp.* call the script made, in order (incl. docs queries). */
  ops: TraceEntry[];
  /** Waste-hints the transaction produced. */
  hints: string[];
  /** The LLM-facing error message, on failure. */
  error?: string;
}

export interface Telemetry {
  record(event: TelemetryEvent): void;
  /** Resolves once every recorded event has been written (for tests/shutdown). */
  flush(): Promise<void>;
}

/** Read CODEMODE_TELEMETRY — a file path to append JSONL events to. */
export function resolveTelemetryPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.CODEMODE_TELEMETRY?.trim();
  return raw ? raw : undefined;
}

/** No path → undefined (telemetry disabled, zero overhead in the runner). */
export function createTelemetry(
  path: string | undefined,
): Telemetry | undefined {
  if (!path) return undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    record(event: TelemetryEvent): void {
      queue = queue
        .then(() => appendFile(path, `${JSON.stringify(event)}\n`))
        .catch(() => undefined);
    },
    flush(): Promise<void> {
      return queue.then(() => undefined);
    },
  };
}
