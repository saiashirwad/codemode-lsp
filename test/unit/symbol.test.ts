import { describe, expect, test } from "bun:test";
import type { DocumentSymbol, Range } from "vscode-languageserver-protocol";
import { SymbolKind } from "vscode-languageserver-protocol";
import {
  buildSymbolInfoTree,
  parseSymbolPath,
  resolveSymbolPath,
} from "../../src/symbol";

function range(startLine: number, endLine: number): Range {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: 1 },
  };
}

function symbol(
  name: string,
  kind: SymbolKind,
  startLine: number,
  endLine: number,
  children?: DocumentSymbol[],
): DocumentSymbol {
  return {
    name,
    kind,
    range: range(startLine, endLine),
    selectionRange: range(startLine, startLine),
    ...(children ? { children } : {}),
  };
}

const fixtureSymbols: DocumentSymbol[] = [
  symbol("Token", SymbolKind.TypeParameter, 0, 0),
  symbol("AuthService", SymbolKind.Class, 2, 20, [
    symbol("constructor", SymbolKind.Constructor, 4, 4),
    symbol("constructor", SymbolKind.Constructor, 5, 5),
    symbol("constructor", SymbolKind.Constructor, 6, 10),
    symbol("validate", SymbolKind.Method, 12, 14),
  ]),
  symbol("createAuthMiddleware", SymbolKind.Function, 22, 26),
];

describe("symbol path parsing", () => {
  test("parses slash paths", () => {
    expect(parseSymbolPath("AuthService/validate")).toEqual([
      { name: "AuthService" },
      { name: "validate" },
    ]);
  });

  test("accepts dot aliases", () => {
    expect(parseSymbolPath("AuthService.validate")).toEqual([
      { name: "AuthService" },
      { name: "validate" },
    ]);
    expect(parseSymbolPath("Outer.Inner/describe")).toEqual([
      { name: "Outer" },
      { name: "Inner" },
      { name: "describe" },
    ]);
  });

  test("parses overload indexes", () => {
    expect(parseSymbolPath("AuthService/constructor[1]")).toEqual([
      { name: "AuthService" },
      { name: "constructor", index: 1 },
    ]);
  });
});

describe("symbol tree conversion and resolution", () => {
  test("adds overload indexes to duplicate sibling paths", () => {
    const auth = buildSymbolInfoTree(fixtureSymbols)[1];
    expect(auth?.children?.map((child) => child.path)).toContain(
      "AuthService/constructor[1]",
    );
  });

  test("resolves nested child paths", () => {
    const resolved = resolveSymbolPath({
      file: "src/auth.ts",
      symbolPath: "AuthService/validate",
      symbols: fixtureSymbols,
    });
    expect(resolved.path).toBe("AuthService/validate");
  });

  test("not-found errors list top-level symbols and relevant children", () => {
    expect(() =>
      resolveSymbolPath({
        file: "src/auth.ts",
        symbolPath: "AuthService/login",
        symbols: fixtureSymbols,
      }),
    ).toThrow(
      /Available top-level symbols: Token, AuthService, createAuthMiddleware[\s\S]*AuthService has children/,
    );
  });

  test("ambiguous overload errors list indexed alternatives", () => {
    expect(() =>
      resolveSymbolPath({
        file: "src/auth.ts",
        symbolPath: "AuthService/constructor",
        symbols: fixtureSymbols,
      }),
    ).toThrow(
      /Available overloads: AuthService\/constructor\[0\], AuthService\/constructor\[1\], AuthService\/constructor\[2\]/,
    );
  });
});
