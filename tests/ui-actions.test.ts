import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HarnessConfig } from "../src/config.js";
import {
  assertValidOperationId,
  HarnessUiServer,
  isValidOperationId,
  sanitizeMessage,
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

function initGitRepo(dir: string): void {
  const result = spawnSync("git", ["init", "-b", "main"], { cwd: dir, shell: false });
  if (result.status !== 0) {
    spawnSync("git", ["init"], { cwd: dir, shell: false });
  }
}

async function createTestFixtures() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-actions-"));
  const harnessRoot = path.join(tempRoot, "harness");
  const repoDir = path.join(tempRoot, "repo");
  const notRepoDir = path.join(tempRoot, "not-repo");

  await mkdir(harnessRoot, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(notRepoDir, { recursive: true });

  initGitRepo(repoDir);

  // Create a mock CLI script that outputs run ID and exits cleanly
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

  // Create a hanging CLI script for cancellation testing
  const hangCliScript = path.join(harnessRoot, "hang-cli.js");
  await writeFile(
    hangCliScript,
    `
    console.log(JSON.stringify({ id: "parallel-20260917999999-cancel01", state: "RUNNING" }));
    setInterval(() => {}, 1000);
    `,
    "utf8",
  );

  return { tempRoot, harnessRoot, repoDir, notRepoDir, mockCliScript, hangCliScript };
}

// 1. Operation ID and Sanitization Unit Tests
test("operation ID validation matches strict pattern and rejects traversal", () => {
  assert.equal(isValidOperationId("op-20260917120000-abcd1234"), true);
  assert.equal(isValidOperationId("op_1"), true);
  assert.equal(isValidOperationId("operation-123"), true);

  assert.equal(isValidOperationId("../escape"), false);
  assert.equal(isValidOperationId("..\\escape"), false);
  assert.equal(isValidOperationId("op/sub"), false);
  assert.equal(isValidOperationId(""), false);
  assert.equal(isValidOperationId(".hidden"), false);

  assert.doesNotThrow(() => assertValidOperationId("op-valid-123"));
  assert.throws(() => assertValidOperationId("../escape"), /Invalid operation id/);
});

test("sanitizeMessage redacts secrets and external paths while preserving repository path", () => {
  const allowedRepo = "D:\\target-repo";
  const rawWithSecret = "Error connecting with bearer sk-secret1234567890abcdef and token: secretpass";
  const sanitizedSecret = sanitizeMessage(rawWithSecret, allowedRepo);
  assert.equal(sanitizedSecret.includes("sk-secret1234567890abcdef"), false);
  assert.equal(sanitizedSecret.includes("secretpass"), false);
  assert.equal(sanitizedSecret.includes("token: [REDACTED]"), true);
  assert.equal(sanitizedSecret.includes("[REDACTED"), true);

  // External path redacted
  const rawWithExternalPath = "Failed to load C:\\Users\\Administrator\\Secret\\token.json from D:\\target-repo\\src\\file.ts";
  const sanitizedPaths = sanitizeMessage(rawWithExternalPath, allowedRepo);
  assert.equal(sanitizedPaths.includes("C:\\Users\\Administrator\\Secret\\token.json"), false);
  assert.equal(sanitizedPaths.includes("[REDACTED_PATH]"), true);
  // Allowed repo path preserved
  assert.equal(sanitizedPaths.includes("D:\\target-repo\\src\\file.ts"), true);

  // Long message truncated
  const longMsg = "A".repeat(600);
  const truncated = sanitizeMessage(longMsg, allowedRepo);
  assert.ok(truncated.length <= 500);
  assert.ok(truncated.endsWith("..."));
});

// 2. Successful POST /api/runs and Persistence
test("POST /api/runs validates payload, starts operation asynchronously, and persists metadata", async () => {
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

    const response = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        repositoryPath: fixtures.repoDir,
        requirement: "Implement parallel payment service",
      }),
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      id: string;
      status: string;
      repositoryPath: string;
      requirement: string;
      cancellable: boolean;
    };

    assert.ok(body.id.startsWith("op-"));
    assert.equal(body.status, "RUNNING");
    assert.equal(body.repositoryPath, path.resolve(fixtures.repoDir));
    assert.equal(body.requirement, "Implement parallel payment service");
    assert.equal(typeof body.cancellable, "boolean");

    // Wait for mock CLI to complete
    await server.operationManager.waitForOperationsToSettle();

    // Verify metadata file was persisted under .harness/ui/operations/<id>.json
    const operationsDir = path.join(fixtures.harnessRoot, config.dataDirectory, "ui", "operations");
    const opFile = path.join(operationsDir, `${body.id}.json`);
    const fileStat = await stat(opFile);
    assert.ok(fileStat.isFile());

    const fileContent = JSON.parse(await readFile(opFile, "utf8"));
    assert.equal(fileContent.id, body.id);
    assert.equal(fileContent.repositoryPath, path.resolve(fixtures.repoDir));

    const readRes = await fetch(`${server.url}/api/operations/${body.id}`);
    assert.equal(readRes.status, 200);
    const updated = (await readRes.json()) as { status: string; runId?: string; cancellable: boolean };
    assert.equal(updated.status, "COMPLETED");
    assert.equal(updated.runId, "parallel-20260917120000-abcd1234");
    assert.equal(updated.cancellable, false);
  } finally {
    if (server) {
      await server.operationManager.waitForOperationsToSettle().catch(() => {});
      await server.stop();
    }
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 3. Validation Errors, Content-Type enforcement, and Oversized Payloads
test("POST /api/runs enforces Content-Type and strict validation on repositoryPath and requirement", async () => {
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

    // Content-Type enforcement (Feedback #4)
    // A. Missing Content-Type
    const noContentTypeRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      body: JSON.stringify({ repositoryPath: fixtures.repoDir, requirement: "Valid requirement" }),
    });
    assert.equal(noContentTypeRes.status, 415);
    const noContentJson = (await noContentTypeRes.json()) as { error: string };
    assert.match(noContentJson.error, /Content-Type must be application\/json/);

    // B. text/plain Content-Type rejected with 415
    const textPlainRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ repositoryPath: fixtures.repoDir, requirement: "Valid requirement" }),
    });
    assert.equal(textPlainRes.status, 415);

    // C. form Content-Type rejected with 415
    const formRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "repositoryPath=foo&requirement=bar",
    });
    assert.equal(formRes.status, 415);

    // D. Missing repositoryPath
    const noRepoRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirement: "Valid requirement" }),
    });
    assert.equal(noRepoRes.status, 400);
    const noRepoJson = (await noRepoRes.json()) as { error: string };
    assert.match(noRepoJson.error, /repositoryPath must be a non-empty string/);

    // E. Relative repositoryPath
    const relRepoRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: "./relative/repo", requirement: "Valid requirement" }),
    });
    assert.equal(relRepoRes.status, 400);
    const relRepoJson = (await relRepoRes.json()) as { error: string };
    assert.match(relRepoJson.error, /repositoryPath must be an absolute path/);

    // F. Non-existent repositoryPath
    const nonExistentPath = path.join(fixtures.tempRoot, "does-not-exist");
    const nonExistentRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: nonExistentPath, requirement: "Valid requirement" }),
    });
    assert.equal(nonExistentRes.status, 400);
    const nonExistentJson = (await nonExistentRes.json()) as { error: string };
    assert.match(nonExistentJson.error, /repositoryPath does not exist/);

    // G. Directory that is NOT a Git repo
    const notGitRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixtures.notRepoDir, requirement: "Valid requirement" }),
    });
    assert.equal(notGitRes.status, 400);
    const notGitJson = (await notGitRes.json()) as { error: string };
    assert.match(notGitJson.error, /repositoryPath must be a Git repository/);

    // H. Missing requirement
    const noReqRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixtures.repoDir }),
    });
    assert.equal(noReqRes.status, 400);
    const noReqJson = (await noReqRes.json()) as { error: string };
    assert.match(noReqJson.error, /requirement must be a non-empty string/);

    // I. Empty requirement
    const emptyReqRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixtures.repoDir, requirement: "   " }),
    });
    assert.equal(emptyReqRes.status, 400);

    // J. Oversized requirement (> 20,000 characters)
    const giantReq = "X".repeat(25000);
    const giantReqRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixtures.repoDir, requirement: giantReq }),
    });
    assert.equal(giantReqRes.status, 400);
    const giantReqJson = (await giantReqRes.json()) as { error: string };
    assert.match(giantReqJson.error, /requirement exceeds maximum/);

    // K. Malformed JSON payload
    const malformedRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });
    assert.equal(malformedRes.status, 400);
    const malformedJson = (await malformedRes.json()) as { error: string };
    assert.match(malformedJson.error, /Malformed JSON payload/);

    // L. Non-object JSON payload
    const arrayRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["invalid", "array"]),
    });
    assert.equal(arrayRes.status, 400);
  } finally {
    if (server) await server.stop();
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

test("POST /api/runs rejects oversized request bodies with 413", async () => {
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

    // Send payload exceeding 64KB
    const oversizedBody = JSON.stringify({
      repositoryPath: fixtures.repoDir,
      requirement: "A".repeat(70 * 1024),
    });

    const res = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });

    assert.equal(res.status, 413);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /Payload too large/);
  } finally {
    if (server) await server.stop();
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 4. Operations Listing and Single Operation Reads with EBUSY Fix
test("GET /api/operations lists operations newest-first without leaking stdout/stderr", async () => {
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

    // Start two runs
    await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixtures.repoDir, requirement: "Task 1" }),
    });

    await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryPath: fixtures.repoDir, requirement: "Task 2" }),
    });

    // Feedback #6: Wait for mock CLI processes to exit before reading / cleanup
    await server.operationManager.waitForOperationsToSettle();

    const listRes = await fetch(`${server.url}/api/operations`);
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as Array<{
      id: string;
      requirement: string;
      stdout?: unknown;
      stderr?: unknown;
    }>;

    assert.equal(list.length, 2);
    // Newest first: Task 2 should be first
    assert.equal(list[0]?.requirement, "Task 2");
    assert.equal(list[1]?.requirement, "Task 1");

    // Zero stdout / stderr leakage
    for (const op of list) {
      assert.equal(op.stdout, undefined);
      assert.equal(op.stderr, undefined);
    }

    // Single operation 404
    const notFoundRes = await fetch(`${server.url}/api/operations/op-nonexistent`);
    assert.equal(notFoundRes.status, 404);

    // Single operation path traversal rejected
    const traversalRes = await fetch(`${server.url}/api/operations/..%2fescape`);
    assert.equal(traversalRes.status, 400);
  } finally {
    if (server) {
      await server.operationManager.waitForOperationsToSettle().catch(() => {});
      await server.stop();
    }
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 5. Cancellation Ownership, Idempotency, and Safety
test("POST /api/operations/:id/cancel terminates only tracked child process and is idempotent", async () => {
  const fixtures = await createTestFixtures();
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, fixtures.harnessRoot, {
      host: "127.0.0.1",
      port: 0,
      cliScriptPath: fixtures.hangCliScript, // long-running process
    });
    await server.start();

    // Start a long-running operation
    const startRes = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryPath: fixtures.repoDir,
        requirement: "Long running task",
      }),
    });

    assert.equal(startRes.status, 201);
    const started = (await startRes.json()) as { id: string; status: string; cancellable: boolean };
    assert.equal(started.status, "RUNNING");
    assert.equal(started.cancellable, true);

    // Verify process is tracked as live
    assert.equal(server.operationManager.isLive(started.id), true);

    // Cancel the operation (Feedback #1: must be CANCELLED, never FAILED)
    const cancelRes = await fetch(`${server.url}/api/operations/${started.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelRes.status, 200);
    const cancelled = (await cancelRes.json()) as {
      id: string;
      status: string;
      cancellable: boolean;
      message: string;
    };

    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancellable, false);
    assert.equal(cancelled.message, "Operation cancelled by user");

    // Live process was terminated and removed from tracking
    assert.equal(server.operationManager.isLive(started.id), false);

    // Wait for the killed child process to settle
    await server.operationManager.waitForOperationsToSettle();

    // Verify durable state on disk is CANCELLED (not overwritten by close)
    const readAfterCancel = await fetch(`${server.url}/api/operations/${started.id}`);
    assert.equal(readAfterCancel.status, 200);
    const readAfterCancelJson = (await readAfterCancel.json()) as { status: string };
    assert.equal(readAfterCancelJson.status, "CANCELLED");

    // Idempotent cancel: cancelling again succeeds with same CANCELLED status
    const cancelAgainRes = await fetch(`${server.url}/api/operations/${started.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelAgainRes.status, 200);
    const cancelAgainJson = (await cancelAgainRes.json()) as { status: string };
    assert.equal(cancelAgainJson.status, "CANCELLED");

    // Cancel non-existent operation returns 404
    const cancelNotFound = await fetch(`${server.url}/api/operations/op-missing/cancel`, {
      method: "POST",
    });
    assert.equal(cancelNotFound.status, 404);

    // Cancellation of an unowned operation returns 409 Conflict (Feedback #3)
    const opManager = server.operationManager;
    const dummyOpId = "op-20260917000000-dummy001";
    await opManager.persistOperation({
      id: dummyOpId,
      status: "RUNNING",
      type: "parallel_run",
      repositoryPath: fixtures.repoDir,
      requirement: "Stale run from old session",
      startedAt: new Date().toISOString(),
      cancellable: false,
    });

    const cancelStale = await fetch(`${server.url}/api/operations/${dummyOpId}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelStale.status, 409);
    const cancelStaleJson = (await cancelStale.json()) as { error: string };
    assert.match(cancelStaleJson.error, /process is not tracked/);

    // State on disk remains RUNNING (unchanged!)
    const opAfter = await opManager.getOperationRaw(dummyOpId);
    assert.equal(opAfter?.status, "RUNNING");
  } finally {
    if (server) {
      await server.operationManager.waitForOperationsToSettle().catch(() => {});
      await server.stop();
    }
    await rm(fixtures.tempRoot, { recursive: true, force: true });
  }
});

// 6. UI Markup and Static Contract Verifications
test("dashboard HTML and app.js include New Run form, safety notice, operations UI, and zero innerHTML", async () => {
  const repoRoot = path.resolve(process.cwd());
  const indexHtml = await readFile(path.join(repoRoot, "ui", "index.html"), "utf8");
  const appJs = await readFile(path.join(repoRoot, "ui", "app.js"), "utf8");
  const stylesCss = await readFile(path.join(repoRoot, "ui", "styles.css"), "utf8");

  // Criterion 6: Accessible New Run form with inputs and cancel controls
  assert.ok(indexHtml.includes('id="new-run-form"'), "index.html must contain #new-run-form");
  assert.ok(indexHtml.includes('id="input-repo-path"'), "index.html must contain #input-repo-path");
  assert.ok(indexHtml.includes('name="repositoryPath"'), "form must have name=repositoryPath");
  assert.ok(indexHtml.includes('id="input-requirement"'), "index.html must contain #input-requirement");
  assert.ok(indexHtml.includes('name="requirement"'), "form must have name=requirement");
  assert.ok(indexHtml.includes('id="btn-submit-run"'), "index.html must contain #btn-submit-run");
  assert.ok(indexHtml.includes('id="operations-container"'), "index.html must contain #operations-container");

  // Criterion 7: Clear safety guarantee text
  assert.ok(
    indexHtml.includes("Runs use isolated worktrees and never auto-merge the original checkout."),
    "index.html must clearly state isolated worktree safety guarantee",
  );

  // Criterion 8: Safe DOM rendering - ZERO innerHTML or outerHTML
  assert.doesNotMatch(appJs, /\.innerHTML\s*=/, "app.js must not assign to innerHTML");
  assert.doesNotMatch(appJs, /\.outerHTML\s*=/, "app.js must not assign to outerHTML");
  assert.doesNotMatch(appJs, /\.insertAdjacentHTML\s*\(/, "app.js must not use insertAdjacentHTML");
  assert.doesNotMatch(appJs, /document\.write(?:ln)?\s*\(/, "app.js must not use document.write");
  assert.doesNotMatch(appJs, /\beval\s*\(/, "app.js must not use eval");

  // Zero external fonts, CDNs, or scripts
  assert.doesNotMatch(indexHtml, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(indexHtml, /<link[^>]+href=["']https?:\/\//i);
  assert.doesNotMatch(stylesCss, /@import\s+(?:url\(['"]?https?:|['"]https?:)/i);

  // App JS has cancel control logic shown only for cancellable operations
  assert.ok(appJs.includes("btn-cancel-operation"), "app.js must handle cancel operation");
  assert.ok(appJs.includes("op.cancellable"), "app.js must check op.cancellable for cancel control");
});
