import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HarnessConfig } from "../src/config.js";
import {
  assertValidOperationId,
  composeReplanRequirement,
  formatSafeCommand,
  HarnessUiServer,
  isValidOperationId,
  prepareCherryPick,
  type SanitizedOperation,
} from "../src/ui/index.js";

function testConfig(dataDirectory = ".harness"): HarnessConfig {
  return {
    dataDirectory,
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

function initGitRepo(dir: string): string {
  const result = spawnSync("git", ["init", "-b", "main"], { cwd: dir, shell: false });
  if (result.status !== 0) {
    spawnSync("git", ["init"], { cwd: dir, shell: false });
  }
  spawnSync("git", ["config", "user.name", "Test Harness"], { cwd: dir, shell: false });
  spawnSync("git", ["config", "user.email", "harness@example.com"], { cwd: dir, shell: false });

  // Create an initial commit
  const initFile = path.join(dir, "README.md");
  spawnSync("git", ["add", "."], { cwd: dir, shell: false });
  const commitRes = spawnSync("git", ["commit", "--allow-empty", "-m", "Initial commit"], {
    cwd: dir,
    shell: false,
  });

  const revRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, shell: false, encoding: "utf8" });
  return revRes.stdout ? revRes.stdout.trim() : "0000000000000000000000000000000000000000";
}

async function createTestFixtures() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-lifecycle-"));
  const harnessRoot = path.join(tempRoot, "harness");
  const repoDir = path.join(tempRoot, "repo");
  const notRepoDir = path.join(tempRoot, "not-repo");

  await mkdir(harnessRoot, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(notRepoDir, { recursive: true });

  const initialHeadSha = initGitRepo(repoDir);

  // Mock CLI script that outputs run ID and exits cleanly with exit code 0
  const mockCliScript = path.join(harnessRoot, "mock-cli.js");
  await writeFile(
    mockCliScript,
    `
    const args = process.argv.slice(2);
    console.log(JSON.stringify({ id: "parallel-20260917120000-abcd1234", state: "DONE" }));
    process.exit(0);
    `,
    "utf8",
  );

  // Mock failing CLI script that exits with non-zero code
  const failCliScript = path.join(harnessRoot, "fail-cli.js");
  await writeFile(
    failCliScript,
    `
    console.error("Parallel shard integration review rejected");
    process.exit(1);
    `,
    "utf8",
  );

  // Hanging CLI script for cancellation testing
  const hangCliScript = path.join(harnessRoot, "hang-cli.js");
  await writeFile(
    hangCliScript,
    `
    console.log(JSON.stringify({ id: "parallel-20260917999999-hang0001", state: "RUNNING" }));
    setInterval(() => {}, 1000);
    `,
    "utf8",
  );

  return { tempRoot, harnessRoot, repoDir, notRepoDir, initialHeadSha, mockCliScript, failCliScript, hangCliScript };
}

// 1. Command Quoting Unit Tests
test("formatSafeCommand safely handles arguments, spaces, quotes, and metacharacters", () => {
  // Empty arguments
  assert.equal(formatSafeCommand([]), "");

  // Empty string argument
  assert.equal(formatSafeCommand(["echo", ""], "linux"), "echo ''");
  assert.equal(formatSafeCommand(["echo", ""], "win32"), "echo ''");

  // Standard git cherry-pick with full SHA
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(formatSafeCommand(["git", "cherry-pick", sha]), `git cherry-pick ${sha}`);

  // Arguments with spaces
  const posixSpaces = formatSafeCommand(["git", "commit", "-m", "feature implementation"], "linux");
  assert.equal(posixSpaces, "git commit -m 'feature implementation'");

  const winSpaces = formatSafeCommand(["git", "commit", "-m", "feature implementation"], "win32");
  assert.equal(winSpaces, "git commit -m 'feature implementation'");

  // Arguments with double quotes
  const posixDblQuotes = formatSafeCommand(["echo", 'hello "world"'], "linux");
  assert.equal(posixDblQuotes, 'echo \'hello "world"\'');

  const winDblQuotes = formatSafeCommand(["echo", 'hello "world"'], "win32");
  assert.equal(winDblQuotes, 'echo \'hello "world"\'');

  // Arguments with apostrophes (single quotes)
  const posixApostrophe = formatSafeCommand(["echo", "don't fail"], "linux");
  assert.equal(posixApostrophe, "echo 'don'\\''t fail'");

  const winApostrophe = formatSafeCommand(["echo", "don't fail"], "win32");
  assert.equal(winApostrophe, "echo 'don''t fail'");

  // Arguments with mixed quotes (apostrophe + double quotes)
  const posixMixed = formatSafeCommand(["echo", 'it\'s "great"'], "linux");
  assert.equal(posixMixed, 'echo \'it\'\\\'\'s "great"\'');

  const winMixed = formatSafeCommand(["echo", 'it\'s "great"'], "win32");
  assert.equal(winMixed, 'echo \'it\'\'s "great"\'');

  // Shell injection attempts: semicolon ;
  const injectionSemiPosix = formatSafeCommand(["git", "cherry-pick", "abc; rm -rf /"], "linux");
  assert.equal(injectionSemiPosix, "git cherry-pick 'abc; rm -rf /'");

  const injectionSemiWin = formatSafeCommand(["git", "cherry-pick", "abc; rm -rf /"], "win32");
  assert.equal(injectionSemiWin, "git cherry-pick 'abc; rm -rf /'");

  // Shell injection attempts: ampersand &
  const injectionAmpPosix = formatSafeCommand(["git", "cherry-pick", "abc & rm -rf /"], "linux");
  assert.equal(injectionAmpPosix, "git cherry-pick 'abc & rm -rf /'");

  const injectionAmpWin = formatSafeCommand(["git", "cherry-pick", "abc & del /f /q C:\\*"], "win32");
  assert.equal(injectionAmpWin, "git cherry-pick 'abc & del /f /q C:\\*'");

  // Self-contained git -C repo cherry-pick command
  const posixCherryPick = formatSafeCommand(
    ["git", "-C", "/var/workspace/my repo", "cherry-pick", sha],
    "linux",
  );
  assert.equal(posixCherryPick, `git -C '/var/workspace/my repo' cherry-pick ${sha}`);

  const winCherryPick = formatSafeCommand(
    ["git", "-C", "D:\\workspace\\my repo", "cherry-pick", sha],
    "win32",
  );
  assert.equal(winCherryPick, `git -C 'D:\\workspace\\my repo' cherry-pick ${sha}`);
});

