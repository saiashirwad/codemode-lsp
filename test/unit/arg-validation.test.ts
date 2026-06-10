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

  test("getDependencies with a missing symbolPath names the signature", async () => {
    // @ts-expect-error deliberate wrong arity
    await expect(api.getDependencies("src/auth.ts")).rejects.toThrow(
      /getDependencies\(file, symbolPath\).*"symbolPath".*missing argument/s,
    );
  });

  test("outgoingCalls rejects a non-string file", async () => {
    await expect(
      api.outgoingCalls(7 as unknown as string, "recordPayment"),
    ).rejects.toThrow(/outgoingCalls\(file, symbolPath\).*"file".*a number/s);
  });

  test("getSymbols rejects a non-integer depth with the meaning spelled out", async () => {
    await expect(api.getSymbols("src/auth.ts", 0)).rejects.toThrow(
      /depth.*positive integer.*top-level/s,
    );
    await expect(api.getSymbols("src/auth.ts", 1.5)).rejects.toThrow(
      /positive integer/,
    );
  });

  test("getDependencyClosure rejects a non-array or empty seedPaths with an example", async () => {
    await expect(
      api.getDependencyClosure("src/auth.ts", "Token" as unknown as string[]),
    ).rejects.toThrow(
      /getDependencyClosure\(file, seedPaths\).*non-empty array.*Example/s,
    );
    await expect(api.getDependencyClosure("src/auth.ts", [])).rejects.toThrow(
      /non-empty array/,
    );
  });

  test("moveSymbol validates all three arguments", async () => {
    // @ts-expect-error deliberate wrong arity
    await expect(api.moveSymbol("src/auth.ts", "Token")).rejects.toThrow(
      /moveSymbol\(file, symbolPath, targetFile\).*"targetFile".*missing argument.*Example/s,
    );
  });

  test("moveSymbols rejects a non-array or empty symbolPaths with an example", async () => {
    await expect(
      api.moveSymbols(
        "src/auth.ts",
        "Token" as unknown as string[],
        "src/t.ts",
      ),
    ).rejects.toThrow(
      /moveSymbols\(file, symbolPaths, targetFile\).*non-empty array.*Example/s,
    );
    await expect(
      api.moveSymbols("src/auth.ts", [], "src/t.ts"),
    ).rejects.toThrow(/non-empty array/);
  });

  test("organizeImports and addMissingImports reject non-string files", async () => {
    await expect(
      api.organizeImports(undefined as unknown as string),
    ).rejects.toThrow(/organizeImports\(file\).*"file".*missing argument/s);
    await expect(api.addMissingImports(3 as unknown as string)).rejects.toThrow(
      /addMissingImports\(file\).*"file".*a number/s,
    );
  });
});
