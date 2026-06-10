import { describe, expect, test } from "bun:test";
import { LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import { sampleFixtureDir } from "../helpers/fixture";

/**
 * Argument validation (field report finding #2): wrong-shape calls must throw
 * LLM-targeted errors naming the expected signature and an example — not raw
 * JS errors like "input.trim is not a function" or ENOENT on a symbol name
 * misused as a file path. Validation fires before any client/server work, so a
 * bare stub client suffices.
 */
describe("lsp.* argument validation", () => {
  const api = new LspApi({
    rootDir: sampleFixtureDir,
    client: {} as LspClient,
  });

  test("findReferences with a missing symbolPath names the signature", async () => {
    // @ts-expect-error deliberate wrong arity
    await expect(api.findReferences("src/auth.ts")).rejects.toThrow(
      /findReferences\(file, symbolPath\).*"symbolPath".*missing argument.*Example/s,
    );
  });

  test("findReferences with positional numbers points at the file argument", async () => {
    await expect(
      api.findReferences(69 as unknown as string, 23 as unknown as string),
    ).rejects.toThrow(/"file" must be a non-empty string but got a number/);
  });

  test("a symbol name passed as the only getSymbolBody argument is caught", async () => {
    // @ts-expect-error deliberate wrong arity
    await expect(api.getSymbolBody("readApiJson")).rejects.toThrow(
      /getSymbolBody\(file, symbolPath\).*get file and symbolPath from getSymbols/s,
    );
  });

  test("renameSymbol validates all three arguments", async () => {
    await expect(
      api.renameSymbol(
        "src/auth.ts",
        "AuthService/validate",
        null as unknown as string,
      ),
    ).rejects.toThrow(/"newName" must be a non-empty string but got null/);
  });

  test("writeFile rejects a non-string content but names the argument", async () => {
    await expect(
      api.writeFile("src/new.ts", { text: "x" } as unknown as string),
    ).rejects.toThrow(/"content" must be a string but got an object/);
  });

  test("getDiagnostics rejects a non-string file", async () => {
    await expect(api.getDiagnostics(123 as unknown as string)).rejects.toThrow(
      /getDiagnostics\(file\?\).*got a number/s,
    );
  });

  test("searchText rejects a non-string pattern", async () => {
    await expect(api.searchText(/foo/ as unknown as string)).rejects.toThrow(
      /searchText\(pattern, glob\?\).*"pattern"/s,
    );
  });

  test("incomingCalls with a missing symbolPath names the signature", async () => {
    // @ts-expect-error deliberate wrong arity
    await expect(api.incomingCalls("src/auth.ts")).rejects.toThrow(
      /incomingCalls\(file, symbolPath\).*"symbolPath".*missing argument/s,
    );
  });

  test("outgoingCalls rejects a non-string file", async () => {
    await expect(
      api.outgoingCalls(7 as unknown as string, "recordPayment"),
    ).rejects.toThrow(/outgoingCalls\(file, symbolPath\).*"file".*a number/s);
  });
});
