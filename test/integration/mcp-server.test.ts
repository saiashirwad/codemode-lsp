import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp-server";
import { lspBin, sampleFixtureDir, tempFixture } from "../helpers/fixture";

interface ExecutePayload {
  result: string;
  logs: string;
  changes: unknown[];
}

describe("execute tool via the MCP SDK (integration)", () => {
  let created: ReturnType<typeof createServer>;
  let client: Client;

  beforeEach(async () => {
    created = createServer({ rootDir: sampleFixtureDir, lspBin });
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
  });

  async function execute(code: string): Promise<ExecutePayload> {
    const response = (await client.callTool({
      name: "execute",
      arguments: { code },
    })) as { content: Array<{ type: string; text: string }> };
    const text = response.content[0]?.text ?? "";
    return JSON.parse(text) as ExecutePayload;
  }

  test("lists the single execute tool, description includes write ops", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["execute"]);
    expect(tools[0]?.description).toContain("last expression");
    // Default (read-write) mode advertises the write ops.
    expect(tools[0]?.description).toContain("renameSymbol");
    expect(tools[0]?.description).toContain("Write operations available");
  });

  test(
    "lsp.help() returns the full tool description from inside a script",
    async () => {
      const { tools } = await client.listTools();
      const payload = await execute("await lsp.help()");
      expect(JSON.parse(payload.result)).toBe(tools[0]?.description);
    },
    { timeout: 30_000 },
  );

  test(
    "an MCP client can explore the fixture project end-to-end",
    async () => {
      const payload = await execute(
        `const files = await lsp.listFiles("src/**/*.ts");
         const symbols = await lsp.getSymbols("src/auth.ts");
         const validate = await lsp.getSymbolBody("src/auth.ts", "AuthService/validate");
         console.log("explored", files.length, "files");
         ({ fileCount: files.length, hasAuthService: symbols.some((s) => s.name === "AuthService"), validate });`,
      );
      const result = JSON.parse(payload.result);
      expect(result.fileCount).toBeGreaterThan(0);
      expect(result.hasAuthService).toBe(true);
      expect(result.validate).toContain("validate(token: Token)");
      expect(payload.logs).toContain("explored");
      // Phase 3 is read-only: changes is always empty.
      expect(payload.changes).toEqual([]);
    },
    { timeout: 30_000 },
  );

  test(
    "recovers transparently after the language server dies between calls",
    async () => {
      const before = await execute(
        `(await lsp.getSymbols("src/auth.ts")).length`,
      );
      expect(Number(JSON.parse(before.result))).toBeGreaterThan(0);

      // Simulate a crash between execute calls. The eager health check at the
      // start of the next execute must respawn + re-handshake the server
      // without the client seeing an error (PRD § Crash recovery).
      await created.client.killServer();

      const after = await execute(
        `(await lsp.getSymbols("src/auth.ts")).length`,
      );
      expect(JSON.parse(after.result)).toBe(JSON.parse(before.result));
    },
    { timeout: 60_000 },
  );

  test(
    "a failing script returns the error and operation trace",
    async () => {
      const payload = await execute(
        `await lsp.listFiles("src/**/*.ts");
         await lsp.getSymbolBody("src/auth.ts", "AuthService/missing");`,
      );
      expect(payload.result).toContain("Available top-level symbols");
      expect(payload.result).toContain("completed:");
      expect(payload.result).toContain("failed at:");
      expect(payload.result).toMatch(/1\. listFiles/);
      expect(payload.changes).toEqual([]);
    },
    { timeout: 30_000 },
  );
});

describe("execute tool in CODEMODE_READONLY mode (integration)", () => {
  let created: ReturnType<typeof createServer>;
  let client: Client;

  beforeEach(async () => {
    created = createServer({
      rootDir: sampleFixtureDir,
      lspBin,
      readonly: true,
    });
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
  });

  test("the tool description omits write ops", async () => {
    const { tools } = await client.listTools();
    expect(tools[0]?.description).not.toContain("Write operations available");
    expect(tools[0]?.description).not.toContain("renameSymbol");
    // Read ops still documented.
    expect(tools[0]?.description).toContain("readFile");
  });

  test(
    "write ops are absent from the sandbox; read ops work",
    async () => {
      const response = (await client.callTool({
        name: "execute",
        arguments: {
          code: `({ hasWrite: typeof lsp.writeFile, hasRead: typeof lsp.readFile })`,
        },
      })) as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(response.content[0]?.text ?? "{}");
      const parsed = JSON.parse(payload.result);
      expect(parsed.hasWrite).toBe("undefined");
      expect(parsed.hasRead).toBe("function");
    },
    { timeout: 30_000 },
  );
});

describe("execute tool write flush via the MCP SDK (integration)", () => {
  // Writes hit disk on success, so this block runs against a temp copy of the
  // fixture (never the shared, read-only sampleFixtureDir).
  let fixture: ReturnType<typeof tempFixture>;
  let created: ReturnType<typeof createServer>;
  let client: Client;

  beforeEach(async () => {
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

  test(
    "a write script returns reviewable diffs in changes",
    async () => {
      const response = (await client.callTool({
        name: "execute",
        arguments: {
          code: `await lsp.replaceSymbolBody("src/users.ts", "isAdmin",
              "export const isAdmin = (user) => true;");
           "ok";`,
        },
      })) as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(
        response.content[0]?.text ?? "{}",
      ) as ExecutePayload;
      expect(JSON.parse(payload.result)).toBe("ok");
      expect(payload.changes).toHaveLength(1);
      const change = payload.changes[0] as {
        file: string;
        kind: string;
        diff: string;
      };
      expect(change.file).toBe("src/users.ts");
      expect(change.kind).toBe("modified");
      expect(change.diff).toContain("--- a/src/users.ts");
    },
    { timeout: 30_000 },
  );
});
