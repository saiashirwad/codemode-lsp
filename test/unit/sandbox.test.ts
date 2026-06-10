import { describe, expect, test } from "bun:test";
import type { LspApi } from "../../src/lsp-api";
import {
  formatTrace,
  LOG_TRUNCATION_MARKER,
  normalizeCode,
  RESULT_TRUNCATION_MARKER,
  runSandbox,
  SandboxError,
  type TraceEntry,
} from "../../src/sandbox";

/** A stub LspApi exposing only the read ops the sandbox wraps. */
function stubApi(overrides: Partial<Record<string, unknown>> = {}): LspApi {
  const base: Record<string, unknown> = {
    readFile: async () => "contents",
    getSymbolBody: async () => "body",
    getSymbols: async () => [{ name: "Foo", path: "Foo" }],
    findSymbol: async () => [],
    findReferences: async () => [{ file: "a.ts" }, { file: "b.ts" }],
    goToDefinition: async () => ({ file: "a.ts", line: 1, column: 1 }),
    searchText: async () => [],
    listFiles: async () => ["src/a.ts", "src/b.ts"],
    getDiagnostics: async () => [],
  };
  return { ...base, ...overrides } as unknown as LspApi;
}

describe("normalizeCode", () => {
  test("returns the last expression statement value", () => {
    const { source } = normalizeCode("const x = 2;\nx + 3");
    expect(source).toContain("const x = 2;");
    expect(source).toContain("return (x + 3)");
  });

  test("a single bare expression is returned", () => {
    const { source } = normalizeCode("1 + 1");
    expect(source).toContain("return (1 + 1)");
  });

  test("invokes a bare async arrow function", () => {
    const { source } = normalizeCode("async () => { return 42; }");
    expect(source).toContain("return await (async () => { return 42; })()");
  });

  test("a script ending in a non-expression returns undefined", () => {
    const { source } = normalizeCode("const x = 1;\nconst y = 2;");
    expect(source).toContain("return undefined;");
  });

  test("strips a trailing semicolon from the returned expression", () => {
    const { source } = normalizeCode("({ a: 1 });");
    expect(source).toContain("return (({ a: 1 }))");
  });

  test("throws a clear error on unparseable code", () => {
    expect(() => normalizeCode("const = ;")).toThrow(/Could not parse script/);
  });
});

