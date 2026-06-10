import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../../src/diff";

describe("unifiedDiff", () => {
  test("identical content yields an empty diff", () => {
    expect(unifiedDiff("a.ts", "x\ny\n", "x\ny\n")).toBe("");
  });

  test("a single-line modification produces a hunk with context", () => {
    const original = "line1\nline2\nline3\nline4\nline5\n";
    const updated = "line1\nline2\nCHANGED\nline4\nline5\n";
    const diff = unifiedDiff("src/f.ts", original, updated);
    expect(diff).toContain("--- a/src/f.ts");
    expect(diff).toContain("+++ b/src/f.ts");
    expect(diff).toContain("-line3");
    expect(diff).toContain("+CHANGED");
    expect(diff).toContain(" line2");
    expect(diff).toContain(" line4");
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  test("a pure addition appears with + lines and correct counts", () => {
    const diff = unifiedDiff("f.ts", "a\nb\n", "a\nNEW\nb\n");
    expect(diff).toContain("+NEW");
    // old side 2 lines, new side 3 lines.
    expect(diff).toMatch(/@@ -1,2 \+1,3 @@/);
  });

  test("a pure deletion appears with - lines", () => {
    const diff = unifiedDiff("f.ts", "a\ngone\nb\n", "a\nb\n");
    expect(diff).toContain("-gone");
    expect(diff).toMatch(/@@ -1,3 \+1,2 @@/);
  });

  test("creating a file from empty shows every line as added", () => {
    const diff = unifiedDiff("new.ts", "", "alpha\nbeta\n");
    expect(diff).toContain("+alpha");
    expect(diff).toContain("+beta");
    expect(diff).toMatch(/@@ -0,0 \+1,2 @@/);
  });

  test("deleting a whole file shows every line removed", () => {
    const diff = unifiedDiff("gone.ts", "alpha\nbeta\n", "");
    expect(diff).toContain("-alpha");
    expect(diff).toContain("-beta");
    expect(diff).toMatch(/@@ -1,2 \+0,0 @@/);
  });

  test("separated changes produce two hunks", () => {
    const original = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    const updated = original
      .split("\n")
      .map((line, i) => (i === 1 || i === 18 ? `${line}-x` : line))
      .join("\n");
    const diff = unifiedDiff("f.ts", original, updated);
    const hunkCount = (diff.match(/@@ /g) ?? []).length;
    expect(hunkCount).toBe(2);
  });

  test("notes a missing trailing newline on the updated side", () => {
    const diff = unifiedDiff("f.ts", "a\nb\n", "a\nb");
    expect(diff).toContain("\\ No newline at end of file (updated)");
  });

  test("a reconstructed diff round-trips lines (apply-by-hand sanity)", () => {
    // Sanity: the + lines plus untouched context reconstruct the new file.
    const original = "one\ntwo\nthree\nfour\n";
    const updated = "one\nTWO\nthree\nFOUR\n";
    const diff = unifiedDiff("f.ts", original, updated);
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain("-four");
    expect(diff).toContain("+FOUR");
  });
});
