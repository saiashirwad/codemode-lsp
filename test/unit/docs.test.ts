import { describe, expect, test } from "bun:test";
import { renderDocs } from "../../src/docs";
import { READ_OP_NAMES, WRITE_OP_NAMES } from "../../src/sandbox";

describe("renderDocs inventory (no query)", () => {
  test("lists every op with a one-liner", () => {
    const docs = renderDocs(false);
    for (const op of [...READ_OP_NAMES, ...WRITE_OP_NAMES]) {
      expect(docs).toContain(`- ${op}(`);
    }
    expect(docs).toContain("Read ops:");
    expect(docs).toContain("Write ops:");
  });

  test("readonly mode omits every write op", () => {
    const docs = renderDocs(true);
    for (const op of READ_OP_NAMES) {
      expect(docs).toContain(`- ${op}(`);
    }
    for (const op of WRITE_OP_NAMES) {
      expect(docs).not.toContain(op);
    }
    expect(docs).not.toContain("Write ops:");
  });

  test("inventory params carry no types", () => {
    const docs = renderDocs(false);
    expect(docs).toContain("- getSymbols(file, depth?) —");
    expect(docs).not.toContain("file: string");
  });
});

describe("renderDocs query", () => {
  test("an op name returns its full signature, types, and an example", () => {
    const docs = renderDocs(false, "moveSymbols");
    expect(docs).toContain(
      "moveSymbols(file: string, symbolPaths: string[], targetFile: string): Promise<MoveSymbolResult>;",
    );
    // Referenced interfaces come along, transitively.
    expect(docs).toContain("interface MoveSymbolResult");
    expect(docs).toContain("interface WriteResult");
    expect(docs).toContain("interface Diagnostic");
    // The cluster-extraction worked example uses moveSymbols.
    expect(docs).toContain("lsp.moveSymbols(");
  });

  test("a keyword matches against the JSDoc text", () => {
    const docs = renderDocs(false, "rename");
    expect(docs).toContain("renameSymbol(");
  });

  test("matching is case-insensitive", () => {
    expect(renderDocs(false, "MOVESYMBOLS")).toContain("moveSymbols(");
  });

  test("readonly hides write ops from query results", () => {
    const docs = renderDocs(true, "move");
    expect(docs).not.toContain("moveSymbol(");
    expect(docs).not.toContain("MoveSymbolResult");
  });

  test("no match lists the available op names", () => {
    const docs = renderDocs(false, "zzzznotanop");
    expect(docs).toContain('No ops match "zzzznotanop"');
    for (const op of [...READ_OP_NAMES, ...WRITE_OP_NAMES]) {
      expect(docs).toContain(op);
    }
  });

  test("at most two examples are included", () => {
    // "symbol" matches many ops, which collectively appear in >2 examples.
    const docs = renderDocs(false, "symbol");
    const count = (docs.match(/Example — /g) ?? []).length;
    expect(count).toBeLessThanOrEqual(2);
  });
});
