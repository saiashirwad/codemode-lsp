import { describe, expect, test } from "bun:test";
import { analyzeDependencies } from "../../src/dependencies";

/** Zero-based range covering lines [startLine, endLine] of `source`. */
function lineRange(source: string, startLine: number, endLine: number) {
  const lines = source.split("\n");
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: (lines[endLine] ?? "").length },
  };
}

const SOURCE = `import { eq, and } from "drizzle-orm";
import type { Invoice } from "./types";
import { type Snapshot, loadAccount } from "./accounts";
import db from "./db";
import * as helpers from "./helpers";

const TABLE = "payments";

function unrelated(): void {
  helpers.noop();
}

export async function recordPayment(invoice: Invoice): Promise<Snapshot> {
  const rows = await db.select().where(eq(invoice.id, TABLE));
  const account = await loadAccount(invoice.accountId);
  return formatRow(rows, account);
}

function formatRow(rows: unknown, account: unknown): Snapshot {
  return { rows, account } as Snapshot;
}
`;

// recordPayment spans lines 12–17 (zero-based).
const RECORD_RANGE = lineRange(SOURCE, 12, 17);

function analyze(range = RECORD_RANGE, selfName = "recordPayment") {
  return analyzeDependencies({
    fileName: "src/payments.ts",
    sourceText: SOURCE,
    range,
    topLevelNames: ["TABLE", "unrelated", "recordPayment", "formatRow"],
    selfName,
  });
}

describe("analyzeDependencies", () => {
  test("returns only the imports the body actually uses", () => {
    const { imports } = analyze();
    const names = imports.map((dep) => dep.name);
    expect(names).toContain("eq");
    expect(names).toContain("db");
    expect(names).toContain("loadAccount");
    // `and` and `helpers` are imported but unused by recordPayment.
    expect(names).not.toContain("and");
    expect(names).not.toContain("helpers");
  });

  test("carries the source module and type-only flag", () => {
    const { imports } = analyze();
    const byName = new Map(imports.map((dep) => [dep.name, dep]));
    expect(byName.get("eq")?.from).toBe("drizzle-orm");
    expect(byName.get("eq")?.typeOnly).toBe(false);
    // `import type { Invoice }` — whole-clause type-only.
    expect(byName.get("Invoice")?.typeOnly).toBe(true);
    // `{ type Snapshot, loadAccount }` — element-level type-only.
    expect(byName.get("Snapshot")?.typeOnly).toBe(true);
    expect(byName.get("loadAccount")?.typeOnly).toBe(false);
  });

  test("same-file dependencies include used helpers but never the symbol itself", () => {
    const { sameFile } = analyze();
    expect(sameFile).toContain("TABLE");
    expect(sameFile).toContain("formatRow");
    expect(sameFile).not.toContain("recordPayment");
    expect(sameFile).not.toContain("unrelated");
  });

  test("a property access does not count its right-hand side", () => {
    // `invoice.id` must not register a use of an `id` import; conversely
    // unrelated() uses `helpers.noop` — `helpers` counts, `noop` does not.
    const result = analyzeDependencies({
      fileName: "src/payments.ts",
      sourceText: SOURCE,
      range: lineRange(SOURCE, 8, 10),
      topLevelNames: ["TABLE", "unrelated", "recordPayment", "formatRow"],
      selfName: "unrelated",
    });
    expect(result.imports.map((dep) => dep.name)).toEqual(["helpers"]);
    expect(result.sameFile).toEqual([]);
  });

  test("results are sorted for determinism", () => {
    const { imports, sameFile } = analyze();
    expect(imports.map((dep) => dep.name)).toEqual(
      [...imports.map((dep) => dep.name)].sort(),
    );
    expect(sameFile).toEqual([...sameFile].sort());
  });
});