describe("runSandbox surface", () => {
  test("bare statements run and the last expression is the result", async () => {
    const { result } = await runSandbox("const x = 21;\nx * 2", {
      lsp: stubApi(),
    });
    expect(result).toBe("42");
  });

  test("an async arrow returning a Promise is auto-awaited", async () => {
    const { result } = await runSandbox(
      "async () => { return await lsp.readFile('a.ts'); }",
      { lsp: stubApi() },
    );
    expect(result).toBe('"contents"');
  });

  test("a returned Promise from a bare expression is awaited", async () => {
    const { result } = await runSandbox("lsp.listFiles()", {
      lsp: stubApi(),
    });
    expect(JSON.parse(result)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("path.join is available; fetch/process/setTimeout/require are not", async () => {
    const { result } = await runSandbox(
      `({
        joined: path.join("a", "b", "c.ts"),
        base: path.basename("a/b/c.ts"),
        dir: path.dirname("a/b/c.ts"),
        ext: path.extname("a/b/c.ts"),
        hasFetch: typeof fetch,
        hasProcess: typeof process,
        hasSetTimeout: typeof setTimeout,
        hasRequire: typeof require,
        hasBun: typeof Bun,
      })`,
      { lsp: stubApi() },
    );
    const parsed = JSON.parse(result);
    expect(parsed.joined).toBe("a/b/c.ts");
    expect(parsed.base).toBe("c.ts");
    expect(parsed.dir).toBe("a/b");
    expect(parsed.ext).toBe(".ts");
    expect(parsed.hasFetch).toBe("undefined");
    expect(parsed.hasProcess).toBe("undefined");
    expect(parsed.hasSetTimeout).toBe("undefined");
    expect(parsed.hasRequire).toBe("undefined");
    expect(parsed.hasBun).toBe("undefined");
  });

  test("injected functions' .constructor cannot reach the host realm", async () => {
    const { result } = await runSandbox(
      `({
        viaPath: path.join.constructor("return typeof process")(),
        viaConsole: console.log.constructor("return typeof process")(),
        // lsp.* are async wrappers, so their constructor is AsyncFunction —
        // calling it returns a sandbox-realm promise that must be awaited.
        viaLsp: await lsp.listFiles.constructor("return typeof process")(),
      })`,
      { lsp: stubApi() },
    );
    const parsed = JSON.parse(result);
    // The wrapper's constructor is the sandbox realm's own Function/AsyncFunction,
    // which has no access to host `process` — so the escape resolves to undefined.
    expect(parsed.viaPath).toBe("undefined");
    expect(parsed.viaConsole).toBe("undefined");
    expect(parsed.viaLsp).toBe("undefined");
  });

  test("JS builtins (JSON/Math/Map) are present", async () => {
    const { result } = await runSandbox(
      "JSON.stringify({ m: Math.max(1, 2), size: new Map([['a',1]]).size })",
      { lsp: stubApi() },
    );
    expect(JSON.parse(JSON.parse(result))).toEqual({ m: 2, size: 1 });
  });

  test("captures console.log/warn/error in order", async () => {
    const { logs } = await runSandbox(
      `console.log("one"); console.warn("two"); console.error("three"); 1`,
      { lsp: stubApi() },
    );
    expect(logs).toBe("one\n[warn] two\n[error] three");
  });

  test("scripts can try/catch lsp errors as real Errors", async () => {
    const { result } = await runSandbox(
      `try { await lsp.getSymbolBody("x.ts", "Nope"); return "no throw"; }
       catch (e) { return e instanceof Error ? "caught: " + e.message : "not error"; }`,
      {
        lsp: stubApi({
          getSymbolBody: async () => {
            throw new Error('Symbol "Nope" not found');
          },
        }),
      },
    );
    expect(JSON.parse(result)).toBe('caught: Symbol "Nope" not found');
  });
});

describe("result + log truncation", () => {
  test("result truncates at the cap with the exact marker", async () => {
    const { result } = await runSandbox(`"x".repeat(60000)`, {
      lsp: stubApi(),
    });
    expect(result.endsWith(RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(result.length).toBe(50_000 + RESULT_TRUNCATION_MARKER.length);
  });

  test("logs truncate at the cap with the exact marker", async () => {
    const { logs } = await runSandbox(
      `for (let i = 0; i < 2000; i++) console.log("x".repeat(10)); 1`,
      { lsp: stubApi() },
    );
    expect(logs.endsWith(LOG_TRUNCATION_MARKER)).toBe(true);
    expect(logs.length).toBe(10_000 + LOG_TRUNCATION_MARKER.length);
  });
});

describe("non-serializable results", () => {
  test("returning a function throws an LLM-targeted error", async () => {
    await expect(runSandbox("() => 1", { lsp: stubApi() })).rejects.toThrow(
      /function.*cannot be serialized/,
    );
  });

  test("returning a circular object throws an explanatory error", async () => {
    await expect(
      runSandbox("const a = {}; a.self = a; a", { lsp: stubApi() }),
    ).rejects.toThrow(/circular references/);
  });

  test("an un-awaited lsp call nested in the result names the path and suggests await", async () => {
    // Observed failure mode: `{ files: lsp.listFiles() }` serializes as {} and
    // the model debugs the wrong thing for several turns.
    await expect(
      runSandbox("({ files: lsp.listFiles() })", { lsp: stubApi() }),
    ).rejects.toThrow(/Promise at "result\.files".*forget.*await/s);
  });

  test("an un-awaited call inside an array names the index", async () => {
    await expect(
      runSandbox("[lsp.readFile('a.ts')]", { lsp: stubApi() }),
    ).rejects.toThrow(/Promise at "result\[0\]"/);
  });
});

describe("uncaptured-last-statement hint", () => {
  test("a script ending in an if block explains its undefined result", async () => {
    // Field report: `if (Array.isArray(refs)) { refs.map(...) } else {...}` as
    // the last statement returned a bare `undefined` with no explanation.
    const { result } = await runSandbox(
      "const xs = [1, 2];\nif (xs.length > 0) { xs.map((x) => x * 2); } else { xs; }",
      { lsp: stubApi() },
    );
    expect(result).toContain("undefined — note");
    expect(result).toContain("an if statement");
    expect(result).toContain("top-level");
  });

  test("a trailing for loop gets the same hint", async () => {
    const { result } = await runSandbox(
      "const out = [];\nfor (const x of [1]) { out.push(x); }",
      { lsp: stubApi() },
    );
    expect(result).toContain("a for...of loop");
  });

  test("a return inside a trailing if block still wins — no hint", async () => {
    const { result } = await runSandbox(
      'if (1 < 2) { return "yes"; } else { return "no"; }',
      { lsp: stubApi() },
    );
    expect(result).toBe('"yes"');
  });

  test("a genuinely-undefined trailing expression stays a plain undefined", async () => {
    const { result } = await runSandbox("console.log('hi'); undefined", {
      lsp: stubApi(),
    });
    expect(result).toBe("undefined");
  });
});

describe("timeout", () => {
  test("an async-hanging script fails with a timeout error", async () => {
    await expect(
      runSandbox("await new Promise(() => {}); 1", {
        lsp: stubApi(),
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out after 100ms/);
  });
});

describe("operation trace", () => {
  test("formatTrace lists completed steps then the failed step", () => {
    const entries: TraceEntry[] = [
      {
        op: "findReferences",
        args: ['"src/api.ts"', '"handleRequest"'],
        outcome: "14 results",
        failed: false,
      },
      {
        op: "getSymbolBody",
        args: ['"src/b.ts"', '"Foo/bar"'],
        outcome: 'Symbol "Foo/bar" not found',
        failed: true,
      },
    ];
    const formatted = formatTrace(entries);
    expect(formatted).toContain("completed:");
    expect(formatted).toContain(
      '  1. findReferences("src/api.ts", "handleRequest") → 14 results',
    );
    expect(formatted).toContain("failed at:");
    expect(formatted).toContain(
      '  2. getSymbolBody("src/b.ts", "Foo/bar") → Symbol "Foo/bar" not found',
    );
  });

  test("a failing script surfaces the trace with completed steps", async () => {
    let caught: SandboxError | undefined;
    try {
      await runSandbox(
        `await lsp.listFiles();
         await lsp.findReferences("src/a.ts", "x");
         await lsp.getSymbolBody("src/b.ts", "Missing");`,
        {
          lsp: stubApi({
            getSymbolBody: async () => {
              throw new Error('Symbol "Missing" not found in "src/b.ts".');
            },
          }),
        },
      );
    } catch (error) {
      caught = error as SandboxError;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    const { failure } = caught as SandboxError;
    expect(failure.trace).toContain("completed:");
    expect(failure.trace).toContain("  1. listFiles() → 2 results");
    expect(failure.trace).toContain(
      '  2. findReferences("src/a.ts", "x") → 2 results',
    );
    expect(failure.trace).toContain("failed at:");
    expect(failure.trace).toContain(
      '  3. getSymbolBody("src/b.ts", "Missing") → Symbol "Missing" not found',
    );
    expect(failure.error).toContain('Symbol "Missing" not found');
  });

  test("trace has no rollback line in Phase 3 (read-only)", () => {
    const formatted = formatTrace([
      { op: "listFiles", args: [], outcome: "ok", failed: true },
    ]);
    expect(formatted).not.toContain("rolled back");
  });
});
