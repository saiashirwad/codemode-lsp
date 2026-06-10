import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  generatedPath,
  generateTypesModuleSource,
} from "../../scripts/generate-types";
import { READ_OP_NAMES, WRITE_OP_NAMES } from "../../src/sandbox";
import {
  buildToolDescription,
  renderLspTypes,
  WORKED_EXAMPLES,
} from "../../src/tool-description";

describe("generated type definitions", () => {
  test(
    "src/lsp-types.generated.ts is up to date (else run `bun run generate:types`)",
    () => {
      const onDisk = readFileSync(generatedPath, "utf8");
      expect(onDisk).toBe(generateTypesModuleSource());
    },
    // Building the tsc program for declaration emit takes a few seconds.
    { timeout: 60_000 },
  );

  test("full mode renders the read + write surface", () => {
    const types = renderLspTypes(false);
    expect(types).toContain("interface SymbolInfo");
    expect(types).toContain("interface WriteResult");
    expect(types).toContain("declare const lsp: {");
    expect(types).toContain("readFile(file: string): Promise<string>;");
    expect(types).toContain(
      "renameSymbol(file: string, symbolPath: string, newName: string): Promise<WriteResult>;",
    );
  });

  test("readonly mode strips write ops and WriteResult", () => {
    const types = renderLspTypes(true);
    expect(types).toContain("readFile(file: string): Promise<string>;");
    expect(types).toContain("getDiagnostics(file?: string)");
    for (const op of WRITE_OP_NAMES) {
      expect(types).not.toContain(op);
    }
    expect(types).not.toContain("WriteResult");
  });

  test("both modes expose the help() escape hatch", () => {
    for (const readonly of [false, true]) {
      expect(renderLspTypes(readonly)).toContain("help(): Promise<string>;");
    }
  });
});

describe("tool description", () => {
  test("every placeholder is replaced", () => {
    for (const readonly of [false, true]) {
      const description = buildToolDescription(readonly);
      expect(description).not.toContain("{{types}}");
      expect(description).not.toContain("{{writeSemantics}}");
      expect(description).not.toContain("{{examples}}");
    }
  });

  test("embeds the generated types", () => {
    const description = buildToolDescription(false);
    expect(description).toContain("interface SymbolInfo");
    expect(description).toContain("declare const lsp: {");
  });

  test("truncation-resilient ordering: rules and op signatures precede interfaces and examples", () => {
    // MCP clients may cut long descriptions; a field report showed an agent
    // losing everything after the interfaces. The load-bearing parts (rules,
    // lsp.* signatures) must come first, examples last.
    const description = buildToolDescription(false);
    const rules = description.indexOf("## Rules");
    const signatures = description.indexOf("declare const lsp: {");
    const interfaces = description.indexOf("interface SymbolInfo");
    const examples = description.indexOf("## Examples");
    expect(rules).toBeGreaterThan(-1);
    expect(rules).toBeLessThan(signatures);
    expect(signatures).toBeLessThan(interfaces);
    expect(interfaces).toBeLessThan(examples);
  });

  test("the head names every op and the lsp.help() escape hatch", () => {
    // Clients truncate long descriptions at arbitrary points; whatever survives
    // must include the full op inventory and the way to recover the rest.
    for (const readonly of [false, true]) {
      const head = buildToolDescription(readonly).slice(0, 450);
      expect(head).toContain("await lsp.help()");
      for (const op of READ_OP_NAMES) {
        expect(head).toContain(op);
      }
      for (const op of WRITE_OP_NAMES) {
        if (readonly) {
          expect(head).not.toContain(op);
        } else {
          expect(head).toContain(op);
        }
      }
    }
  });

  test("full mode includes every worked example; readonly only read examples", () => {
    const full = buildToolDescription(false);
    for (const example of WORKED_EXAMPLES) {
      expect(full).toContain(example.code);
    }
    const readonlyDescription = buildToolDescription(true);
    for (const example of WORKED_EXAMPLES) {
      if (example.writes) {
        expect(readonlyDescription).not.toContain(example.code);
      } else {
        expect(readonlyDescription).toContain(example.code);
      }
    }
  });
});
