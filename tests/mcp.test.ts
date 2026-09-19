import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseAntigravityOutput, type Worker } from "../src/adapters/antigravity.js";
import { HarnessConfigSchema, type HarnessConfig } from "../src/config.js";
import { classifyDoctorFailure, runDeepDoctor } from "../src/doctor.js";
import { findOutOfScopeFiles } from "../src/git.js";
import {
  DelegationRequestSchema,
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
  assert.throws(() => DelegationRequestSchema.parse({
    repository_path: ".",
    objective: "invalid mapping",
    allowed_paths: ["src/**"],
    acceptance_criteria: ["one criterion"],
    checks: [],
    criterion_check_mapping: [{ criterion_index: 0, check_indices: [0] }],
  }), /does not reference a validation check/);
});

test("delegation preview reports blockers without creating artifacts", async () => {
  const fixture = await createRepository("harness-preview-");
  const worker: Worker = { async run(): Promise<WorkerRunResult> { throw new Error("not used"); } };
  try {
    const service = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const preview = await service.preview({
      repository_path: fixture.repoPath,
      objective: "Preview unsafe contract",
      allowed_paths: ["**"],
      acceptance_criteria: ["Manual review remains explicit"],
      checks: [{ command: "powershell", args: ["-Command", "exit 0"] }],
    });
    assert.equal(preview.can_delegate, false);
    assert.match(preview.blockers.join(" "), /too broad/);
    assert.match(preview.blockers.join(" "), /not allowed/);
    assert.equal(preview.criteria[0]?.verification, "manual_review");
    assert.match(preview.warnings.join(" "), /manual Codex review/);
    await assert.rejects(access(path.join(fixture.harnessRoot, ".harness")));
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("deep doctor exercises the worker and removes its disposable fixture", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-deep-doctor-test-"));
  const artifacts = path.join(tempRoot, "artifacts");
  const fixtures = path.join(tempRoot, "fixtures");
  let receivedTask: TaskSpec | undefined;
  const worker: Worker = {
    async run(task): Promise<WorkerRunResult> {
      receivedTask = task;
      await mkdir(path.join(task.worktree_path, "doctor"), { recursive: true });
      await writeFile(
        path.join(task.worktree_path, "doctor", "antigravity.txt"),
        "antigravity deep doctor ok\n",
        "utf8",
      );
      return {
        result: {
          status: "success",
          summary: "deep doctor fixture completed",
          files_changed: ["doctor/antigravity.txt"],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: "doctor-conversation",
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const config = testConfig();
    config.validation.allowedExecutables = ["node", "node.exe"];
    const report = await runDeepDoctor(config, tempRoot, {
      worker,
      artifactRoot: artifacts,
      temporaryParent: fixtures,
    });
    assert.equal(report.ok, true, report.error);
    assert.equal(report.fixture_removed, true);
    assert.equal(report.conversation_id, "doctor-conversation");
    assert.equal(receivedTask?.allowed_paths[0], "doctor/**");
    assert.equal(await readFile(path.join(artifacts, "report.json"), "utf8").then(Boolean), true);
    assert.equal((await readdir(fixtures)).length, 0);
    assert.ok(report.artifact_manifest.some((entry) => entry.endsWith("status.json")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("deep doctor classifies actionable provider failures", () => {
  assert.equal(classifyDoctorFailure(new Error("Antigravity denied required actions")), "permission_denied");
  assert.equal(classifyDoctorFailure(new Error("Antigravity reported success but returned empty structured output")), "empty_output");
  assert.equal(classifyDoctorFailure(new Error("Antigravity worker timed out after 1000ms")), "timeout");
  assert.equal(classifyDoctorFailure(new Error("model unavailable for this account")), "auth_or_model_unavailable");
  assert.equal(classifyDoctorFailure(new Error("git worktree remove: Permission denied")), "cleanup_failure");
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
    const proposal = {
      repository_path: fixture.repoPath,
      objective: "Create src/result.txt",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["src/result.txt exists"],
      checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
      budgets: { max_changed_files: 1, max_diff_lines: 100, max_diff_bytes: 16_384 },
      criterion_check_mapping: [{ criterion_index: 0, check_indices: [0] }],
    };
    const preview = await service.preview(proposal);
    assert.equal(preview.can_delegate, true, preview.blockers.join("; "));
    assert.equal(preview.criteria[0]?.verification, "automated_checks");
    assert.equal(preview.validation_commands[0]?.allowed, true);
    await assert.rejects(
      service.delegate({
        ...proposal,
        objective: "Changed after preview",
        preview_contract_hash: preview.contract_hash,
      }),
      /changed after preview/,
    );
    await writeFile(path.join(fixture.repoPath, "HEAD_DRIFT.md"), "drift\n", "utf8");
    runGit(fixture.repoPath, ["add", "HEAD_DRIFT.md"]);
    runGit(fixture.repoPath, ["commit", "-m", "preview head drift"]);
    await assert.rejects(
      service.delegate({ ...proposal, preview_contract_hash: preview.contract_hash }),
      /changed after preview/,
    );
    const refreshedPreview = await service.preview(proposal);
    const started = await service.delegate({
      ...proposal,
      preview_contract_hash: refreshedPreview.contract_hash,
    });
    await waitForState(service, started.id, "WAITING_FOR_REVISION");
    await service.requestRevision(started.id, "Remove the out-of-scope file and finish the task");
    const completed = await waitForState(service, started.id, "COMPLETED");
    assert.equal(completed.worker_attempts, 2);
    assert.equal(completed.codex_process_invocations, 0);
    assert.deepEqual(conversations, [undefined, "conversation-mcp"]);

    const metrics = await service.getMetrics(started.id);
    assert.equal(metrics.worker_attempts, 2);
    assert.equal(metrics.initial_attempts, 1);
    assert.equal(metrics.revision_attempts, 1);
    assert.equal(metrics.resume_attempts, 0);
    assert.equal(metrics.conversation_reuse_count, 1);
    assert.equal(metrics.total_provider_duration_ms, 2);
    assert.equal(metrics.attempts[0]?.outcome, "waiting_for_revision");
    assert.equal(metrics.attempts[0]?.failure_category, "scope_violation");
    assert.equal(metrics.attempts[0]?.validation_passed, false);
    assert.equal(metrics.attempts[1]?.outcome, "completed");
    assert.equal(metrics.attempts[1]?.validation_passed, true);

    const diff = await service.getDiff(started.id);
    assert.match(diff.diff, /result\.txt/);
    assert.match(diff.diff, /\+done/);
    assert.equal(diff.truncated, false);

    const firstReviewPage = await service.getReviewPacket(started.id, {
      maxBytes: 1_024,
      maxLines: 4,
    });
    assert.equal(firstReviewPage.review_ready, true);
    assert.deepEqual(firstReviewPage.changed_files, ["src/result.txt"]);
    assert.deepEqual(firstReviewPage.scope_gate, { passed: true, out_of_scope_files: [] });
    assert.equal(firstReviewPage.validation.passed, true);
    assert.equal(firstReviewPage.validation.checks[0]?.stdout_tail, undefined);
    assert.equal(firstReviewPage.acceptance_criteria[0]?.verification, "automated_checks");
    assert.equal(firstReviewPage.acceptance_criteria[0]?.passed, true);
    assert.equal(firstReviewPage.budget_gate.passed, true);
    assert.equal(firstReviewPage.diff_stat.files_changed, 1);
    assert.equal(firstReviewPage.diff_stat.additions, 1);
    assert.ok(firstReviewPage.diff_page.next_cursor);
    assert.match(firstReviewPage.warnings.join(" "), /paginated/i);

    const focusedReview = await service.getReviewPacket(started.id, {
      path: "src/result.txt",
      cursor: firstReviewPage.diff_page.next_cursor,
      maxBytes: 1_024,
      maxLines: 100,
    });
    assert.equal(focusedReview.diff_page.path, "src/result.txt");
    assert.match(focusedReview.diff_page.text, /\+done/);
    assert.equal(focusedReview.diff_page.next_cursor, undefined);
    await assert.rejects(
      service.getReviewPacket(started.id, { path: "README.md" }),
      /not a changed file/,
    );

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

    const cleanupPreview = await service.previewCleanup(started.id);
    assert.deepEqual(cleanupPreview.blockers, []);
    assert.equal(cleanupPreview.worktree_clean, true);
    assert.equal(cleanupPreview.cleanup_required, true);
    assert.ok(cleanupPreview.confirmation_token);
    const cleanup = await service.cleanupWorker(started.id, cleanupPreview.confirmation_token);
    assert.equal(cleanup.removed, true);
    assert.equal(cleanup.already_removed, false);
    await assert.rejects(access(started.worktree_path));
    await access(fixture.repoPath);
    await access(path.join(fixture.harnessRoot, ".harness", "delegations", started.id, "task.json"));
    await access(path.join(fixture.harnessRoot, ".harness", "delegations", started.id, "status.json"));
    assert.ok(runGit(fixture.repoPath, ["show-ref", "--verify", `refs/heads/${started.branch}`]));
    const repeatedCleanup = await service.cleanupWorker(started.id, cleanupPreview.confirmation_token);
    assert.equal(repeatedCleanup.removed, false);
    assert.equal(repeatedCleanup.already_removed, true);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("change budgets gate worker completion, review readiness, and handoff", async () => {
  const fixture = await createRepository("harness-budget-");
  let attempts = 0;
  const worker: Worker = {
    async run(task): Promise<WorkerRunResult> {
      attempts += 1;
      await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
      await writeFile(path.join(task.worktree_path, "src", "a.txt"), "a\n", "utf8");
      if (attempts === 1) {
        await writeFile(path.join(task.worktree_path, "src", "b.txt"), "b\n", "utf8");
      } else {
        await rm(path.join(task.worktree_path, "src", "b.txt"), { force: true });
      }
      return {
        result: {
          status: "success",
          summary: "budget fixture",
          files_changed: attempts === 1 ? ["src/a.txt", "src/b.txt"] : ["src/a.txt"],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: "budget-conversation",
        },
        process: processResult(task.worktree_path),
      };
    },
  };

  try {
    const service = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const started = await service.delegate({
      repository_path: fixture.repoPath,
      objective: "Stay within one changed file",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["src/a.txt exists"],
      checks: [],
      budgets: { max_changed_files: 1, max_diff_lines: 100, max_diff_bytes: 16_384 },
    });
    const overBudget = await waitForState(service, started.id, "WAITING_FOR_REVISION");
    assert.match(overBudget.message, /exceeds the approved change budget/i);
    assert.equal((await service.getMetrics(started.id)).last_failure_category, "budget_exceeded");

    await service.requestRevision(started.id, "Remove src/b.txt to meet the approved budget");
    const completed = await waitForState(service, started.id, "COMPLETED");
    const withinBudget = await service.getReviewPacket(started.id);
    assert.equal(withinBudget.budget_gate.passed, true);
    assert.equal(withinBudget.review_ready, true);

    await writeFile(path.join(completed.worktree_path, "src", "b.txt"), "late expansion\n", "utf8");
    const expanded = await service.getReviewPacket(started.id);
    assert.equal(expanded.budget_gate.passed, false);
    assert.equal(expanded.review_ready, false);
    await assert.rejects(service.prepareCherryPick(started.id), /Change budget failed before handoff/);
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

test("client request ids reuse persisted delegations and reject contract changes", async () => {
  const fixture = await createRepository("harness-idempotency-");
  let attempts = 0;
  const worker: Worker = {
    async run(task: TaskSpec) {
      attempts += 1;
      await new Promise<never>(() => undefined);
      return {
        result: {
          status: "success", summary: "unreachable", files_changed: [], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const request = {
      repository_path: fixture.repoPath,
      objective: "Idempotent task",
      allowed_paths: ["src/idempotent/**"],
      acceptance_criteria: ["done"],
      checks: [],
      client_request_id: "idempotent-task-01",
    };
    const firstServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const [first, concurrentRetry] = await Promise.all([
      firstServer.delegate(request),
      firstServer.delegate(request),
    ]);
    assert.equal(first.id, concurrentRetry.id);
    assert.deepEqual(
      [first.delegation_outcome, concurrentRetry.delegation_outcome].sort(),
      ["created", "reused"],
    );
    assert.equal(attempts, 1);
    assert.equal(first.worker_attempts, 1);
    assert.equal(concurrentRetry.worker_attempts, 1);

    const restartedServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    await restartedServer.initialize();
    const afterRestart = await restartedServer.delegate(request);
    assert.equal(afterRestart.id, first.id);
    assert.equal(afterRestart.delegation_outcome, "reused");
    assert.equal(afterRestart.state, "INTERRUPTED");
    assert.equal(afterRestart.worker_attempts, 1);
    assert.equal(attempts, 1);

    await assert.rejects(
      restartedServer.delegate({ ...request, objective: "Different task" }),
      /already used.*different task contract/,
    );
    assert.equal(attempts, 1);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("worker waiting returns terminal state and reports bounded timeout", async () => {
  const fixture = await createRepository("harness-wait-");
  const worker: Worker = {
    async run(task: TaskSpec, _directory, _feedback, _conversation, signal) {
      if (task.objective === "Slow task") {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
        await writeFile(path.join(task.worktree_path, "src", "result.txt"), "done\n", "utf8");
      }
      return {
        result: {
          status: "success", summary: "done", files_changed: ["src/result.txt"], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const service = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const request = {
      repository_path: fixture.repoPath,
      objective: "Fast task",
      allowed_paths: ["src/fast/**", "src/result.txt"],
      acceptance_criteria: ["done"],
      checks: [],
    };
    const fast = await service.delegate(request);
    const completed = await service.waitForWorker(fast.id, 2_000);
    assert.equal(completed.timed_out, false);
    assert.equal(completed.snapshot.state, "COMPLETED");

    const slow = await service.delegate({
      ...request,
      objective: "Slow task",
      allowed_paths: ["src/slow/**"],
    });
    const timedOut = await service.waitForWorker(slow.id, 20);
    assert.equal(timedOut.timed_out, true);
    assert.equal(timedOut.snapshot.state, "WORKER_RUNNING");
    await service.cancel(slow.id);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("worker metrics classify denied actions and provider timeouts", async () => {
  const fixture = await createRepository("harness-metrics-failures-");
  const worker: Worker = {
    async run(task: TaskSpec): Promise<WorkerRunResult> {
      if (task.objective === "Denied task") {
        throw new Error("Antigravity denied required actions: read_file");
      }
      throw new Error("Antigravity worker timed out after 10000ms");
    },
  };
  try {
    const service = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const baseRequest = {
      repository_path: fixture.repoPath,
      objective: "Denied task",
      allowed_paths: ["src/denied/**"],
      acceptance_criteria: ["done"],
      checks: [],
    };
    const denied = await service.delegate(baseRequest);
    await waitForState(service, denied.id, "FAILED");
    const deniedMetrics = await service.getMetrics(denied.id);
    assert.equal(deniedMetrics.failed_attempts, 1);
    assert.equal(deniedMetrics.last_failure_category, "denied_action");
    assert.equal(deniedMetrics.attempts[0]?.outcome, "failed");

    const timedOut = await service.delegate({
      ...baseRequest,
      objective: "Timeout task",
      allowed_paths: ["src/timeout/**"],
    });
    await waitForState(service, timedOut.id, "FAILED");
    const timeoutMetrics = await service.getMetrics(timedOut.id);
    assert.equal(timeoutMetrics.last_failure_category, "timeout");
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("worker cleanup requires a safe current preview and refuses dirty or active worktrees", async () => {
  const fixture = await createRepository("harness-cleanup-safety-");
  let now = Date.now();
  const worker: Worker = {
    async run(task: TaskSpec, _directory, _feedback, _conversation, signal) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        result: {
          status: "success", summary: "cancelled", files_changed: [], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const service = new InteractiveDelegationService(
      testConfig(),
      fixture.harnessRoot,
      worker,
      () => now,
    );
    const started = await service.delegate({
      repository_path: fixture.repoPath,
      objective: "Cleanup safety task",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["done"],
      checks: [],
    });
    const activePreview = await service.previewCleanup(started.id);
    assert.equal(activePreview.confirmation_token, undefined);
    assert.match(activePreview.blockers.join(" "), /not eligible/);

    await mkdir(path.join(started.worktree_path, "src"), { recursive: true });
    await writeFile(path.join(started.worktree_path, "src", "dirty.txt"), "dirty\n", "utf8");
    await service.cancel(started.id);
    const dirtyPreview = await service.previewCleanup(started.id);
    assert.equal(dirtyPreview.confirmation_token, undefined);
    assert.match(dirtyPreview.blockers.join(" "), /uncommitted changes/);

    await rm(path.join(started.worktree_path, "src", "dirty.txt"), { force: true });
    const expiringPreview = await service.previewCleanup(started.id);
    assert.ok(expiringPreview.confirmation_token);
    await assert.rejects(
      service.cleanupWorker(started.id, "00000000-0000-4000-8000-000000000000"),
      /Invalid cleanup confirmation token/,
    );
    now += 5 * 60 * 1_000 + 1;
    await assert.rejects(
      service.cleanupWorker(started.id, expiringPreview.confirmation_token),
      /has expired/,
    );
    await assert.rejects(service.previewCleanup("../escape"), /Invalid delegation id/);

    const currentPreview = await service.previewCleanup(started.id);
    assert.ok(currentPreview.confirmation_token);
    const cleaned = await service.cleanupWorker(started.id, currentPreview.confirmation_token);
    assert.equal(cleaned.removed, true);
    await access(fixture.repoPath);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("server restart marks a worker interrupted and resumes without spending a revision", async () => {
  const fixture = await createRepository("harness-restart-");
  let attempts = 0;
  const conversations: Array<string | undefined> = [];
  const worker: Worker = {
    async run(task: TaskSpec, _directory, feedback, conversationId) {
      attempts += 1;
      conversations.push(conversationId);
      if (attempts === 1) {
        await new Promise<never>(() => undefined);
      }
      assert.match(feedback ?? "", /resume after MCP server restart/i);
      await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
      await writeFile(path.join(task.worktree_path, "src", "resumed.txt"), "resumed\n", "utf8");
      return {
        result: {
          status: "success",
          summary: "resumed",
          files_changed: ["src/resumed.txt"],
          checks_attempted: [],
          residual_risks: [],
          conversation_id: "conversation-before-restart",
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
    const statusPath = path.join(
      fixture.harnessRoot,
      ".harness",
      "delegations",
      started.id,
      "status.json",
    );
    const persisted = JSON.parse(await readFile(statusPath, "utf8")) as DelegationSnapshot;
    persisted.worker_result = {
      status: "success",
      summary: "conversation allocated before restart",
      files_changed: [],
      checks_attempted: [],
      residual_risks: [],
      conversation_id: "conversation-before-restart",
    };
    await writeFile(statusPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const restartedServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    await restartedServer.initialize();
    const recovered = await restartedServer.getStatus(started.id);
    assert.equal(recovered.state, "INTERRUPTED");
    assert.match(recovered.message, /restarted during execution/);
    assert.equal(recovered.revision_round, 0);

    const resumed = await restartedServer.resumeWorker(started.id);
    assert.equal(resumed.state, "WORKER_RUNNING");
    assert.equal(resumed.revision_round, 0);
    assert.equal(resumed.worker_attempts, 2);
    const completed = await restartedServer.waitForWorker(started.id, 2_000);
    assert.equal(completed.timed_out, false);
    assert.equal(completed.snapshot.state, "COMPLETED");
    assert.equal(completed.snapshot.revision_round, 0);
    assert.deepEqual(conversations, [undefined, "conversation-before-restart"]);
    const metrics = await restartedServer.getMetrics(started.id);
    assert.equal(metrics.initial_attempts, 1);
    assert.equal(metrics.resume_attempts, 1);
    assert.equal(metrics.revision_attempts, 0);
    assert.equal(metrics.conversation_reuse_count, 1);
    assert.equal(metrics.attempts[0]?.outcome, "interrupted");
    assert.equal(metrics.attempts[1]?.outcome, "completed");
    await assert.rejects(restartedServer.resumeWorker(started.id), /cannot be resumed/);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("truncated status recovers from backup and preserves corrupt evidence before repair", async () => {
  const fixture = await createRepository("harness-persistence-recovery-");
  const worker: Worker = {
    async run(task: TaskSpec) {
      await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
      await writeFile(path.join(task.worktree_path, "src", "result.txt"), "done\n", "utf8");
      return {
        result: {
          status: "success", summary: "done", files_changed: ["src/result.txt"], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const firstServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const started = await firstServer.delegate({
      repository_path: fixture.repoPath,
      objective: "Persistence recovery task",
      allowed_paths: ["src/result.txt"],
      acceptance_criteria: ["done"],
      checks: [],
    });
    await waitForState(firstServer, started.id, "COMPLETED");
    const delegationDirectory = path.join(fixture.harnessRoot, ".harness", "delegations", started.id);
    const statusPath = path.join(delegationDirectory, "status.json");
    await access(`${statusPath}.bak`);
    await writeFile(statusPath, '{"state":"COMP', "utf8");

    const restartedServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const recovered = await restartedServer.getStatus(started.id);
    assert.ok(recovered.id === started.id);
    const beforeRepair = (await restartedServer.diagnose(started.id))[0]!;
    assert.equal(beforeRepair.status_file.primary_state, "corrupt");
    assert.equal(beforeRepair.status_file.backup_state, "valid");
    assert.equal(beforeRepair.status_file.recovery_source, "backup");

    await restartedServer.initialize();
    const repaired = await restartedServer.getStatus(started.id);
    assert.equal(repaired.state, "INTERRUPTED");
    const afterRepair = (await restartedServer.diagnose(started.id))[0]!;
    assert.equal(afterRepair.status_file.primary_state, "valid");
    assert.equal(afterRepair.status_file.corrupt_evidence_paths.length, 1);
    assert.equal(await readFile(afterRepair.status_file.corrupt_evidence_paths[0]!, "utf8"), '{"state":"COMP');
    assert.deepEqual(
      (await readdir(delegationDirectory)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics expose corrupt task files and both-unrecoverable status copies", async () => {
  const fixture = await createRepository("harness-persistence-diagnostics-");
  const worker: Worker = {
    async run(task: TaskSpec) {
      await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
      await writeFile(path.join(task.worktree_path, "src", "diagnostic.txt"), "done\n", "utf8");
      return {
        result: {
          status: "success", summary: "done", files_changed: ["src/diagnostic.txt"], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const firstServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const started = await firstServer.delegate({
      repository_path: fixture.repoPath,
      objective: "Broken persistence task",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["done"],
      checks: [],
    });
    await waitForState(firstServer, started.id, "COMPLETED");
    const delegationDirectory = path.join(fixture.harnessRoot, ".harness", "delegations", started.id);
    const taskPath = path.join(delegationDirectory, "task.json");
    const statusPath = path.join(delegationDirectory, "status.json");
    await writeFile(taskPath, "not-json", "utf8");
    await writeFile(statusPath, "not-json", "utf8");
    await writeFile(`${statusPath}.bak`, "also-not-json", "utf8");

    const restartedServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const allDiagnostics = await restartedServer.diagnose();
    const diagnostic = allDiagnostics.find((entry) => entry.worker_id === started.id);
    assert.ok(diagnostic);
    assert.equal(diagnostic.task_file.primary_state, "corrupt");
    assert.equal(diagnostic.status_file.primary_state, "corrupt");
    assert.equal(diagnostic.status_file.backup_state, "corrupt");
    assert.equal(diagnostic.status_file.recovery_source, undefined);
    assert.match(diagnostic.safe_remediation.join(" "), /Preserve all artifacts/);
    await assert.rejects(restartedServer.getStatus(started.id), /Cannot recover/);

    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
    try {
      await restartedServer.initialize();
    } finally {
      console.error = originalError;
    }
    assert.match(warnings.join(" "), new RegExp(started.id));
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("restart ignores an unrenamed temporary status and keeps normal delegations unchanged", async () => {
  const fixture = await createRepository("harness-persistence-atomic-");
  const worker: Worker = {
    async run(task: TaskSpec) {
      await mkdir(path.join(task.worktree_path, "src"), { recursive: true });
      await writeFile(path.join(task.worktree_path, "src", "atomic.txt"), "done\n", "utf8");
      return {
        result: {
          status: "success", summary: "done", files_changed: ["src/atomic.txt"], checks_attempted: [], residual_risks: [],
        },
        process: processResult(task.worktree_path),
      };
    },
  };
  try {
    const firstServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    const started = await firstServer.delegate({
      repository_path: fixture.repoPath,
      objective: "Atomic restart task",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["done"],
      checks: [],
    });
    await waitForState(firstServer, started.id, "COMPLETED");
    const delegationDirectory = path.join(fixture.harnessRoot, ".harness", "delegations", started.id);
    const statusPath = path.join(delegationDirectory, "status.json");
    await writeFile(`${statusPath}.bak`, "corrupt-backup", "utf8");
    await firstServer.requestRevision(started.id, "Verify backup rotation");
    const revised = await waitForState(firstServer, started.id, "COMPLETED");
    const beforeRestartDiagnostic = (await firstServer.diagnose(started.id))[0]!;
    assert.equal(beforeRestartDiagnostic.status_file.corrupt_evidence_paths.length, 1);
    assert.equal(
      await readFile(beforeRestartDiagnostic.status_file.corrupt_evidence_paths[0]!, "utf8"),
      "corrupt-backup",
    );
    await writeFile(
      path.join(delegationDirectory, ".status.json.interrupted.tmp"),
      `${JSON.stringify({ ...revised, state: "FAILED" })}\n`,
      "utf8",
    );

    const restartedServer = new InteractiveDelegationService(testConfig(), fixture.harnessRoot, worker);
    await restartedServer.initialize();
    assert.equal((await restartedServer.getStatus(started.id)).state, "COMPLETED");
    const diagnostic = (await restartedServer.diagnose(started.id))[0]!;
    assert.equal(diagnostic.healthy, true);
    assert.equal(diagnostic.status_file.recovery_source, "primary");
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
    diagnose: unavailable,
    preview: unavailable,
    delegate: unavailable,
    getStatus: unavailable,
    getMetrics: unavailable,
    waitForWorker: unavailable,
    getResult: unavailable,
    getDiff: unavailable,
    getReviewPacket: unavailable,
    prepareCherryPick: unavailable,
    previewCleanup: unavailable,
    cleanupWorker: unavailable,
    resumeWorker: unavailable,
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
      "cleanup_worker",
      "delegate_to_antigravity",
      "diagnose_delegation",
      "get_worker_diff",
      "get_worker_metrics",
      "get_worker_result",
      "get_worker_review_packet",
      "get_worker_status",
      "list_workers",
      "prepare_worker_cherry_pick",
      "preview_delegation",
      "preview_worker_cleanup",
      "request_worker_revision",
      "resume_worker",
      "wait_for_worker",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
