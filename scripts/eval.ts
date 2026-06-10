/**
 * Eval suite runner (PRD § Testing, Build Plan phase 6).
 *
 * Measures Success Criterion #4 — type defs in the tool description suffice
 * for correct code generation — by giving a real LLM agent each benchmark task
 * with ONLY the codemode-lsp `execute` tool and scoring the outcome
 * deterministically (see eval-tasks.ts).
 *
 * The agent is headless Claude Code (`claude -p`), so runs bill a Claude
 * subscription rather than an API key. Built-in tools (Read/Grep/Edit/Bash/…)
 * are disabled and only the MCP execute tool is allowed, so the agent cannot
 * route around the API under test. Run on demand, not in CI:
 *
 *   bun run eval                 # all 17 tasks (on sonnet)
 *   bun run eval --task rename-finduser
 *   bun run eval --model opus
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { lspBin, tempFixture } from "../test/helpers/fixture";
import {
  createEvalContext,
  EVAL_TASKS,
  type EvalTask,
  type GradeResult,
} from "./eval-tasks";

const repoRoot = join(import.meta.dir, "..");
const serverEntry = join(repoRoot, "src", "index.ts");

/**
 * Default eval model. Pinned (rather than inheriting the user's Claude Code
 * default) so pass rates are comparable across runs; override with --model.
 */
const DEFAULT_MODEL = "sonnet";

/** Built-in Claude Code tools the agent must not use to solve the task. */
const DISALLOWED_TOOLS = [
  "Task",
  "Bash",
  "BashOutput",
  "KillShell",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookRead",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
].join(",");

const PROMPT_SUFFIX =
  "\n\nUse only the codemode execute tool to inspect or modify code — do not" +
  " ask questions. When you are done, state your final answer in plain text.";

interface AgentRun {
  answer: string;
  turns: number;
  durationMs: number;
  /** Every script the agent passed to the execute tool, in order. */
  scripts: string[];
  error?: string;
}

function runAgent(task: EvalTask, dir: string, model: string): AgentRun {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      codemode: {
        command: "bun",
        args: ["run", serverEntry],
        env: { CODEMODE_LSP_BIN: lspBin },
      },
    },
  });
  const args = [
    "-p",
    task.prompt + PROMPT_SUFFIX,
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__codemode__execute",
    "--disallowedTools",
    DISALLOWED_TOOLS,
    // stream-json (NDJSON, needs --verbose) instead of json: the per-message
    // events carry the execute tool_use blocks, so graders can judge script
    // SHAPE (op profile, call count), not just the final disk state.
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "16",
    "--model",
    model,
  ];

  const started = Date.now();
  const proc = spawnSync("claude", args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Date.now() - started;

  if (proc.error) {
    return {
      answer: "",
      turns: 0,
      durationMs,
      scripts: [],
      error: String(proc.error),
    };
  }
  interface StreamEvent {
    type?: string;
    result?: string;
    num_turns?: number;
    is_error?: boolean;
    subtype?: string;
    message?: {
      content?: Array<{
        type?: string;
        name?: string;
        input?: { code?: string };
      }>;
    };
  }
  const events = proc.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line): StreamEvent[] => {
      try {
        return [JSON.parse(line) as StreamEvent];
      } catch {
        return [];
      }
    });
  const scripts = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content ?? [])
    .filter(
      (block) =>
        block.type === "tool_use" && block.name === "mcp__codemode__execute",
    )
    .flatMap((block) => (block.input?.code ? [block.input.code] : []));
  const result = events.find((event) => event.type === "result");
  if (!result) {
    return {
      answer: "",
      turns: 0,
      durationMs,
      scripts,
      error: `no result event in claude output (exit ${proc.status}): ${proc.stderr.slice(0, 500)}`,
    };
  }
  return {
    answer: result.result ?? "",
    turns: result.num_turns ?? 0,
    durationMs,
    scripts,
    error: result.is_error ? (result.subtype ?? "agent error") : undefined,
  };
}

interface TaskOutcome {
  task: EvalTask;
  verdict: GradeResult;
  run: AgentRun;
}

function parseArgs(argv: string[]): { taskIds: string[]; model?: string } {
  const taskIds: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task" && argv[i + 1]) taskIds.push(argv[++i] as string);
    else if (argv[i] === "--model" && argv[i + 1]) model = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return { taskIds, model };
}

function main(): void {
  const { taskIds, model = DEFAULT_MODEL } = parseArgs(process.argv.slice(2));

  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).error) {
    console.error(
      "The eval needs the Claude Code CLI (`claude`) on PATH — it runs the" +
        " agent under your Claude subscription. Install: https://claude.com/claude-code",
    );
    process.exit(2);
  }

  const tasks =
    taskIds.length > 0
      ? EVAL_TASKS.filter((task) => taskIds.includes(task.id))
      : EVAL_TASKS;
  if (tasks.length === 0) {
    console.error(
      `No matching tasks. Known ids: ${EVAL_TASKS.map((t) => t.id).join(", ")}`,
    );
    process.exit(2);
  }

  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    process.stdout.write(`${task.id} (${task.kind}) … `);
    const fixture = tempFixture();
    try {
      const run = runAgent(task, fixture.dir, model);
      const verdict = run.error
        ? { pass: false, detail: run.error }
        : task.grade(createEvalContext(fixture.dir, run.answer, run.scripts));
      outcomes.push({ task, verdict, run });
      const seconds = (run.durationMs / 1000).toFixed(0);
      console.log(
        `${verdict.pass ? "PASS" : "FAIL"} (${run.turns} turns, ` +
          `${run.scripts.length} scripts, ${seconds}s)` +
          (verdict.pass ? "" : ` — ${verdict.detail}`),
      );
      if (!verdict.pass && run.answer) {
        console.log(`  final answer was: ${run.answer.slice(0, 300)}`);
      }
    } finally {
      fixture.cleanup();
    }
  }

  const passed = outcomes.filter((o) => o.verdict.pass).length;
  const rate = Math.round((passed / outcomes.length) * 100);
  console.log(`\n${passed}/${outcomes.length} tasks passed (${rate}%)`);
  if (outcomes.length === EVAL_TASKS.length) {
    const date = new Date().toISOString().slice(0, 10);
    console.log(
      "\nREADME snippet:\n" +
        `Eval pass rate: **${passed}/${outcomes.length} (${rate}%)** — ` +
        `headless Claude Code (${model}), ${date}.`,
    );
  }
  process.exit(passed === outcomes.length ? 0 : 1);
}

main();
