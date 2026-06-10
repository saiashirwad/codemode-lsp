import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp-server";
import { lspBin, sampleFixtureDir } from "../helpers/fixture";

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

  test("lists the single execute tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["execute"]);
    expect(tools[0]?.description).toContain("last expression");
  });

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
