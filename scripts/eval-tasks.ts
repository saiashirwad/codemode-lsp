/**
 * Benchmark tasks for the eval suite (PRD § Testing, Build Plan phase 6).
 *
 * Each task gives an LLM agent a natural-language job against a fresh copy of
 * the fixture project, with ONLY the `execute` tool available. Grading is
 * deterministic: read tasks check the agent's final answer text, write tasks
 * check the resulting disk state. Every task also carries `reference` — the
 * execute scripts a competent model could plausibly write — which
 * test/integration/eval-tasks.test.ts runs against the real server to prove
 * the task is solvable and the grader accepts a correct solution. That keeps
 * the benchmark honest without spending tokens.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalContext {
  /** The agent's final answer (plain text after it stops calling the tool). */
  answer: string;
  /** Workspace root for this task (a temp copy of the fixture project). */
  dir: string;
  /**
   * Every script the agent passed to the execute tool, in order. Lets graders
   * judge SHAPE, not just outcome — the field lesson is that a wasteful path
   * (hand-spliced moves, per-symbol loops, redundant cleanup calls) can still
   * land the right disk state, so outcome-only grading can't see steering
   * regressions.
   */
  scripts: string[];
  read(file: string): string | null;
  exists(file: string): boolean;
}

export function createEvalContext(
  dir: string,
  answer: string,
  scripts: string[] = [],
): EvalContext {
  return {
    answer,
    dir,
    scripts,
    read(file: string): string | null {
      const abs = join(dir, file);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
    exists(file: string): boolean {
      return existsSync(join(dir, file));
    },
  };
}

export interface GradeResult {
  pass: boolean;
  detail: string;
}

export interface EvalTask {
  id: string;
  kind: "read" | "write";
  prompt: string;
  grade(ctx: EvalContext): GradeResult;
  /** Plausible solution: execute-tool scripts run in order by the self-check. */
  reference: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word match (word = bounded by non-word chars). */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text);
}

function requireWords(answer: string, words: string[]): GradeResult {
  const missing = words.filter((word) => !hasWord(answer, word));
  return missing.length === 0
    ? { pass: true, detail: "answer mentions: " + words.join(", ") }
    : { pass: false, detail: "answer missing: " + missing.join(", ") };
}

function fail(detail: string): GradeResult {
  return { pass: false, detail };
}

