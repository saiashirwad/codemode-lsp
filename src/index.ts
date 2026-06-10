#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp-server";

/**
 * Entry point: start the codemode-lsp MCP server over stdio. The workspace root
 * is the process cwd; the client controls it by spawning from the desired dir.
 */
async function main(): Promise<void> {
  const { connect } = createServer({ rootDir: process.cwd() });
  const transport = new StdioServerTransport();
  await connect(transport);
  // The server now owns the transport and runs until stdin closes.
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`codemode-lsp failed to start:\n${message}\n`);
  process.exit(1);
});
