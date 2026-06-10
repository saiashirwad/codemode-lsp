import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { runSandbox, SandboxError } from "../../src/sandbox";
import { lspBin, sampleFixtureDir } from "../helpers/fixture";

describe("sandbox against the real fixture project (integration)", () => {
  let client: LspClient;
  let api: LspApi;

  beforeEach(() => {
    client = new LspClient({ rootDir: sampleFixtureDir, lspBin });
    api = new LspApi({ rootDir: sampleFixtureDir, client });
  });

  afterEach(async () => {
    await client.stop();
  });

  test(
    "a script chaining listFiles + getSymbols + getSymbolBody returns data",
    async () => {
      const { result } = await runSandbox(
        `const files = await lsp.listFiles("src/**/*.ts");
         const symbols = await lsp.getSymbols("src/auth.ts");
         const auth = symbols.find((s) => s.name === "AuthService");
         const body = await lsp.getSymbolBody("src/auth.ts", "AuthService/validate");
         ({ files, classes: symbols.map((s) => s.name), authKind: auth.kind, body });`,
        { lsp: api },
      );
      const parsed = JSON.parse(result);
      expect(parsed.files).toContain("src/auth.ts");
      expect(parsed.files).toContain("src/users.ts");
      expect(parsed.classes).toContain("AuthService");
      expect(parsed.authKind).toBe("class");
      expect(parsed.body).toContain("validate(token: Token)");
    },
    { timeout: 30_000 },
  );

  test(
    "console output is captured end-to-end",
    async () => {
      const { result, logs } = await runSandbox(
        `const files = await lsp.listFiles("src/**/*.ts");
         console.log("found", files.length, "files");
         console.warn("a warning");
         files.length;`,
        { lsp: api },
      );
      expect(Number(result)).toBeGreaterThan(0);
      expect(logs).toContain("found");
      expect(logs).toContain("[warn] a warning");
    },
    { timeout: 30_000 },
  );

  test(
    "a failing script (bad symbol path) returns the trace + LLM-targeted error",
    async () => {
      let caught: SandboxError | undefined;
      try {
        await runSandbox(
          `await lsp.listFiles("src/**/*.ts");
           await lsp.getSymbols("src/auth.ts");
           await lsp.getSymbolBody("src/auth.ts", "AuthService/doesNotExist");`,
          { lsp: api },
        );
      } catch (error) {
        caught = error as SandboxError;
      }
      expect(caught).toBeInstanceOf(SandboxError);
      const { failure } = caught as SandboxError;
      // The two completed steps appear, then the failed step.
      expect(failure.trace).toContain("completed:");
      expect(failure.trace).toMatch(/1\. listFiles/);
      expect(failure.trace).toMatch(/2\. getSymbols/);
      expect(failure.trace).toContain("failed at:");
      expect(failure.trace).toMatch(/3\. getSymbolBody/);
      // LLM-targeted error lists available symbols/children for self-correction.
      expect(failure.error).toContain("AuthService/doesNotExist");
      expect(failure.error).toContain("Available top-level symbols");
      // Phase 3 is read-only: no rollback sentence yet.
      expect(failure.trace).not.toContain("rolled back");
    },
    { timeout: 30_000 },
  );

  test(
    "scripts can try/catch lsp errors and self-correct mid-script",
    async () => {
      const { result } = await runSandbox(
        `let body;
         try {
           body = await lsp.getSymbolBody("src/auth.ts", "Nope");
         } catch (e) {
           if (!(e instanceof Error)) throw new Error("not an Error instance");
           body = await lsp.getSymbolBody("src/auth.ts", "AuthService/logout");
         }
         body;`,
        { lsp: api },
      );
      expect(JSON.parse(result)).toContain("logout(token: Token)");
    },
    { timeout: 30_000 },
  );

  test(
    "a configured short timeout fires for an async-hanging script",
    async () => {
      await expect(
        runSandbox(
          `await lsp.listFiles("src/**/*.ts");
           await new Promise(() => {});
           1;`,
          { lsp: api, timeoutMs: 500 },
        ),
      ).rejects.toThrow(/timed out after 500ms/);
    },
    { timeout: 30_000 },
  );
});