// 2. Replan Feedback Composition Unit Tests
test("composeReplanRequirement appends feedback cleanly and validates boundaries", () => {
  const baseReq = "Build health and status observation endpoints";
  const feedback = "Add a /ready endpoint checking database connectivity";

  const composed = composeReplanRequirement(baseReq, feedback);
  assert.ok(composed.includes(baseReq));
  assert.ok(composed.includes("Replan Feedback:"));
  assert.ok(composed.includes(feedback));

  // Empty feedback throws SecurityError 400
  assert.throws(() => composeReplanRequirement(baseReq, ""), /feedback must be a non-empty string/);
  assert.throws(() => composeReplanRequirement(baseReq, "   "), /feedback must be a non-empty string/);

  // Oversized feedback (> 20,000 characters) throws 400
  const giantFeedback = "F".repeat(25_000);
  assert.throws(() => composeReplanRequirement(baseReq, giantFeedback), /exceeds maximum allowed length/);

  // Total requirement exceeds 20,000 characters throws 400
  const largeBase = "B".repeat(15_000);
  const largeFeedback = "F".repeat(6_000);
  assert.throws(() => composeReplanRequirement(largeBase, largeFeedback), /exceeds maximum allowed length/);
});

// 3. Eligibility Verification: Retry and Replan
test("POST /api/operations/:id/retry and /replan enforce eligibility and reject non-terminal sources", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.mockCliScript,
    });
    await server.start();

    // A. Start an operation and let it finish to COMPLETED
    const startRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryPath: fixtures.repoDir,
        requirement: "Task for completion testing",
      }),
    });
    assert.equal(startRes.status, 201);
    const completedOp = (await startRes.json()) as SanitizedOperation;

    await server.operationManager.waitForOperationsToSettle();

    // Verify it is COMPLETED
    const checkOp = await server.operationManager.getOperation(completedOp.id);
    assert.equal(checkOp.status, "COMPLETED");

    // B. Create a RUNNING operation manually in the manager (simulate active in-flight)
    const runningOpId = "op-20260917000001-run0001";
    await server.operationManager.persistOperation({
      id: runningOpId,
      status: "RUNNING",
      type: "parallel_run",
      repositoryPath: fixtures.repoDir,
      requirement: "Active running operation",
      startedAt: new Date().toISOString(),
      cancellable: false,
    });

    // C. Create a CANCELLED operation
    const cancelledOpId = "op-20260917000002-canc0001";
    await server.operationManager.persistOperation({
      id: cancelledOpId,
      status: "CANCELLED",
      type: "parallel_run",
      repositoryPath: fixtures.repoDir,
      requirement: "Cancelled operation",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cancellable: false,
    });

    // D. Create a FAILED operation
    const failedOpId = "op-20260917000003-fail0001";
    await server.operationManager.persistOperation({
      id: failedOpId,
      status: "FAILED",
      type: "parallel_run",
      repositoryPath: fixtures.repoDir,
      requirement: "Failed operation",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 1,
      cancellable: false,
    });

    // Test 1: Retry RUNNING operation returns 409 Conflict
    const retryRunningRes = await fetch(`${server.url}/api/operations/${runningOpId}/retry`, {
      method: "POST",
    });
    assert.equal(retryRunningRes.status, 409);
    const retryRunningJson = (await retryRunningRes.json()) as { error: string };
    assert.match(retryRunningJson.error, /only COMPLETED or FAILED operations can be retried/);

    // Test 2: Replan RUNNING operation returns 409 Conflict
    const replanRunningRes = await fetch(`${server.url}/api/operations/${runningOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Adjusting plan" }),
    });
    assert.equal(replanRunningRes.status, 409);
    const replanRunningJson = (await replanRunningRes.json()) as { error: string };
    assert.match(replanRunningJson.error, /only COMPLETED or FAILED operations can be replanned/);

    // Test 3: Retry CANCELLED operation returns 409 Conflict
    const retryCancelledRes = await fetch(`${server.url}/api/operations/${cancelledOpId}/retry`, {
      method: "POST",
    });
    assert.equal(retryCancelledRes.status, 409);

    // Test 4: Replan CANCELLED operation returns 409 Conflict
    const replanCancelledRes = await fetch(`${server.url}/api/operations/${cancelledOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Adjusting plan" }),
    });
    assert.equal(replanCancelledRes.status, 409);

    // Test 5: Retry Non-existent operation returns 404
    const retryNotFound = await fetch(`${server.url}/api/operations/op-nonexistent/retry`, {
      method: "POST",
    });
    assert.equal(retryNotFound.status, 404);

    // Test 6: Replan Non-existent operation returns 404
    const replanNotFound = await fetch(`${server.url}/api/operations/op-nonexistent/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Adjusting plan" }),
    });
    assert.equal(replanNotFound.status, 404);

    // Test 7: Retry Invalid ID returns 400
    const retryInvalidId = await fetch(`${server.url}/api/operations/..%2fescape/retry`, {
      method: "POST",
    });
    assert.equal(retryInvalidId.status, 400);

    // Test 8: Replan Invalid ID returns 400
    const replanInvalidId = await fetch(`${server.url}/api/operations/..%2fescape/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Adjusting plan" }),
    });
    assert.equal(replanInvalidId.status, 400);

    // Test 9: Retry COMPLETED operation succeeds immediately (201 Created)
    const retryCompletedRes = await fetch(`${server.url}/api/operations/${completedOp.id}/retry`, {
      method: "POST",
    });
    assert.equal(retryCompletedRes.status, 201);
    const retryOp = (await retryCompletedRes.json()) as SanitizedOperation;
    assert.ok(retryOp.id.startsWith("op-"));
    assert.equal(retryOp.action, "retry");
    assert.equal(retryOp.parentId, completedOp.id);

    // Test 10: Replan FAILED operation succeeds immediately (201 Created)
    const replanFailedRes = await fetch(`${server.url}/api/operations/${failedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Fix shard error by splitting tasks" }),
    });
    assert.equal(replanFailedRes.status, 201);
    const replanOp = (await replanFailedRes.json()) as SanitizedOperation;
    assert.ok(replanOp.id.startsWith("op-"));
    assert.equal(replanOp.action, "replan");
    assert.equal(replanOp.parentId, failedOpId);
    assert.equal(replanOp.feedback, "Fix shard error by splitting tasks");
    assert.ok(replanOp.requirement.includes("Fix shard error by splitting tasks"));

    await server.operationManager.waitForOperationsToSettle();
  } finally {
    if (server) {
      await server.operationManager.waitForOperationsToSettle().catch(() => {});
      await server.stop();
    }
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 4. Strict Validation on POST /api/operations/:id/replan
test("POST /api/operations/:id/replan enforces JSON media type, bounded bodies, and non-empty feedback", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.mockCliScript,
    });
    await server.start();

    // Create completed operation
    const completedOpId = "op-20260917000010-comp0001";
    await server.operationManager.persistOperation({
      id: completedOpId,
      status: "COMPLETED",
      type: "parallel_run",
      repositoryPath: fixtures.repoDir,
      requirement: "Base requirement",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cancellable: false,
    });

    // A. Missing Content-Type -> 415
    const noContentType = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      body: JSON.stringify({ feedback: "valid feedback" }),
    });
    assert.equal(noContentType.status, 415);
    const noCtJson = (await noContentType.json()) as { error: string };
    assert.match(noCtJson.error, /Content-Type must be application\/json/);

    // B. text/plain Content-Type -> 415
    const textPlain = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ feedback: "valid feedback" }),
    });
    assert.equal(textPlain.status, 415);

    // C. Empty body -> 400
    const emptyBody = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    assert.equal(emptyBody.status, 400);

    // D. Malformed JSON -> 400
    const malformed = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    assert.equal(malformed.status, 400);

    // E. Array body -> 400
    const arrayBody = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["invalid"]),
    });
    assert.equal(arrayBody.status, 400);

    // F. Missing feedback property -> 400
    const missingFb = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrongKey: "text" }),
    });
    assert.equal(missingFb.status, 400);

    // G. Empty / whitespace feedback -> 400
    const whitespaceFb = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "    " }),
    });
    assert.equal(whitespaceFb.status, 400);

    // H. Oversized payload (> 64KB) -> 413
    const oversizedPayload = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "A".repeat(70 * 1024) }),
    });
    assert.equal(oversizedPayload.status, 413);

    // I. Oversized feedback (> 20,000 characters) -> 400
    const oversizedFb = await fetch(`${server.url}/api/operations/${completedOpId}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "A".repeat(25_000) }),
    });
    assert.equal(oversizedFb.status, 400);
  } finally {
    if (server) await server.stop();
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 5. Lineage Persistence, Chained Relationships, and Parent Child Tracking
test("Retry and replan persist durable lineage: child parent/root/action and parent childOperationIds", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.mockCliScript,
    });
    await server.start();

    // 1. Start root run (op-1)
    const op1Res = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryPath: fixtures.repoDir,
        requirement: "Root requirement A",
      }),
    });
    assert.equal(op1Res.status, 201);
    const op1 = (await op1Res.json()) as SanitizedOperation;

    await server.operationManager.waitForOperationsToSettle();

    // Verify op-1 is root
    const op1Fresh = await server.operationManager.getOperation(op1.id);
    assert.equal(op1Fresh.status, "COMPLETED");
    assert.equal(op1Fresh.action, "start");
    assert.equal(op1Fresh.rootId, op1.id);
    assert.equal(op1Fresh.parentId, undefined);
    assert.deepEqual(op1Fresh.childOperationIds, []);

    // 2. Retry op-1 -> creates op-2
    const op2Res = await fetch(`${server.url}/api/operations/${op1.id}/retry`, {
      method: "POST",
    });
    assert.equal(op2Res.status, 201);
    const op2 = (await op2Res.json()) as SanitizedOperation;

    assert.equal(op2.action, "retry");
    assert.equal(op2.parentId, op1.id);
    assert.equal(op2.rootId, op1.id);
    assert.equal(op2.requirement, op1.requirement);
    assert.equal(op2.repositoryPath, op1.repositoryPath);

    await server.operationManager.waitForOperationsToSettle();

    // Check op-1 exposes op-2 in childOperationIds
    const op1AfterRetry = await server.operationManager.getOperation(op1.id);
    assert.ok(op1AfterRetry.childOperationIds.includes(op2.id));

    // Verify durable disk file for op-1
    const op1File = path.join(fixtures.harnessRoot, config.dataDirectory, "ui", "operations", `${op1.id}.json`);
    const op1Disk = JSON.parse(await readFile(op1File, "utf8"));
    assert.ok(Array.isArray(op1Disk.childOperationIds));
    assert.ok(op1Disk.childOperationIds.includes(op2.id));

    // 3. Replan op-2 -> creates op-3
    const replanFeedbackText = "Change worker task boundaries to avoid merge conflict";
    const op3Res = await fetch(`${server.url}/api/operations/${op2.id}/replan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: replanFeedbackText }),
    });
    assert.equal(op3Res.status, 201);
    const op3 = (await op3Res.json()) as SanitizedOperation;

    assert.equal(op3.action, "replan");
    assert.equal(op3.parentId, op2.id);
    assert.equal(op3.rootId, op1.id); // Root ID points back to original root op-1!
    assert.equal(op3.feedback, replanFeedbackText);
    assert.ok(op3.requirement.includes(replanFeedbackText));

    await server.operationManager.waitForOperationsToSettle();

    // Check op-2 exposes op-3 in childOperationIds
    const op2AfterReplan = await server.operationManager.getOperation(op2.id);
    assert.ok(op2AfterReplan.childOperationIds.includes(op3.id));

    // Verify durable disk file for op-3
    const op3File = path.join(fixtures.harnessRoot, config.dataDirectory, "ui", "operations", `${op3.id}.json`);
    const op3Disk = JSON.parse(await readFile(op3File, "utf8"));
    assert.equal(op3Disk.parentId, op2.id);
    assert.equal(op3Disk.rootId, op1.id);
    assert.equal(op3Disk.action, "replan");
    assert.equal(op3Disk.feedback, replanFeedbackText);
  } finally {
    if (server) {
      await server.operationManager.waitForOperationsToSettle().catch(() => {});
      await server.stop();
    }
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 6. Concurrent Writes and Conflict-Safe Duplicate Actions
test("Concurrent duplicate actions return 409 Conflict; at most one active retry and one replan run; subsequent actions succeed after settlement", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.mockCliScript,
    });
    await server.start();

    // Create a parent operation with terminal state FAILED
    const parentId = "op-20260917000020-concurrent01";
    await server.operationManager.persistOperation({
      id: parentId,
      status: "FAILED",
      type: "parallel_run",
      repositoryPath: fixtures.repoDir,
      requirement: "Parent requirement for concurrent testing",
      startedAt: new Date(Date.now() - 5000).toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 1,
      message: "Initial shard failure",
      cancellable: false,
    });

    // Launch 4 concurrent mutations against parentId: 2 retries and 2 replans
    const calls: [Promise<Response>, Promise<Response>, Promise<Response>, Promise<Response>] = [
      fetch(`${server.url}/api/operations/${parentId}/retry`, { method: "POST" }),
      fetch(`${server.url}/api/operations/${parentId}/replan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Concurrent feedback 1" }),
      }),
      fetch(`${server.url}/api/operations/${parentId}/retry`, { method: "POST" }),
      fetch(`${server.url}/api/operations/${parentId}/replan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Concurrent feedback 2" }),
      }),
    ];

    const responses: [Response, Response, Response, Response] = await Promise.all(calls);
    const [retryRes1, replanRes1, retryRes2, replanRes2] = responses;
    assert.ok(retryRes1 && replanRes1 && retryRes2 && replanRes2);

    // Concurrency rule: at most one active retry and one active replan
    const retryStatuses = [retryRes1.status, retryRes2.status].sort();
    assert.deepEqual(retryStatuses, [201, 409], "Exactly one concurrent retry accepted and one returns 409 Conflict");

    const replanStatuses = [replanRes1.status, replanRes2.status].sort();
    assert.deepEqual(replanStatuses, [201, 409], "Exactly one concurrent replan accepted and one returns 409 Conflict");

    const acceptedRetry = (retryRes1.status === 201 ? await retryRes1.json() : await retryRes2.json()) as SanitizedOperation;
    const acceptedReplan = (replanRes1.status === 201 ? await replanRes1.json() : await replanRes2.json()) as SanitizedOperation;

    assert.equal(acceptedRetry.action, "retry");
    assert.equal(acceptedReplan.action, "replan");
    const initialAcceptedIds = [acceptedRetry.id, acceptedReplan.id];

    // Wait for all child processes and persistence queues to settle
    await server.operationManager.waitForOperationsToSettle();

    // Read the parent operation from disk
    const parentFile = path.join(fixtures.harnessRoot, config.dataDirectory, "ui", "operations", `${parentId}.json`);
    const parentDiskAfterSettle = JSON.parse(await readFile(parentFile, "utf8"));

    // Criterion 13: concurrent writes cannot lose lineage or terminal state
    assert.equal(parentDiskAfterSettle.status, "FAILED", "Terminal state must remain FAILED, never downgraded");
    assert.ok(parentDiskAfterSettle.completedAt, "completedAt must be preserved");
    assert.equal(parentDiskAfterSettle.exitCode, 1, "exitCode must be preserved");

    // Parent must preserve both accepted child IDs
    assert.equal(parentDiskAfterSettle.childOperationIds.length, 2, "Must contain both accepted child IDs");
    for (const childId of initialAcceptedIds) {
      assert.ok(parentDiskAfterSettle.childOperationIds.includes(childId), `Must contain child ID ${childId}`);
    }

    // Criterion: subsequent retries succeed after terminal settlement
    const subsequentRetryRes = await fetch(`${server.url}/api/operations/${parentId}/retry`, { method: "POST" });
    assert.equal(subsequentRetryRes.status, 201, "Subsequent retry after terminal settlement must succeed");
    const subsequentRetryOp = (await subsequentRetryRes.json()) as SanitizedOperation;
    assert.equal(subsequentRetryOp.action, "retry");
    assert.equal(subsequentRetryOp.parentId, parentId);

    await server.operationManager.waitForOperationsToSettle();

    const parentDiskFinal = JSON.parse(await readFile(parentFile, "utf8"));
    assert.equal(parentDiskFinal.status, "FAILED", "Terminal state must remain FAILED");
    assert.equal(parentDiskFinal.childOperationIds.length, 3, "Parent must preserve all 3 accepted child IDs");
    assert.ok(parentDiskFinal.childOperationIds.includes(subsequentRetryOp.id), "Parent must include subsequent retry ID");
  } finally {
    if (server) {
      await server.operationManager.waitForOperationsToSettle().catch(() => {});
      await server.stop();
    }
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 7. Prepare Cherry-Pick API: State/SHA Gating and Format
test("prepare-cherry-pick requires state DONE and valid commit SHA, returning argv and command", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.mockCliScript,
    });
    await server.start();

    const runsDir = path.join(fixtures.harnessRoot, config.dataDirectory, "parallel-runs");
    const validSha = fixtures.initialHeadSha;

    // A. Run in PLANNING state -> 409 Conflict
    const planningRunId = "parallel-20260917000031-plan0001";
    const planningDir = path.join(runsDir, planningRunId);
    await mkdir(planningDir, { recursive: true });
    await writeFile(
      path.join(planningDir, "status.json"),
      JSON.stringify({ id: planningRunId, state: "PLANNING", shardResults: [] }),
      "utf8",
    );

    const planningRes = await fetch(`${server.url}/api/parallel-runs/${planningRunId}/prepare-cherry-pick`);
    assert.equal(planningRes.status, 409);
    const planningJson = (await planningRes.json()) as { error: string };
    assert.match(planningJson.error, /requires state DONE/);

    // B. Run in REPLAN_REQUIRED state -> 409 Conflict
    const replanRunId = "parallel-20260917000032-repl0001";
    const replanDir = path.join(runsDir, replanRunId);
    await mkdir(replanDir, { recursive: true });
    await writeFile(
      path.join(replanDir, "status.json"),
      JSON.stringify({ id: replanRunId, state: "REPLAN_REQUIRED", shardResults: [] }),
      "utf8",
    );

    const replanRes = await fetch(`${server.url}/api/parallel-runs/${replanRunId}/prepare-cherry-pick`);
    assert.equal(replanRes.status, 409);
    const replanJson = (await replanRes.json()) as { error: string };
    assert.match(replanJson.error, /requires state DONE/);

    // C. Run in DONE state but missing integrationCommitSha -> 409 Conflict
    const noShaRunId = "parallel-20260917000033-nosha01";
    const noShaDir = path.join(runsDir, noShaRunId);
    await mkdir(noShaDir, { recursive: true });
    await writeFile(
      path.join(noShaDir, "status.json"),
      JSON.stringify({ id: noShaRunId, state: "DONE", shardResults: [] }),
      "utf8",
    );

    const noShaRes = await fetch(`${server.url}/api/parallel-runs/${noShaRunId}/prepare-cherry-pick`);
    assert.equal(noShaRes.status, 409);
    const noShaJson = (await noShaRes.json()) as { error: string };
    assert.match(noShaJson.error, /valid integration commit SHA/);

    // D. Run in DONE state but invalid non-hex SHA -> 409 Conflict
    const badShaRunId = "parallel-20260917000034-badsha1";
    const badShaDir = path.join(runsDir, badShaRunId);
    await mkdir(badShaDir, { recursive: true });
    await writeFile(
      path.join(badShaDir, "status.json"),
      JSON.stringify({
        id: badShaRunId,
        state: "DONE",
        integrationCommitSha: "not-a-valid-sha-injection-attempt; rm -rf",
        shardResults: [],
      }),
      "utf8",
    );

    const badShaRes = await fetch(`${server.url}/api/parallel-runs/${badShaRunId}/prepare-cherry-pick`);
    assert.equal(badShaRes.status, 409);

    // E. Run in DONE state with valid commit SHA but missing repositoryPath -> 409 Conflict
    const noRepoRunId = "parallel-20260917000035-norepo";
    const noRepoDir = path.join(runsDir, noRepoRunId);
    await mkdir(noRepoDir, { recursive: true });
    await writeFile(
      path.join(noRepoDir, "status.json"),
      JSON.stringify({
        id: noRepoRunId,
        state: "DONE",
        integrationCommitSha: validSha,
        shardResults: [],
      }),
      "utf8",
    );
    const noRepoRes = await fetch(`${server.url}/api/parallel-runs/${noRepoRunId}/prepare-cherry-pick`);
    assert.equal(noRepoRes.status, 409);
    const noRepoJson = (await noRepoRes.json()) as { error: string };
    assert.match(noRepoJson.error, /repositoryPath/);

    // F. Run in DONE state with valid commit SHA but repositoryPath is not a Git repo -> 409 Conflict
    const notGitRunId = "parallel-20260917000036-notgit";
    const notGitDir = path.join(runsDir, notGitRunId);
    await mkdir(notGitDir, { recursive: true });
    await writeFile(
      path.join(notGitDir, "status.json"),
      JSON.stringify({
        id: notGitRunId,
        state: "DONE",
        repositoryPath: fixtures.notRepoDir,
        integrationCommitSha: validSha,
        shardResults: [],
      }),
      "utf8",
    );
    const notGitRes = await fetch(`${server.url}/api/parallel-runs/${notGitRunId}/prepare-cherry-pick`);
    assert.equal(notGitRes.status, 409);
    const notGitJson = (await notGitRes.json()) as { error: string };
    assert.match(notGitJson.error, /repositoryPath/);

    // G. Run in DONE state with valid 40-character integration commit SHA and valid repositoryPath -> 200 OK
    const doneRunId = "parallel-20260917000037-done0001";
    const doneDir = path.join(runsDir, doneRunId);
    await mkdir(doneDir, { recursive: true });
    await writeFile(
      path.join(doneDir, "status.json"),
      JSON.stringify({
        id: doneRunId,
        state: "DONE",
        repositoryPath: fixtures.repoDir,
        integrationCommitSha: validSha,
        shardResults: [],
      }),
      "utf8",
    );

    // Test GET method
    const doneGetRes = await fetch(`${server.url}/api/parallel-runs/${doneRunId}/prepare-cherry-pick`);
    assert.equal(doneGetRes.status, 200);
    const doneGetJson = (await doneGetRes.json()) as {
      runId: string;
      sha: string;
      integrationCommitSha: string;
      repositoryPath: string;
      argv: string[];
      command: string;
    };

    assert.equal(doneGetJson.runId, doneRunId);
    assert.equal(doneGetJson.sha, validSha);
    assert.equal(doneGetJson.integrationCommitSha, validSha);
    assert.equal(doneGetJson.repositoryPath, fixtures.repoDir);
    assert.deepEqual(doneGetJson.argv, ["git", "-C", fixtures.repoDir, "cherry-pick", validSha]);
    assert.equal(
      doneGetJson.command,
      formatSafeCommand(["git", "-C", fixtures.repoDir, "cherry-pick", validSha]),
    );

    // Test POST method works too
    const donePostRes = await fetch(`${server.url}/api/parallel-runs/${doneRunId}/prepare-cherry-pick`, {
      method: "POST",
    });
    assert.equal(donePostRes.status, 200);
    const donePostJson = (await donePostRes.json()) as typeof doneGetJson;
    assert.equal(
      donePostJson.command,
      formatSafeCommand(["git", "-C", fixtures.repoDir, "cherry-pick", validSha]),
    );
    assert.deepEqual(donePostJson.argv, ["git", "-C", fixtures.repoDir, "cherry-pick", validSha]);

    // Test /api/runs/:id alias
    const aliasRes = await fetch(`${server.url}/api/runs/${doneRunId}/prepare-cherry-pick`);
    assert.equal(aliasRes.status, 200);

    // Test Non-existent run -> 404
    const notFoundRun = await fetch(`${server.url}/api/parallel-runs/parallel-nonexistent/prepare-cherry-pick`);
    assert.equal(notFoundRun.status, 404);

    // Test Path traversal in runId -> 400
    const traversalRun = await fetch(`${server.url}/api/parallel-runs/..%2fescape/prepare-cherry-pick`);
    assert.equal(traversalRun.status, 400);
  } finally {
    if (server) await server.stop();
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 8. Zero Git Mutation Guarantee
test("prepare-cherry-pick never mutates repository HEAD, working tree, branches, or worktrees", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.mockCliScript,
    });
    await server.start();

    // Record initial Git state in target repository
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    const statusBefore = spawnSync("git", ["status", "--porcelain"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    const branchesBefore = spawnSync("git", ["branch"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    const worktreesBefore = spawnSync("git", ["worktree", "list"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    // Create a DONE run artifact
    const validSha = fixtures.initialHeadSha;
    const runId = "parallel-20260917000040-nomutate";
    const runsDir = path.join(fixtures.harnessRoot, config.dataDirectory, "parallel-runs");
    const runDir = path.join(runsDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        id: runId,
        state: "DONE",
        repositoryPath: fixtures.repoDir,
        integrationCommitSha: validSha,
        shardResults: [],
      }),
      "utf8",
    );

    // Call prepareCherryPick directly and via HTTP endpoints
    const prepDirect = await prepareCherryPick(path.join(fixtures.harnessRoot, config.dataDirectory), runId);
    assert.equal(prepDirect.repositoryPath, fixtures.repoDir);
    assert.deepEqual(prepDirect.argv, ["git", "-C", fixtures.repoDir, "cherry-pick", validSha]);
    assert.equal(
      prepDirect.command,
      formatSafeCommand(["git", "-C", fixtures.repoDir, "cherry-pick", validSha]),
    );

    const getRes = await fetch(`${server.url}/api/parallel-runs/${runId}/prepare-cherry-pick`);
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as {
      repositoryPath: string;
      argv: string[];
      command: string;
    };
    assert.equal(getJson.repositoryPath, fixtures.repoDir);
    assert.deepEqual(getJson.argv, ["git", "-C", fixtures.repoDir, "cherry-pick", validSha]);
    assert.equal(
      getJson.command,
      formatSafeCommand(["git", "-C", fixtures.repoDir, "cherry-pick", validSha]),
    );

    const postRes = await fetch(`${server.url}/api/parallel-runs/${runId}/prepare-cherry-pick`, {
      method: "POST",
    });
    assert.equal(postRes.status, 200);
    const postJson = (await postRes.json()) as typeof getJson;
    assert.equal(postJson.repositoryPath, fixtures.repoDir);
    assert.deepEqual(postJson.argv, ["git", "-C", fixtures.repoDir, "cherry-pick", validSha]);

    // Verify target repository is 100% UNCHANGED
    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    const statusAfter = spawnSync("git", ["status", "--porcelain"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    const branchesAfter = spawnSync("git", ["branch"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    const worktreesAfter = spawnSync("git", ["worktree", "list"], {
      cwd: fixtures.repoDir,
      shell: false,
      encoding: "utf8",
    }).stdout.trim();

    assert.equal(headAfter, headBefore, "Repository HEAD must be identical before and after");
    assert.equal(statusAfter, statusBefore, "Repository status must be identical before and after");
    assert.equal(branchesAfter, branchesBefore, "Repository branches must not have changed");
    assert.equal(worktreesAfter, worktreesBefore, "Repository worktrees must not have changed");
  } finally {
    if (server) await server.stop();
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 9. Dashboard UI Markup and Phase 4D Security / Accessibility
test("dashboard HTML and app.js include Phase 4D controls, lineage rendering, and safe DOM policy", async () => {
  const repoRoot = path.resolve(process.cwd());
  const indexHtml = await readFile(path.join(repoRoot, "ui", "index.html"), "utf8");
  const appJs = await readFile(path.join(repoRoot, "ui", "app.js"), "utf8");
  const stylesCss = await readFile(path.join(repoRoot, "ui", "styles.css"), "utf8");

  // Criterion 17: Copy Cherry-pick Command button in HTML
  assert.ok(indexHtml.includes('id="btn-copy-cherry-pick"'), "index.html must contain #btn-copy-cherry-pick");

  // Criterion 17: Retry and Replan button classes and logic in app.js
  assert.ok(appJs.includes("btn-retry-operation"), "app.js must render retry operation button");
  assert.ok(appJs.includes("btn-replan-operation"), "app.js must render replan operation button");
  assert.ok(appJs.includes("isEligibleForRetryReplan"), "app.js must check operation eligibility");

  // Eligibility condition checks COMPLETED or FAILED
  assert.ok(
    appJs.includes('op.status === "COMPLETED"') && appJs.includes('op.status === "FAILED"'),
    "app.js must expose retry and replan only for COMPLETED or FAILED operations",
  );

  // Lineage display in app.js
  assert.ok(appJs.includes("op.parentId"), "app.js must render parent operation lineage");
  assert.ok(appJs.includes("op.childOperationIds"), "app.js must render child operations lineage");
  assert.ok(appJs.includes("op.action"), "app.js must display operation action");

  // Replan form collects bounded feedback accessibly
  assert.ok(appJs.includes("replan-textarea"), "app.js must render replan textarea");
  assert.ok(appJs.includes('aria-required": "true"') || appJs.includes('"aria-required", "true"'), "replan textarea must be aria-required");
  assert.ok(appJs.includes("maxLength: 20000") || appJs.includes('"maxLength", 20000'), "replan textarea must bound input length");

  // Copy Cherry-pick Command gated to DONE state with commit SHA
  assert.ok(
    appJs.includes('summary.state === "DONE"') && appJs.includes("summary.integrationCommitSha"),
    "Copy Cherry-pick Command must be gated to DONE state with integrationCommitSha",
  );

  // Safe DOM rendering policy: ZERO innerHTML, outerHTML, eval, or CDNs
  assert.doesNotMatch(appJs, /\.innerHTML\s*=/, "app.js must not assign to innerHTML");
  assert.doesNotMatch(appJs, /\.outerHTML\s*=/, "app.js must not assign to outerHTML");
  assert.doesNotMatch(appJs, /\.insertAdjacentHTML\s*\(/, "app.js must not use insertAdjacentHTML");
  assert.doesNotMatch(appJs, /\beval\s*\(/, "app.js must not use eval");

  assert.doesNotMatch(indexHtml, /<script[^>]+src=["']https?:\/\//i, "No external scripts");
  assert.doesNotMatch(indexHtml, /<link[^>]+href=["']https?:\/\//i, "No external styles/fonts");
  assert.doesNotMatch(stylesCss, /@import\s+(?:url\(['"]?https?:|['"]https?:)/i, "No external imports");
});
