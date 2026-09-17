import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseAntigravityOutput, type Worker } from "../src/adapters/antigravity.js";
import type { ParallelPlanner, Planner, Reviewer } from "../src/adapters/codex.js";
import type { HarnessConfig } from "../src/config.js";
import { findOutOfScopeFiles } from "../src/git.js";
import {
  InteractiveDelegationService,
  type DelegationSnapshot,
  type InteractiveDelegationApi,
} from "../src/interactive-delegation.js";
import { createInteractiveMcpServer } from "../src/mcp-server.js";
import { Orchestrator } from "../src/orchestrator.js";
import { assertDisjointTaskPaths, ParallelOrchestrator } from "../src/parallel-orchestrator.js";
import type { ParallelPlan } from "../src/parallel-types.js";
import { assertTransition } from "../src/state-machine.js";
import { ReviewResultSchema } from "../src/types.js";
import type {
  CheckResult,
  LeaderPlan,
  ProcessResult,
  ReviewRunResult,
  TaskSpec,
  WorkerRunResult,
} from "../src/types.js";
import { assertAllowedValidationCommand } from "../src/validation.js";

function processResult(cwd: string): ProcessResult {
  return {
    command: "fake",
    args: [],
    cwd,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
  };
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
}

function testConfig(): HarnessConfig {
  return {
    dataDirectory: ".harness",
    maxRevisionRounds: 2,
    requireCleanRepository: true,
    router: { baseUrl: "http://127.0.0.1:20128/v1", required: false },
    codex: { command: "codex", reasoningEffort: "high", timeoutMs: 10_000 },
    antigravity: { command: "agy", effort: "high", timeoutMs: 10_000 },
    validation: {
      timeoutMs: 10_000,
      allowedExecutables: [path.basename(process.execPath).toLowerCase()],
    },
    parallel: { maxWorkers: 2, maxTasks: 4 },
  };
}

