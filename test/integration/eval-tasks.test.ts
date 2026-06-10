import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createEvalContext,
  EVAL_TASKS,
  type EvalTask,
} from "../../scripts/eval-tasks";
import { createServer } from "../../src/mcp-server";
import { lspBin, tempFixture } from "../helpers/fixture";

interface ExecutePayload {
  result: string;
  logs: string;
  changes: Array<{ file: string; kind: string; diff: string }>;
}

/**
 * Eval-suite self-check (PRD § Testing, phase 6): every benchmark task's
 * reference solution runs against the real server, and its grader must accept
 * the outcome. This proves — without spending tokens — that each task is
 * solvable with the documented API and that the graders recognize a correct
 * solution. If a task or grader rots, this fails before the eval ever runs.
 */
describe("eval tasks — reference solutions pass their graders", () => {
  let fixture: ReturnType<typeof tempFixture>;
  let created: ReturnType<typeof createServer>;
  let client: Client;

  beforeEach(async () => {
    fixture = tempFixture();
    created = createServer({ rootDir: fixture.dir, lspBin });
    client = new Client({ name: "eval-self-check", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      created.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await created.close();
    fixture.cleanup();
  });

  async function execute(code: string): Promise<ExecutePayload> {
    const response = (await client.callTool({
      name: "execute",
      arguments: { code },
    })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(response.content[0]?.text ?? "") as ExecutePayload;
  }

  async function runReference(task: EvalTask): Promise<string> {
    let lastResult = "";
    for (const script of task.reference) {
      const payload = await execute(script);
      lastResult = payload.result;
    }
    return lastResult;
  }

  test("task list shape: 15 tasks, unique ids, both kinds covered", () => {
    expect(EVAL_TASKS).toHaveLength(15);
    expect(new Set(EVAL_TASKS.map((task) => task.id)).size).toBe(15);
    expect(EVAL_TASKS.some((task) => task.kind === "read")).toBe(true);
    expect(EVAL_TASKS.some((task) => task.kind === "write")).toBe(true);
  });

  for (const task of EVAL_TASKS) {
    test(
      `${task.id} (${task.kind})`,
      async () => {
        const answer = await runReference(task);
        // The reference's last execute result stands in for the agent's final
        // answer: read graders accept it because the facts they check for
        // appear in the returned data; write graders check disk state.
        const verdict = task.grade(createEvalContext(fixture.dir, answer));
        if (!verdict.pass) {
          console.error(
            `grader rejected reference for ${task.id}: ${verdict.detail}\nanswer was: ${answer}`,
          );
        }
        expect(verdict.pass).toBe(true);
      },
      { timeout: 60_000 },
    );
  }
});
