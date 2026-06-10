import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp-server";
import { WORKED_EXAMPLES } from "../../src/tool-description";
import { lspBin, tempFixture } from "../helpers/fixture";

interface ExecutePayload {
  result: string;
  logs: string;
  changes: Array<{ file: string; kind: string; diff: string }>;
}

/**
 * Golden scripts (PRD § Testing): every worked example in the tool description
 * runs VERBATIM against the fixture project, so the documentation can never
 * silently rot. Each example has concrete assertions here — editing an example
 * means updating its assertions.
 */
describe("golden scripts — the tool-description examples run as-is", () => {
  let fixture: ReturnType<typeof tempFixture>;
  let created: ReturnType<typeof createServer>;
  let client: Client;

  beforeEach(async () => {
    // Two examples write; run all of them against a throwaway fixture copy.
    fixture = tempFixture();
    created = createServer({ rootDir: fixture.dir, lspBin });
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      created.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await created.close();
    fixture.cleanup();
  });

  function exampleCode(title: string): string {
    const found = WORKED_EXAMPLES.find((example) => example.title === title);
    if (!found) throw new Error(`No worked example titled "${title}"`);
    return found.code;
  }

  async function execute(code: string): Promise<ExecutePayload> {
    const response = (await client.callTool({
      name: "execute",
      arguments: { code },
    })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(response.content[0]?.text ?? "") as ExecutePayload;
  }

  test("every worked example has a golden test in this file", () => {
    expect(WORKED_EXAMPLES.map((example) => example.title).sort()).toEqual([
      "Batch refactor: migrate every caller",
      "Explore a project",
      "Extract a cluster into a new module (move + verify)",
      "Trace the call graph",
      "Write, then check diagnostics",
    ]);
  });

  test(
    "Extract a cluster into a new module (move + verify)",
    async () => {
      const payload = await execute(
        exampleCode("Extract a cluster into a new module (move + verify)"),
      );
      const result = JSON.parse(payload.result) as {
        moved: string[];
        filesChanged: string[];
        projectErrors: number;
      };
      // The closure pulled in Token (AuthService's same-file dependency) but
      // NOT createAuthMiddleware (a dependent, which stays behind).
      expect(result.moved).toEqual(["Token", "AuthService"]);
      expect(result.filesChanged).toEqual(["src/auth.ts", "src/session.ts"]);
      // checkProject sees the whole project — including the intentional
      // type error in src/broken.ts. The move itself adds no errors.
      expect(result.projectErrors).toBe(1);
      expect(payload.changes.map((change) => change.file).sort()).toEqual([
        "src/auth.ts",
        "src/session.ts",
      ]);
      const onDisk = readFileSync(join(fixture.dir, "src/session.ts"), "utf8");
      expect(onDisk).toContain("export type Token");
      expect(onDisk).toContain("export class AuthService");
      // The stayed-behind dependent now imports the moved cluster.
      const source = readFileSync(join(fixture.dir, "src/auth.ts"), "utf8");
      expect(source).toContain("createAuthMiddleware");
      expect(source).toContain('from "./session"');
    },
    { timeout: 30_000 },
  );

  test(
    "Trace the call graph",
    async () => {
      const payload = await execute(exampleCode("Trace the call graph"));
      const result = JSON.parse(payload.result) as {
        calledBy: string[];
        calls: string[];
      };
      expect(result.calledBy).toEqual(["src/auth.ts::createAuthMiddleware"]);
      // findUser only calls Array.prototype.find — outside the workspace, so
      // library calls are filtered out.
      expect(result.calls).toEqual([]);
      expect(payload.changes).toEqual([]);
    },
    { timeout: 30_000 },
  );

  test(
    "Explore a project",
    async () => {
      const payload = await execute(exampleCode("Explore a project"));
      const outline = JSON.parse(payload.result) as Array<{
        file: string;
        symbols: string[];
      }>;
      expect(outline.map((entry) => entry.file)).toEqual([
        "src/auth.ts",
        "src/broken.ts",
        "src/users.ts",
      ]);
      const auth = outline.find((entry) => entry.file === "src/auth.ts");
      expect(auth?.symbols).toContain("class AuthService");
      expect(payload.changes).toEqual([]);
    },
    { timeout: 30_000 },
  );

  test(
    "Batch refactor: migrate every caller",
    async () => {
      const payload = await execute(
        exampleCode("Batch refactor: migrate every caller"),
      );
      const result = JSON.parse(payload.result) as {
        updatedFunctions: number;
      };
      // The fixture has exactly one caller outside AuthService itself:
      // createAuthMiddleware.
      expect(result.updatedFunctions).toBe(1);
      expect(payload.changes).toHaveLength(1);
      expect(payload.changes[0]?.file).toBe("src/auth.ts");
      expect(payload.changes[0]?.kind).toBe("modified");
      expect(payload.changes[0]?.diff).toContain("service.validateToken(");
      // The flush hit disk.
      const onDisk = readFileSync(join(fixture.dir, "src/auth.ts"), "utf8");
      expect(onDisk).toContain("service.validateToken(token)");
    },
    { timeout: 30_000 },
  );

  test(
    "Write, then check diagnostics",
    async () => {
      const payload = await execute(
        exampleCode("Write, then check diagnostics"),
      );
      const result = JSON.parse(payload.result) as {
        ok: boolean;
        errors: string[];
      };
      // The replacement is type-clean, so the write-then-check loop reports ok.
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(payload.changes.map((change) => change.file)).toEqual([
        "src/auth.ts",
      ]);
      const onDisk = readFileSync(join(fixture.dir, "src/auth.ts"), "utf8");
      expect(onDisk).toContain('this.sessions.delete(token + "-r")');
    },
    { timeout: 30_000 },
  );
});
