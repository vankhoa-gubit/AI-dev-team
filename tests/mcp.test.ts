import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseAntigravityOutput, type Worker } from "../src/adapters/antigravity.js";
import { HarnessConfigSchema, type HarnessConfig } from "../src/config.js";
import { findOutOfScopeFiles } from "../src/git.js";
import {
  InteractiveDelegationService,
  type DelegationSnapshot,
  type InteractiveDelegationApi,
} from "../src/interactive-delegation.js";
import { createInteractiveMcpServer, SERVER_INSTRUCTIONS } from "../src/mcp-server.js";
import { findOverlappingScope } from "../src/scope.js";
import type { ProcessResult, TaskSpec, WorkerRunResult } from "../src/types.js";
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

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createRepository(prefix: string) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
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
  return { tempRoot, repoPath, harnessRoot };
}

function testConfig(overrides: Partial<HarnessConfig["delegation"]> = {}): HarnessConfig {
  return {
    dataDirectory: ".harness",
    maxRevisionRounds: 2,
    requireCleanRepository: true,
    antigravity: { command: "agy", effort: "high", timeoutMs: 10_000 },
    validation: {
      timeoutMs: 10_000,
      allowedExecutables: [path.basename(process.execPath).toLowerCase()],
    },
    delegation: {
      maxConcurrentWorkers: 3,
      maxDiffBytes: 256 * 1024,
      maxDiffLines: 2_000,
      ...overrides,
    },
  };
}

