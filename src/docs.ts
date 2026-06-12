/**
 * Searchable per-op documentation served by the `lsp.docs(query?)` meta-op —
 * the search half of a search-and-execute docs surface (the execution surface
 * stays code mode). MCP clients truncate long tool descriptions; `lsp.help()`
 * returns the whole reference, but that re-spends the very tokens truncation
 * saved. `docs()` lets a script pull exactly the slice it needs: no query is a
 * compact op inventory, a keyword/op-name query returns the matching ops' full
 * signatures, the interfaces they reference, and a relevant worked example.
 *
 * Everything is parsed from src/lsp-types.generated.ts (and WORKED_EXAMPLES),
 * so `lsp-api.ts` stays the single source of truth — there is no second place
 * where an op gets documented.
 */
import {
  LSP_COMMON_INTERFACES,
  LSP_READ_OP_SIGNATURES,
  LSP_WRITE_INTERFACES,
  LSP_WRITE_OP_SIGNATURES,
} from "./lsp-types.generated";
import { WORKED_EXAMPLES } from "./tool-description";

interface OpDoc {
  name: string;
  /** The one-line JSDoc carried over from lsp-api.ts. */
  doc: string;
  /** Full rendered block: JSDoc + typed signature. */
  block: string;
  /** Parameter list without types, e.g. `file, depth?`. */
  params: string;
  /** Return + argument type text, scanned for interface references. */
  types: string;
  write: boolean;
}

const OP_BLOCK_RE = /\/\*\*([\s\S]*?)\*\/\s*\n\s*(\w+)\(([^)]*)\):\s*([^;]+);/g;

function parseOps(source: string, write: boolean): OpDoc[] {
  const ops: OpDoc[] = [];
  for (const match of source.matchAll(OP_BLOCK_RE)) {
    const rawDoc = match[1] ?? "";
    const name = match[2] ?? "";
    const args = match[3] ?? "";
    const returnType = match[4] ?? "";
    const doc = rawDoc.trim();
    const params = args
      .split(",")
      .map((arg) => (arg.split(":")[0] ?? "").trim())
      .filter(Boolean)
      .join(", ");
    ops.push({
      name,
      doc,
      block: `/** ${doc} */\n${name}(${args.trim()}): ${returnType.trim()};`,
      params,
      types: `${args} ${returnType}`,
      write,
    });
  }
  return ops;
}

/** Interface name → full `interface X { ... }` block. */
function parseInterfaces(source: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of source.split(/\n(?=interface )/)) {
    const name = block.match(/^interface (\w+)/)?.[1];
    if (name) blocks.set(name, block.trim());
  }
  return blocks;
}

function opsFor(readonly: boolean): OpDoc[] {
  const ops = parseOps(LSP_READ_OP_SIGNATURES, false);
  if (!readonly) ops.push(...parseOps(LSP_WRITE_OP_SIGNATURES, true));
  return ops;
}

function interfacesFor(readonly: boolean): Map<string, string> {
  const map = parseInterfaces(LSP_COMMON_INTERFACES);
  if (!readonly) {
    for (const [name, block] of parseInterfaces(LSP_WRITE_INTERFACES)) {
      map.set(name, block);
    }
  }
  return map;
}

function firstSentence(doc: string): string {
  const period = doc.indexOf(". ");
  return period === -1 ? doc : doc.slice(0, period + 1);
}

/** Interfaces referenced (transitively) by the matched ops' signatures. */
function referencedInterfaces(
  ops: OpDoc[],
  interfaces: Map<string, string>,
): string[] {
  const included = new Set<string>();
  let frontier = ops.map((op) => op.types).join(" ");
  while (true) {
    let grew = false;
    for (const name of interfaces.keys()) {
      if (included.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(frontier)) {
        included.add(name);
        frontier += ` ${interfaces.get(name)}`;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return [...interfaces.keys()] // declaration order, not discovery order
    .filter((name) => included.has(name))
    .map((name) => interfaces.get(name) as string);
}

const DOCS_PREAMBLE =
  'Call lsp.docs("<op name or keyword>") for full signatures, related types, ' +
  "and a worked example; lsp.help() returns the entire API reference.";

/**
 * Render the docs text for `lsp.docs(query?)`. No query → op inventory with
 * one-liners. A query → matching ops in full (name + JSDoc match, any-token),
 * the interfaces their signatures reference, and up to two worked examples
 * that use a matched op. No match → the op inventory so the caller can retry.
 */
export function renderDocs(readonly: boolean, query?: string): string {
  const ops = opsFor(readonly);
  const trimmed = query?.trim();

  if (!trimmed) {
    const inventory = (write: boolean) =>
      ops
        .filter((op) => op.write === write)
        .map((op) => `- ${op.name}(${op.params}) — ${firstSentence(op.doc)}`)
        .join("\n");
    const sections = readonly
      ? `Read ops:\n${inventory(false)}`
      : `Read ops:\n${inventory(false)}\n\nWrite ops:\n${inventory(true)}`;
    return `${DOCS_PREAMBLE}\n\n${sections}`;
  }

  const tokens = trimmed.toLowerCase().split(/\s+/);
  const matched = ops.filter((op) => {
    const haystack = `${op.name} ${op.doc}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });

  if (matched.length === 0) {
    const names = ops.map((op) => op.name).join(", ");
    return (
      `No ops match "${trimmed}". Available ops: ${names}. ` +
      "Call lsp.docs() with no argument for a one-line summary of each."
    );
  }

  const sections = [matched.map((op) => op.block).join("\n\n")];
  const types = referencedInterfaces(matched, interfacesFor(readonly));
  if (types.length > 0) sections.push(types.join("\n\n"));

  const matchedNames = new Set(matched.map((op) => op.name));
  const examples = WORKED_EXAMPLES.filter(
    (example) =>
      (!readonly || !example.writes) &&
      [...matchedNames].some((name) => example.code.includes(`lsp.${name}(`)),
  ).slice(0, 2);
  for (const example of examples) {
    sections.push(`Example — ${example.title}:\n${example.code}`);
  }

  return sections.join("\n\n");
}
