import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Position,
  type SymbolInformation,
  SymbolKind,
} from "vscode-languageserver-protocol";
import { LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import { tempFixture } from "../helpers/fixture";

function position(line: number, character = 0): Position {
  return { line, character };
}

function workspaceSymbol(options: {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  containerName?: string;
}): SymbolInformation {
  return {
    name: options.name,
    kind: options.kind,
    location: {
      uri: pathToFileURL(options.file).href,
      range: {
        start: position(options.line),
        end: position(options.line, 1),
      },
    },
    containerName: options.containerName,
  };
}

function apiWithWorkspaceSymbols(
  rootDir: string,
  symbols: SymbolInformation[],
): LspApi {
  const client = {
    workspaceSymbol: async () => symbols,
  } as unknown as LspClient;
  return new LspApi({ rootDir, client });
}

describe("workspace symbol ambiguity", () => {
  test("ambiguous exact bare names throw with candidate details", async () => {
    const fixture = tempFixture();
    try {
      const api = apiWithWorkspaceSymbols(fixture.dir, [
        workspaceSymbol({
          name: "duplicate",
          kind: SymbolKind.Function,
          file: join(fixture.dir, "src", "auth.ts"),
          line: 36,
        }),
        workspaceSymbol({
          name: "duplicate",
          kind: SymbolKind.Variable,
          file: join(fixture.dir, "src", "users.ts"),
          line: 8,
        }),
      ]);

      let thrown: unknown;
      try {
        await api.findSymbol("duplicate");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : "";
      expect(message).toContain(
        'Symbol "duplicate" is ambiguous across the workspace.',
      );
      expect(message).toContain(
        "src/auth.ts: duplicate (function, exported: true)",
      );
      expect(message).toContain(
        "src/users.ts: duplicate (variable, exported: false)",
      );
      expect(message).toContain("getSymbols(file)");
      expect(message).toContain("SymbolInfo.path");
    } finally {
      fixture.cleanup();
    }
  });

  test("broad bare workspace searches return candidates when no exact duplicate exists", async () => {
    const fixture = tempFixture();
    try {
      const api = apiWithWorkspaceSymbols(fixture.dir, [
        workspaceSymbol({
          name: "duplicateAlpha",
          kind: SymbolKind.Function,
          file: join(fixture.dir, "src", "auth.ts"),
          line: 36,
        }),
        workspaceSymbol({
          name: "duplicateBeta",
          kind: SymbolKind.Variable,
          file: join(fixture.dir, "src", "users.ts"),
          line: 8,
        }),
      ]);

      const results = await api.findSymbol("duplicate");
      expect(results.map((symbol) => symbol.name)).toEqual([
        "duplicateAlpha",
        "duplicateBeta",
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});