async function waitForState(
  service: InteractiveDelegationService,
  id: string,
  expected: DelegationSnapshot["state"],
): Promise<DelegationSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await service.getStatus(id);
    if (snapshot.state === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Delegation ${id} did not reach ${expected}`);
}

test("parses the Antigravity envelope and rejects soft-denied actions", () => {
  const parsed = parseAntigravityOutput(JSON.stringify({
    conversation_id: "conversation-1",
    status: "SUCCESS",
    structured_output: {
      status: "success",
      summary: "done",
      files_changed: ["src/index.ts"],
      checks_attempted: [],
      residual_risks: [],
    },
  }));
  assert.equal(parsed.conversation_id, "conversation-1");
  assert.throws(() => parseAntigravityOutput(JSON.stringify({
    status: "SUCCESS",
    denied_actions: [{ tool: "read_file", reason: "permission" }],
  })), /denied required actions/);
});

test("scope and validation gates reject unsafe work", () => {
  assert.deepEqual(findOutOfScopeFiles(["src/a.ts", "README.md"], ["src/**"]), ["README.md"]);
  assert.deepEqual(findOverlappingScope(["src/api/**"], ["src/**"]), {
    left: "src/api/**",
    right: "src/**",
  });
  assert.equal(findOverlappingScope(["src/**"], ["tests/**"]), undefined);
  assert.throws(() => assertAllowedValidationCommand(
    { command: "powershell", args: ["-Command", "Remove-Item", "."] },
    ["npm.cmd"],
  ));
});

test("configuration rejects removed Codex provider and router settings", () => {
  assert.throws(() => HarnessConfigSchema.parse({
    ...testConfig(),
    router: { required: true, baseUrl: "http://127.0.0.1:20128/v1" },
  }));
  assert.throws(() => HarnessConfigSchema.parse({
    ...testConfig(),
    codex: { command: "codex" },
  }));
});

test("chat delegation supports revision, bounded diff, persistence, and safe cherry-pick handoff", async () => {
  const fixture = await createRepository("harness-mcp-");
  let attempts = 0;
  const conversations: Array<string | undefined> = [];
  const worker: Worker = {
    async run(task, _directory, feedback, conversationId): Promise<WorkerRunResult> {
      attempts += 1;
      conversations.push(conversationId);
      if (attempts === 1) {
        await writeFile(path.join(task.worktree_path, "outside.txt"), "outside\n", "utf8");
      } else {
        assert.match(feedback ?? "", /out-of-scope/i);
        await rm(path.join(task.worktree_path, "outside.txt"), { force: true });
        await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
        await writeFile(path.join(task.worktree_path, "src", "result.txt"), "done\n", "utf8");
      }
      return {
        result: {
          status: "success",
          summary: "implemented",
          files_changed: attempts === 1 ? ["outside.txt"] : ["src/result.txt"],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: "conversation-mcp",
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const service = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    await service.initialize();
    const started = await service.delegate({
      repository_path: fixture.repoPath,
      objective: "Create src/result.txt",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["src/result.txt exists"],
      checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
    });
    await waitForState(service, started.id, "WAITING_FOR_REVISION");
    await service.requestRevision(started.id, "Remove the out-of-scope file and finish the task");
    const completed = await waitForState(service, started.id, "COMPLETED");
    assert.equal(completed.worker_attempts, 2);
    assert.equal(completed.codex_process_invocations, 0);
    assert.deepEqual(conversations, [undefined, "conversation-mcp"]);

    const diff = await service.getDiff(started.id);
    assert.match(diff.diff, /result\.txt/);
    assert.match(diff.diff, /\+done/);
    assert.equal(diff.truncated, false);

    const listed = await service.list(fixture.repoPath);
    assert.equal(listed[0]?.id, started.id);
    const persisted = JSON.parse(await readFile(
      path.join(fixture.harnessRoot, ".harness", "delegations", started.id, "status.json"),
      "utf8",
    )) as DelegationSnapshot;
    assert.equal(persisted.state, "COMPLETED");

    const mainHead = runGit(fixture.repoPath, ["rev-parse", "HEAD"]);
    const handoff = await service.prepareCherryPick(started.id);
    assert.equal(handoff.argv[0], "git");
    assert.equal(handoff.argv.at(-1), handoff.commit_sha);
    assert.equal(runGit(fixture.repoPath, ["rev-parse", "HEAD"]), mainHead);
    assert.equal(runGit(fixture.repoPath, ["status", "--porcelain"]), "");
    assert.equal(await service.prepareCherryPick(started.id).then((value) => value.commit_sha), handoff.commit_sha);

    const committedDiff = await service.getDiff(started.id);
    assert.deepEqual(committedDiff.changed_files, ["src/result.txt"]);
    assert.match(committedDiff.diff, /result\.txt/);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("active workers enforce concurrency and non-overlapping scopes", async () => {
  const fixture = await createRepository("harness-concurrency-");
  const worker: Worker = {
    async run(task: TaskSpec, _directory, _feedback, _conversation, signal) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        result: {
          status: "success", summary: "stopped", files_changed: [], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const service = new InteractiveDelegationService(
      testConfig({ maxConcurrentWorkers: 2 }),
      fixture.harnessRoot,
      worker,
    );
    const request = {
      repository_path: fixture.repoPath,
      objective: "First task",
      allowed_paths: ["src/a/**"],
      acceptance_criteria: ["done"],
      checks: [],
    };
    const first = await service.delegate(request);
    await assert.rejects(service.delegate({ ...request, objective: "Overlap" }), /overlaps active worker/);
    const second = await service.delegate({ ...request, objective: "Second", allowed_paths: ["src/b/**"] });
    await assert.rejects(
      service.delegate({ ...request, objective: "Third", allowed_paths: ["src/c/**"] }),
      /Concurrent worker limit/,
    );
    await service.cancel(first.id);
    await service.cancel(second.id);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("server restart preserves an active worktree and exposes an explicit resume state", async () => {
  const fixture = await createRepository("harness-restart-");
  const worker: Worker = {
    async run(task: TaskSpec, _directory, _feedback, _conversation, signal) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        result: {
          status: "success", summary: "stopped", files_changed: [], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const firstServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const started = await firstServer.delegate({
      repository_path: fixture.repoPath,
      objective: "Long-running task",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["done"],
      checks: [],
    });
    const restartedServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    await restartedServer.initialize();
    const recovered = await restartedServer.getStatus(started.id);
    assert.equal(recovered.state, "WAITING_FOR_REVISION");
    assert.match(recovered.message, /restarted during execution/);
    await firstServer.cancel(started.id);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("MCP server publishes the chat-native delegation toolset", async () => {
  assert.match(SERVER_INSTRUCTIONS, /explicitly approved the plan/);
  assert.match(SERVER_INSTRUCTIONS, /only planner and reviewer/);
  const unavailable = async (): Promise<never> => { throw new Error("not used"); };
  const service: InteractiveDelegationApi = {
    list: unavailable,
    delegate: unavailable,
    getStatus: unavailable,
    getResult: unavailable,
    getDiff: unavailable,
    prepareCherryPick: unavailable,
    requestRevision: unavailable,
    cancel: unavailable,
  };
  const server = createInteractiveMcpServer(service);
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "cancel_worker",
      "delegate_to_antigravity",
      "get_worker_diff",
      "get_worker_result",
      "get_worker_status",
      "list_workers",
      "prepare_worker_cherry_pick",
      "request_worker_revision",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