function ok(detail: string): GradeResult {
  return { pass: true, detail };
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "explore-files",
    kind: "read",
    prompt:
      "List the TypeScript source files in this project. Name each file in your final answer.",
    grade: (ctx) =>
      requireWords(ctx.answer, ["auth.ts", "broken.ts", "users.ts"]),
    reference: ['await lsp.listFiles("src/**/*.ts");'],
  },
  {
    id: "count-src-directory",
    kind: "read",
    prompt:
      "How many files are in the src directory of this project? Give the exact number in your final answer.",
    grade: (ctx) =>
      hasWord(ctx.answer, "3")
        ? ok("answer gives the correct count (3)")
        : fail("answer does not give the count 3"),
    // Deliberately uses the bare directory name — the call every observed
    // session reached for first — to exercise the "src" ⇒ "src/**" DWIM.
    reference: ['const files = await lsp.listFiles("src");\nfiles.length;'],
  },
  {
    id: "auth-service-outline",
    kind: "read",
    prompt:
      "What methods does the AuthService class in src/auth.ts define? Name each method in your final answer.",
    grade: (ctx) =>
      requireWords(ctx.answer, [
        "validate",
        "validateToken",
        "refreshSession",
        "logout",
      ]),
    reference: [
      `const symbols = await lsp.getSymbols("src/auth.ts");
const auth = symbols.find((s) => s.name === "AuthService");
auth.children.map((c) => c.kind + " " + c.path);`,
    ],
  },
  {
    id: "find-validate-callers",
    kind: "read",
    prompt:
      "Which functions in this codebase call AuthService's validate method (the one returning User | undefined)? Report the file and the containing function for each call site.",
    grade: (ctx) =>
      requireWords(ctx.answer, ["createAuthMiddleware", "auth.ts"]),
    reference: [
      `const refs = await lsp.findReferences("src/auth.ts", "AuthService/validate");
refs.map((r) => r.file + " line " + r.line + " in " + r.symbolPath);`,
    ],
  },
  {
    id: "exported-symbols-users",
    kind: "read",
    prompt:
      "List the names of all exported symbols in src/users.ts in your final answer.",
    grade: (ctx) =>
      requireWords(ctx.answer, [
        "User",
        "UserRole",
        "findUser",
        "isAdmin",
        "Outer",
        "router",
      ]),
    reference: [
      `const symbols = await lsp.getSymbols("src/users.ts");
symbols.filter((s) => s.exported).map((s) => s.name);`,
    ],
  },
  {
    id: "locate-finduser-definition",
    kind: "read",
    prompt:
      "On which file and line is the function findUser defined? Give both in your final answer.",
    grade: (ctx) => {
      const source = ctx.read("src/users.ts") ?? "";
      const line =
        source
          .split("\n")
          .findIndex((l) => l.includes("export function findUser")) + 1;
      if (line === 0) return fail("fixture drift: findUser not found");
      if (!hasWord(ctx.answer, "users.ts"))
        return fail("answer does not name src/users.ts");
      if (!hasWord(ctx.answer, String(line)))
        return fail(`answer does not give line ${line}`);
      return ok(`names src/users.ts line ${line}`);
    },
    reference: [
      `const matches = await lsp.findSymbol("findUser");
matches.map((m) => m.file + ":" + m.startLine);`,
    ],
  },
  {
    id: "sessions-delete-callsites",
    kind: "read",
    prompt:
      "Find every place where sessions.delete is called and report which method each call site is inside.",
    grade: (ctx) => requireWords(ctx.answer, ["refreshSession", "logout"]),
    reference: [
      `const hits = await lsp.searchText("sessions\\\\.delete\\\\(");
const symbols = await lsp.getSymbols("src/auth.ts");
const auth = symbols.find((s) => s.name === "AuthService");
const methods = [];
for (const hit of hits) {
  const m = (auth.children ?? []).find(
    (c) => hit.line >= c.startLine && hit.line <= c.endLine,
  );
  if (m && !methods.includes(m.path)) methods.push(m.path);
}
methods;`,
    ],
  },
  {
    id: "detect-type-error",
    kind: "read",
    prompt:
      "One file in this project has a type error. Find it and report the file name and what the error says.",
    grade: (ctx) => {
      if (!hasWord(ctx.answer, "broken.ts"))
        return fail("answer does not name src/broken.ts");
      if (!/not assignable/i.test(ctx.answer))
        return fail('answer does not describe the "not assignable" error');
      return ok("names broken.ts and the assignability error");
    },
    reference: [
      `const files = await lsp.listFiles("src/**/*.ts");
const found = [];
for (const file of files) {
  const diagnostics = await lsp.getDiagnostics(file);
  for (const d of diagnostics) {
    if (d.severity === "error") found.push(d.file + ": " + d.message);
  }
}
found;`,
    ],
  },
  {
    id: "nested-class-symbol",
    kind: "read",
    prompt:
      "src/users.ts has a class Inner nested inside the class Outer. What does Inner's describe() method return? Quote the returned expression in your final answer.",
    grade: (ctx) =>
      /Outer\.label|['"`]outer['"`]/.test(ctx.answer)
        ? ok("quotes Outer.label (or its value)")
        : fail('answer does not quote Outer.label / "outer"'),
    reference: [
      'await lsp.getSymbols("src/users.ts");',
      'await lsp.getSymbolBody("src/users.ts", "Outer/Inner/describe");',
    ],
  },
  {
    id: "rename-finduser",
    kind: "write",
    prompt:
      "Rename the function findUser to lookupUser across the whole codebase.",
    grade: (ctx) => {
      const users = ctx.read("src/users.ts") ?? "";
      const auth = ctx.read("src/auth.ts") ?? "";
      if (!/function lookupUser/.test(users))
        return fail("src/users.ts does not declare lookupUser");
      if (!/lookupUser\(/.test(auth))
        return fail("src/auth.ts call site not renamed");
      if (hasWord(users, "findUser") || hasWord(auth, "findUser"))
        return fail("findUser still present");
      return ok("renamed in declaration and all references");
    },
    reference: [
      'await lsp.renameSymbol("src/users.ts", "findUser", "lookupUser");',
    ],
  },
  {
    id: "logout-returns-boolean",
    kind: "write",
    prompt:
      "Change the logout method of AuthService in src/auth.ts so it returns a boolean indicating whether the token existed, and update its return type accordingly.",
    grade: (ctx) => {
      const auth = ctx.read("src/auth.ts") ?? "";
      if (!/logout\([^)]*\)\s*:\s*boolean/.test(auth))
        return fail("logout signature does not return boolean");
      if (!/sessions\.delete\(token\)/.test(auth))
        return fail("logout no longer deletes the session");
      return ok("logout returns boolean and still deletes the session");
    },
    reference: [
      `await lsp.replaceSymbolBody("src/auth.ts", "AuthService/logout",
  \`logout(token: Token): boolean {
    return this.sessions.delete(token);
  }\`);`,
    ],
  },
  {
    id: "add-admin-role-const",
    kind: "write",
    prompt:
      'Add a new exported constant ADMIN_ROLE with the value "admin" to src/users.ts, placed above the registry variable.',
    grade: (ctx) => {
      const users = ctx.read("src/users.ts") ?? "";
      const match = users.match(
        /export const ADMIN_ROLE[^=\n]*=\s*["']admin["']/,
      );
      if (!match) return fail('no export const ADMIN_ROLE = "admin"');
      const constIndex = users.indexOf(match[0]);
      const registryIndex = users.indexOf("const registry");
      if (registryIndex === -1) return fail("registry variable disappeared");
      if (constIndex > registryIndex)
        return fail("ADMIN_ROLE is not above registry");
      return ok("ADMIN_ROLE added above registry");
    },
    reference: [
      `await lsp.insertBeforeSymbol("src/users.ts", "registry",
  'export const ADMIN_ROLE = "admin";\\n\\n');`,
    ],
  },
  {
    id: "delete-refresh-session",
    kind: "write",
    prompt: "Remove the refreshSession method from AuthService in src/auth.ts.",
    grade: (ctx) => {
      const auth = ctx.read("src/auth.ts") ?? "";
      if (hasWord(auth, "refreshSession"))
        return fail("refreshSession still present");
      if (!hasWord(auth, "validateToken") || !hasWord(auth, "logout"))
        return fail("other AuthService methods were damaged");
      return ok("refreshSession removed, class otherwise intact");
    },
    reference: [
      'await lsp.deleteSymbol("src/auth.ts", "AuthService/refreshSession");',
    ],
  },
  {
    id: "create-roles-module",
    kind: "write",
    prompt:
      "Create a new module src/roles.ts that exports a function canEdit(user: User): boolean which returns true only for admins. Import the User type from ./users and reuse the existing isAdmin helper.",
    grade: (ctx) => {
      const roles = ctx.read("src/roles.ts");
      if (roles === null) return fail("src/roles.ts was not created");
      if (!/export function canEdit|export const canEdit/.test(roles))
        return fail("roles.ts does not export canEdit");
      if (!/from ["']\.\/users["']/.test(roles))
        return fail("roles.ts does not import from ./users");
      if (!hasWord(roles, "isAdmin"))
        return fail("roles.ts does not reuse isAdmin");
      return ok("roles.ts created with canEdit reusing isAdmin");
    },
    reference: [
      `const result = await lsp.writeFile("src/roles.ts",
  \`import { isAdmin, type User } from "./users";

export function canEdit(user: User): boolean {
  return isAdmin(user);
}
\`);
result.diagnostics.filter((d) => d.severity === "error");`,
    ],
  },
  {
    id: "delete-broken-file",
    kind: "write",
    prompt: "Delete the file src/broken.ts from the project.",
    grade: (ctx) =>
      ctx.exists("src/broken.ts")
        ? fail("src/broken.ts still exists")
        : ok("src/broken.ts deleted"),
    reference: ['await lsp.deleteFile("src/broken.ts");'],
  },
  {
    id: "extract-registry-module",
    kind: "write",
    prompt:
      "Extract the registry array out of src/users.ts: create src/registry.ts that exports the registry constant (same data, typed User[]), and update src/users.ts to import registry from the new module instead of declaring it. Make sure you introduce no type errors.",
    grade: (ctx) => {
      const registry = ctx.read("src/registry.ts");
      const users = ctx.read("src/users.ts") ?? "";
      if (registry === null) return fail("src/registry.ts was not created");
      if (!/export const registry/.test(registry))
        return fail("registry.ts does not export the registry constant");
      if (!/from ["']\.\/registry["']/.test(users))
        return fail("users.ts does not import from ./registry");
      if (/const registry\s*[:=]/.test(users))
        return fail("users.ts still declares registry locally");
      if (!hasWord(users, "findUser"))
        return fail("users.ts was damaged (findUser missing)");
      return ok("registry extracted and re-imported");
    },
    reference: [
      `await lsp.writeFile("src/registry.ts",
  \`import type { User } from "./users";

export const registry: User[] = [
  { id: "u1", name: "Ada", role: "admin" },
  { id: "u2", name: "Lin", role: "member" },
];
\`);
await lsp.deleteSymbol("src/users.ts", "registry");
const result = await lsp.insertBeforeSymbol("src/users.ts", "User",
  'import { registry } from "./registry";\\n\\n');
result.diagnostics.filter((d) => d.severity === "error");`,
    ],
  },
  {
    id: "extract-session-cluster",
    kind: "write",
    prompt:
      "Extract the session core out of src/auth.ts into a new module" +
      " src/session.ts: move the AuthService class and the Token type, and" +
      " update every import so the project still type-checks." +
      " createAuthMiddleware stays behind in src/auth.ts. Use as few execute" +
      " calls as you can.",
    // Graded on SHAPE as well as outcome: this is the standing field-test task
    // in miniature, and the field lesson is that agents can land the right
    // disk state via 150 lines of hand-rolled discovery, per-symbol move
    // loops, and redundant cleanup calls. The cheap path is getDependencyClosure
    // → one moveSymbols → one checkProject.
    grade: (ctx) => {
      const session = ctx.read("src/session.ts");
      const auth = ctx.read("src/auth.ts") ?? "";
      if (session === null) return fail("src/session.ts was not created");
      if (!/export class AuthService/.test(session))
        return fail("session.ts does not export AuthService");
      if (!/export type Token/.test(session))
        return fail("session.ts does not export Token");
      if (/class AuthService|type Token\s*=/.test(auth))
        return fail("auth.ts still declares the moved symbols");
      if (!hasWord(auth, "createAuthMiddleware"))
        return fail("createAuthMiddleware did not stay in auth.ts");
      if (!/from ["']\.\/session["']/.test(auth))
        return fail("auth.ts does not import from ./session");
      if (!ctx.scripts.some((script) => /\bmoveSymbols?\s*\(/.test(script)))
        return fail(
          "no script used moveSymbol/moveSymbols — the move was hand-spliced",
        );
      if (ctx.scripts.length > 2)
        return fail(
          `took ${ctx.scripts.length} execute calls — the cheap path is 1 (closure + moveSymbols + checkProject)`,
        );
      return ok(
        `extracted via moveSymbol(s) in ${ctx.scripts.length} execute call(s)`,
      );
    },
    reference: [
      `const cluster = await lsp.getDependencyClosure("src/auth.ts", ["AuthService"]);
const moved = await lsp.moveSymbols("src/auth.ts", cluster.map((s) => s.path), "src/session.ts");
const check = await lsp.checkProject();
({ moved: cluster.map((s) => s.path), filesChanged: moved.filesChanged, projectErrors: check.errorCount });`,
    ],
  },
];
