/**
 * Minimal unified-diff generator. Used to render each flushed file's change in the
 * `execute` result so the calling agent (or a human) can review the edit without
 * re-reading files.
 *
 * The algorithm is a straightforward Myers-style LCS over lines, grouped into
 * hunks with the standard 3 lines of context. Correctness over cleverness: the
 * buffer already holds original + final content, so the diff is nearly free.
 */

interface DiffOp {
  /** " " context, "-" deletion, "+" addition. */
  kind: " " | "-" | "+";
  line: string;
}

/** Split into lines, preserving a trailing-newline distinction. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline yields a final empty element we drop; its absence is
  // reported via the "\ No newline at end of file" marker below.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function endsWithNewline(text: string): boolean {
  return text.length > 0 && text.endsWith("\n");
}

/**
 * Longest-common-subsequence table over two line arrays, walked back into a
 * sequence of context/delete/insert ops in original order.
 */
function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]. Flat array indexed by i*(m+1)+j.
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const av = a[i] as string;
    const bv = b[j] as string;
    if (av === bv) {
      ops.push({ kind: " ", line: av });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "-", line: av });
      i += 1;
    } else {
      ops.push({ kind: "+", line: bv });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "+", line: b[j] as string });
    j += 1;
  }
  return ops;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

const CONTEXT = 3;

/** Group ops into hunks with up to {@link CONTEXT} lines of surrounding context. */
function buildHunks(ops: DiffOp[]): Hunk[] {
  // Indices of ops that are changes (not context).
  const changeIndices = ops
    .map((op, index) => (op.kind === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changeIndices.length === 0) return [];

  const hunks: Hunk[] = [];
  let cursor = 0;
  while (cursor < changeIndices.length) {
    const first = changeIndices[cursor] ?? 0;
    const start = Math.max(0, first - CONTEXT);
    let end = Math.min(ops.length - 1, first + CONTEXT);
    // Extend the hunk while the next change is close enough to share context.
    let next = cursor + 1;
    while (
      next < changeIndices.length &&
      (changeIndices[next] ?? 0) - end <= CONTEXT
    ) {
      end = Math.min(ops.length - 1, (changeIndices[next] ?? 0) + CONTEXT);
      next += 1;
    }
    cursor = next;

    // Compute 1-based line numbers for the hunk header by counting ops before
    // `start` that belong to the old/new sides.
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < start; k += 1) {
      const kind = ops[k]?.kind;
      if (kind !== "+") oldLine += 1;
      if (kind !== "-") newLine += 1;
    }

    const hunkLines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k <= end; k += 1) {
      const op = ops[k];
      if (!op) continue;
      hunkLines.push(`${op.kind}${op.line}`);
      if (op.kind !== "+") oldCount += 1;
      if (op.kind !== "-") newCount += 1;
    }
    hunks.push({
      oldStart: oldLine,
      oldCount,
      newStart: newLine,
      newCount,
      lines: hunkLines,
    });
  }
  return hunks;
}

/**
 * Produce a unified diff of `original` → `updated` for `file`. Returns "" when the
 * two are byte-identical (no change to render).
 */
export function unifiedDiff(
  file: string,
  original: string,
  updated: string,
): string {
  if (original === updated) return "";
  const aLines = splitLines(original);
  const bLines = splitLines(updated);
  const ops = lineDiff(aLines, bLines);
  const hunks = buildHunks(ops);

  // When the only change is a trailing newline (line arrays are equal), there are
  // no hunks — but the content still differs. Emit a header + the marker so the
  // change is not silently invisible.
  if (hunks.length === 0) {
    const out = [`--- a/${file}`, `+++ b/${file}`];
    if (original !== "" && !endsWithNewline(original)) {
      out.push("\\ No newline at end of file (original)");
    }
    if (updated !== "" && !endsWithNewline(updated)) {
      out.push("\\ No newline at end of file (updated)");
    }
    return out.length > 2 ? `${out.join("\n")}\n` : "";
  }

  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const hunk of hunks) {
    // A zero-count side starts at line 0 (unified-diff convention for empty side).
    const oldStart = hunk.oldCount === 0 ? 0 : hunk.oldStart;
    const newStart = hunk.newCount === 0 ? 0 : hunk.newStart;
    const oldRange =
      hunk.oldCount === 1 ? `${oldStart}` : `${oldStart},${hunk.oldCount}`;
    const newRange =
      hunk.newCount === 1 ? `${newStart}` : `${newStart},${hunk.newCount}`;
    out.push(`@@ -${oldRange} +${newRange} @@`);
    out.push(...hunk.lines);
  }
  // Note a missing trailing newline on either side, matching `diff` conventions.
  if (original !== "" && !endsWithNewline(original)) {
    out.push("\\ No newline at end of file (original)");
  }
  if (updated !== "" && !endsWithNewline(updated)) {
    out.push("\\ No newline at end of file (updated)");
  }
  return `${out.join("\n")}\n`;
}
