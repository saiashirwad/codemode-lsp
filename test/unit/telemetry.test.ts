import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import { createExecuteRunner } from "../../src/mcp-server";
import {
  createTelemetry,
  resolveTelemetryPath,
  type TelemetryEvent,
} from "../../src/telemetry";

function stubApi(): LspApi {
  const noopBuffer = {
    isDirty: () => false,
    rollback: () => {},
    flush: () => [],
  };
  return {
    listFiles: async () => ["src/a.ts"],
    readFile: async () => {
      throw new Error("boom: file not found");
    },
    beginTransaction: () => noopBuffer,
    endTransaction: () => {},
    takeHints: () => ["use moveSymbols for clusters"],
  } as unknown as LspApi;
}

async function makeRunner(path: string) {
  const telemetry = createTelemetry(path);
  if (!telemetry) throw new Error("telemetry should be enabled");
  const { execute } = createExecuteRunner({
    api: stubApi(),
    timeoutMs: 5_000,
    warmup: Promise.resolve(),
    client: { ensureAlive: async () => undefined } as unknown as LspClient,
    telemetry,
  });
  return { execute, telemetry };
}

async function readEvents(path: string): Promise<TelemetryEvent[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

describe("resolveTelemetryPath", () => {
  test("unset or blank means disabled", () => {
    expect(resolveTelemetryPath({})).toBeUndefined();
    expect(resolveTelemetryPath({ CODEMODE_TELEMETRY: "  " })).toBeUndefined();
  });

  test("a path enables telemetry", () => {
    expect(resolveTelemetryPath({ CODEMODE_TELEMETRY: "/tmp/t.jsonl" })).toBe(
      "/tmp/t.jsonl",
    );
  });

  test("createTelemetry without a path is disabled", () => {
    expect(createTelemetry(undefined)).toBeUndefined();
  });
});

describe("execute telemetry", () => {
  test("a successful script logs its ops, docs queries, and hints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemode-telemetry-"));
    const path = join(dir, "usage.jsonl");
    const { execute, telemetry } = await makeRunner(path);

    await execute('await lsp.docs("listFiles");\nawait lsp.listFiles()');
    await telemetry.flush();

    const [event] = await readEvents(path);
    expect(event).toBeDefined();
    expect(event?.ok).toBe(true);
    expect(event?.ops.map((op) => op.op)).toEqual(["docs", "listFiles"]);
    expect(event?.ops[0]?.args).toEqual(['"listFiles"']);
    expect(event?.hints).toEqual(["use moveSymbols for clusters"]);
    expect(typeof event?.durationMs).toBe("number");
  });

  test("a failing script logs ok=false with the error and partial trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemode-telemetry-"));
    const path = join(dir, "usage.jsonl");
    const { execute, telemetry } = await makeRunner(path);

    await execute('await lsp.listFiles();\nawait lsp.readFile("a.ts")');
    await telemetry.flush();

    const [event] = await readEvents(path);
    expect(event?.ok).toBe(false);
    expect(event?.error).toContain("boom");
    expect(event?.ops.map((op) => op.op)).toEqual(["listFiles", "readFile"]);
    expect(event?.ops[1]?.failed).toBe(true);
  });

  test("telemetry write failures never affect the execute result", async () => {
    const { execute, telemetry } = await makeRunner(
      "/nonexistent-dir/usage.jsonl",
    );
    const payload = await execute("1 + 1");
    await telemetry.flush();
    expect(payload.result).toBe("2");
  });
});