async function waitForDelegation(
  service: InteractiveDelegationService,
  id: string,
  expected: DelegationSnapshot["state"],
): Promise<DelegationSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await service.getStatus(id);
    if (snapshot.state === expected) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Delegation ${id} did not reach ${expected}`);
}

test("parses Antigravity native envelope and preserves conversation id", () => {
  const result = parseAntigravityOutput(JSON.stringify({
    conversation_id: "conversation-1",
    status: "SUCCESS",
    response: "",
    structured_output: {
      status: "success",
      summary: "done",
      files_changed: ["src/index.ts"],
      checks_attempted: ["npm test"],
      residual_risks: [],
    },
  }));

  assert.equal(result.status, "success");
  assert.equal(result.conversation_id, "conversation-1");
});

test("accepts nullable structured review locations", () => {
  const result = ReviewResultSchema.parse({
    verdict: "approved",
    summary: "No findings",
    findings: [{
      severity: "low",
      title: "Informational",
      detail: "No concrete source location",
      path: null,
      line: null,
    }],
    acceptance_criteria: [],
  });

  assert.equal(result.findings[0]?.path, null);
  assert.equal(result.findings[0]?.line, null);
});

test("rejects Antigravity soft-denied actions", () => {
  assert.throws(
    () => parseAntigravityOutput(JSON.stringify({
      status: "SUCCESS",
      response: "",
      denied_actions: [{ tool: "read_file", reason: "permission" }],
    })),
    /denied required actions/,
  );
});

test("scope matching supports recursive path globs", () => {
  assert.deepEqual(
    findOutOfScopeFiles(
      ["src/index.ts", "src/nested/file.ts", "README.md"],
      ["src/**", "README.md"],
    ),
    [],
  );
  assert.deepEqual(findOutOfScopeFiles([".env"], ["src/**"]), [".env"]);
});

test("state machine rejects invalid transitions", () => {
  assert.doesNotThrow(() => assertTransition("RECEIVED", "PLANNING"));
  assert.throws(() => assertTransition("RECEIVED", "APPROVED"), /Invalid job state transition/);
});

test("validation commands must use an allowlisted executable", () => {
  assert.doesNotThrow(() => assertAllowedValidationCommand(
    { command: "npm.cmd", args: ["test"] },
    ["npm.cmd"],
  ));
  assert.throws(() => assertAllowedValidationCommand(
    { command: "powershell", args: ["-Command", "Remove-Item", "."] },
    ["npm.cmd"],
  ));
});

test("orchestrator runs plan, worker, review, rework, and approval in an isolated worktree", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-phase1-"));
  const repoPath = path.join(tempRoot, "repo");
  const harnessRoot = path.join(tempRoot, "harness");
  await mkdir(repoPath, { recursive: true });
  await mkdir(harnessRoot, { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "fixture\n", "utf8");
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Harness Test"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "fixture"]);

  const plan: LeaderPlan = {
    objective: "Create a result file",
    allowed_paths: ["src/**"],
    acceptance_criteria: ["src/result.txt exists"],
    checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
    worker_instructions: "Create src/result.txt",
  };
  const planner: Planner = {
    async plan() {
      return plan;
    },
  };

  let workerRuns = 0;
  const worker: Worker = {
    async run(task: TaskSpec): Promise<WorkerRunResult> {
      workerRuns += 1;
      await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
      await writeFile(
        path.join(task.worktree_path, "src", "result.txt"),
        workerRuns === 1 ? "first\n" : "revised\n",
        "utf8",
      );
      return {
        result: {
          status: "success",
          summary: "implemented",
          files_changed: ["src/result.txt"],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: "conversation-1",
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  let reviewRuns = 0;
  const reviewer: Reviewer = {
    async review(task: TaskSpec, _checks: CheckResult[]): Promise<ReviewRunResult> {
      reviewRuns += 1;
      return {
        result: reviewRuns === 1
          ? {
              verdict: "changes_requested",
              summary: "revise once",
              findings: [{ severity: "medium", title: "Needs revision", detail: "Update content" }],
              acceptance_criteria: [{ criterion: "src/result.txt exists", status: "passed", evidence: "diff" }],
            }
          : {
              verdict: "approved",
              summary: "approved",
              findings: [],
              acceptance_criteria: [{ criterion: "src/result.txt exists", status: "passed", evidence: "diff" }],
            },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const orchestrator = new Orchestrator(testConfig(), harnessRoot, { planner, worker, reviewer });
    const summary = await orchestrator.run("Create the result", repoPath);
    assert.equal(summary.state, "APPROVED");
    assert.equal(summary.revisionRound, 1);
    assert.equal(workerRuns, 2);
    assert.equal(reviewRuns, 2);
    assert.ok(summary.worktreePath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive delegation waits for explicit revision and resumes the same worker conversation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-phase2-"));
  const repoPath = path.join(tempRoot, "repo");
  const harnessRoot = path.join(tempRoot, "harness");
  await mkdir(repoPath, { recursive: true });
  await mkdir(harnessRoot, { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "fixture\n", "utf8");
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Harness Test"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "fixture"]);

  let workerRuns = 0;
  const conversations: Array<string | undefined> = [];
  const feedback: Array<string | undefined> = [];
  const worker: Worker = {
    async run(task, _directory, revisionFeedback, conversationId) {
      workerRuns += 1;
      conversations.push(conversationId);
      feedback.push(revisionFeedback);
      if (workerRuns === 1) {
        await writeFile(path.join(task.worktree_path, "outside.txt"), "outside\n", "utf8");
      } else {
        await rm(path.join(task.worktree_path, "outside.txt"), { force: true });
        await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
        await writeFile(path.join(task.worktree_path, "src", "result.txt"), "done\n", "utf8");
      }
      return {
        result: {
          status: "success",
          summary: "implemented",
          files_changed: workerRuns === 1 ? ["outside.txt"] : ["src/result.txt"],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: "conversation-phase2",
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const service = new InteractiveDelegationService(testConfig(), harnessRoot, worker);
    const started = await service.delegate({
      repository_path: repoPath,
      objective: "Create src/result.txt",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["src/result.txt exists"],
      checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
      worker_instructions: "Create the result file",
    });
    const waiting = await waitForDelegation(service, started.id, "WAITING_FOR_REVISION");
    assert.match(waiting.message, /outside allowed_paths/);

    await service.requestRevision(started.id, "Remove the out-of-scope file and create src/result.txt");
    const completed = await waitForDelegation(service, started.id, "COMPLETED");
    assert.equal(completed.revision_round, 1);
    assert.deepEqual(completed.changed_files, ["src/result.txt"]);
    assert.equal(completed.checks[0]?.passed, true);
    assert.deepEqual(conversations, [undefined, "conversation-phase2"]);
    assert.equal(feedback[1], "Remove the out-of-scope file and create src/result.txt");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Phase 2 MCP server publishes the five interactive delegation tools", async () => {
  const unavailable = async (): Promise<never> => {
    throw new Error("not used in tool-list test");
  };
  const service: InteractiveDelegationApi = {
    delegate: unavailable,
    getStatus: unavailable,
    getResult: unavailable,
    requestRevision: unavailable,
    cancel: unavailable,
  };
  const server = createInteractiveMcpServer(service);
  const client = new Client({ name: "phase2-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "cancel_worker",
        "delegate_to_antigravity",
        "get_worker_result",
        "get_worker_status",
        "request_worker_revision",
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("interactive cancellation aborts the worker and preserves a cancelled result", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-phase2-cancel-"));
  const repoPath = path.join(tempRoot, "repo");
  const harnessRoot = path.join(tempRoot, "harness");
  await mkdir(repoPath, { recursive: true });
  await mkdir(harnessRoot, { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "fixture\n", "utf8");
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Harness Test"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "fixture"]);

  let aborted = false;
  const worker: Worker = {
    async run(task, _directory, _feedback, _conversationId, signal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      return {
        result: {
          status: "success",
          summary: "cancelled fixture",
          files_changed: [],
          checks_attempted: [],
          residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const service = new InteractiveDelegationService(testConfig(), harnessRoot, worker);
    const started = await service.delegate({
      repository_path: repoPath,
      objective: "Wait until cancelled",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["Worker can be cancelled"],
      checks: [],
    });
    const cancelled = await service.cancel(started.id);
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(aborted, true);
    assert.match(cancelled.message, /preserved/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("parallel plans reject overlapping worker scopes", () => {
  const plan: ParallelPlan = {
    objective: "Two overlapping tasks",
    tasks: [
      {
        id: "first",
        objective: "first",
        allowed_paths: ["src/**"],
        acceptance_criteria: ["first done"],
        checks: [],
        worker_instructions: "first",
      },
      {
        id: "second",
        objective: "second",
        allowed_paths: ["src/api/**"],
        acceptance_criteria: ["second done"],
        checks: [],
        worker_instructions: "second",
      },
    ],
    integration_acceptance_criteria: ["all done"],
    integration_checks: [],
  };
  assert.throws(() => assertDisjointTaskPaths(plan), /scopes overlap/);
});

test("parallel orchestrator runs disjoint workers concurrently and reviews the integrated branch", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-phase3-"));
  const repoPath = path.join(tempRoot, "repo");
  const harnessRoot = path.join(tempRoot, "harness");
  await mkdir(repoPath, { recursive: true });
  await mkdir(harnessRoot, { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "fixture\n", "utf8");
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Harness Test"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "fixture"]);

  const nodeCheck = (file: string) => ({
    command: process.execPath,
    args: ["-e", `require('node:fs').accessSync(${JSON.stringify(file)})`],
  });
  const plan: ParallelPlan = {
    objective: "Create two independent modules",
    tasks: [
      {
        id: "module-a",
        objective: "Create module A",
        allowed_paths: ["module-a/**"],
        acceptance_criteria: ["module-a/result.txt exists"],
        checks: [nodeCheck("module-a/result.txt")],
        worker_instructions: "Create module-a/result.txt",
      },
      {
        id: "module-b",
        objective: "Create module B",
        allowed_paths: ["module-b/**"],
        acceptance_criteria: ["module-b/result.txt exists"],
        checks: [nodeCheck("module-b/result.txt")],
        worker_instructions: "Create module-b/result.txt",
      },
    ],
    integration_acceptance_criteria: ["Both module result files exist"],
    integration_checks: [{
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs'); fs.accessSync('module-a/result.txt'); fs.accessSync('module-b/result.txt')",
      ],
    }],
  };
  const planner: ParallelPlanner = {
    async planParallel() {
      return plan;
    },
  };

  let activeWorkers = 0;
  let maximumActiveWorkers = 0;
  const worker: Worker = {
    async run(task): Promise<WorkerRunResult> {
      activeWorkers += 1;
      maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const moduleName = task.allowed_paths[0]?.split("/")[0];
      assert.ok(moduleName);
      await mkdir(path.join(task.worktree_path, moduleName), { recursive: true });
      await writeFile(path.join(task.worktree_path, moduleName, "result.txt"), `${moduleName}\n`, "utf8");
      activeWorkers -= 1;
      return {
        result: {
          status: "success",
          summary: `created ${moduleName}`,
          files_changed: [`${moduleName}/result.txt`],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: `conversation-${moduleName}`,
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  let reviewRuns = 0;
  const reviewer: Reviewer = {
    async review(task, _checks): Promise<ReviewRunResult> {
      reviewRuns += 1;
      return {
        result: {
          verdict: "approved",
          summary: `approved ${task.id}`,
          findings: [],
          acceptance_criteria: task.acceptance_criteria.map((criterion) => ({
            criterion,
            status: "passed",
            evidence: "fixture",
          })),
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const orchestrator = new ParallelOrchestrator(testConfig(), harnessRoot, {
      planner,
      worker,
      reviewer,
    });
    const summary = await orchestrator.run("Create both modules", repoPath);
    assert.equal(summary.state, "DONE", summary.message);
    assert.equal(maximumActiveWorkers, 2);
    assert.equal(reviewRuns, 3);
    assert.equal(summary.shardResults.length, 2);
    assert.ok(summary.shardResults.every((result) => result.state === "APPROVED"));
    const integrationChecks = JSON.parse(await readFile(path.join(
      harnessRoot,
      ".harness",
      "parallel-runs",
      summary.id,
      "integration-checks.json",
    ), "utf8")) as CheckResult[];
    assert.ok(integrationChecks.length > 0);
    assert.ok(integrationChecks.every((check) => check.passed));
    assert.ok(summary.integrationWorktreePath);
    assert.equal(
      (await readFile(path.join(summary.integrationWorktreePath, "module-a", "result.txt"), "utf8")).trim(),
      "module-a",
    );
    assert.equal(
      (await readFile(path.join(summary.integrationWorktreePath, "module-b", "result.txt"), "utf8")).trim(),
      "module-b",
    );
    assert.equal(spawnSync("git", ["status", "--porcelain"], {
      cwd: summary.integrationWorktreePath,
      encoding: "utf8",
      shell: false,
    }).stdout, "");
    assert.equal(spawnSync("git", ["status", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf8",
      shell: false,
    }).stdout, "");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
