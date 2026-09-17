import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HarnessConfig } from "../src/config.js";
import type { ParallelRunSummary } from "../src/parallel-types.js";
import type { CheckResult, ReviewResult } from "../src/types.js";
import {
  assertLoopbackHost,
  assertValidRunId,
  boundDiff,
  HarnessUiServer,
  isLoopbackHost,
  isValidRunId,
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

test("loopback binding validation accepts local addresses and rejects external hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("127.0.0.2"), true);
  assert.equal(isLoopbackHost("127.255.255.254"), true);

  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("192.168.1.100"), false);
  assert.equal(isLoopbackHost("10.0.0.1"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);

  assert.doesNotThrow(() => assertLoopbackHost("127.0.0.1"));
  assert.doesNotThrow(() => assertLoopbackHost("localhost"));
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /Cannot bind to non-loopback address/);
  assert.throws(() => assertLoopbackHost("192.168.0.1"), /Cannot bind to non-loopback address/);
});

test("run ID validation rejects path traversal and special characters", () => {
  assert.equal(isValidRunId("parallel-20260917100000-abcd1234"), true);
  assert.equal(isValidRunId("run_1"), true);
  assert.equal(isValidRunId("run-a_b-1"), true);

  assert.equal(isValidRunId("../escape"), false);
  assert.equal(isValidRunId("..\\escape"), false);
  assert.equal(isValidRunId(".."), false);
  assert.equal(isValidRunId(".git"), false);
  assert.equal(isValidRunId("foo/bar"), false);
  assert.equal(isValidRunId("foo\\bar"), false);
  assert.equal(isValidRunId("run\0injection"), false);
  assert.equal(isValidRunId(""), false);

  assert.doesNotThrow(() => assertValidRunId("parallel-123"));
  assert.throws(() => assertValidRunId("../run"), /Invalid run id/);
  assert.throws(() => assertValidRunId(".."), /Invalid run id/);
});

test("server lifecycle: start, ephemeral port, stop, and double-start protection", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-lifecycle-"));
  try {
    const config = testConfig();
    const server = new HarnessUiServer(config, tempRoot, { host: "127.0.0.1", port: 0 });

    assert.equal(server.listening, false);
    await server.start();
    assert.equal(server.listening, true);
    assert.ok(server.port > 0);
    assert.ok(server.url.startsWith("http://127.0.0.1:"));

    // Double start should reject
    await assert.rejects(() => server.start(), /already running/);

    // Endpoint works
    const res = await fetch(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: "ok" });

    // Stop server
    await server.stop();
    assert.equal(server.listening, false);

    // After stop, connection should fail
    await assert.rejects(() => fetch(`${server.url}/api/health`));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("health endpoints: GET /api/health and /health", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-health-"));
  try {
    const server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    const apiRes = await fetch(`${server.url}/api/health`);
    assert.equal(apiRes.status, 200);
    assert.deepEqual(await apiRes.json(), { status: "ok" });

    const rootRes = await fetch(`${server.url}/health`);
    assert.equal(rootRes.status, 200);
    assert.deepEqual(await rootRes.json(), { status: "ok" });

    await server.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("list parallel runs: returns newest-first and sanitizes raw process stdout/stderr", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-runs-list-"));
  try {
    const runsDir = path.join(tempRoot, ".harness", "parallel-runs");
    const run1 = path.join(runsDir, "parallel-20260917100000-aaaa1111");
    const run2 = path.join(runsDir, "parallel-20260917120000-bbbb2222");
    await mkdir(run1, { recursive: true });
    await mkdir(run2, { recursive: true });

    const summary1: ParallelRunSummary = {
      id: "parallel-20260917100000-aaaa1111",
      state: "DONE",
      message: "First run completed",
      repositoryPath: "/repo",
      shardResults: [
        {
          id: "shard-1",
          state: "APPROVED",
          branch: "b1",
          worktreePath: "/wt1",
          revisionRound: 0,
          message: "ok",
          changedFiles: ["a.txt"],
          checks: [
            {
              command: "npm",
              args: ["test"],
              cwd: "/wt1",
              exitCode: 0,
              signal: null,
              stdout: "SECRET_STDOUT_LOGS_RUN1",
              stderr: "SECRET_STDERR_LOGS_RUN1",
              durationMs: 120,
              timedOut: false,
              passed: true,
            },
          ],
        },
      ],
    };

    const summary2: ParallelRunSummary = {
      id: "parallel-20260917120000-bbbb2222",
      state: "INTEGRATING",
      message: "Second run integrating",
      repositoryPath: "/repo",
      shardResults: [],
    };

    await writeFile(path.join(run1, "status.json"), JSON.stringify(summary1), "utf8");
    await writeFile(path.join(run2, "status.json"), JSON.stringify(summary2), "utf8");

    const server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    const res = await fetch(`${server.url}/api/parallel-runs`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as ParallelRunSummary[];

    // Newest first: run2 before run1
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, "parallel-20260917120000-bbbb2222");
    assert.equal(list[1]?.id, "parallel-20260917100000-aaaa1111");

    // Verify stdout/stderr logs are omitted
    const shard = list[1]?.shardResults[0];
    assert.ok(shard);
    assert.equal(shard.checks.length, 1);
    const check = shard.checks[0] as any;
    assert.equal(check.passed, true);
    assert.equal(check.stdout, undefined);
    assert.equal(check.stderr, undefined);

    await server.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("run status, events, review, checks, and diff endpoints", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-detail-"));
  try {
    const runId = "parallel-20260917140000-cccc3333";
    const runDir = path.join(tempRoot, ".harness", "parallel-runs", runId);
    await mkdir(runDir, { recursive: true });

    const summary: ParallelRunSummary = {
      id: runId,
      state: "DONE",
      message: "All tasks approved and integrated",
      repositoryPath: "/fake/repo",
      baseSha: "base123",
      integrationCommitSha: "commit456",
      shardResults: [],
    };
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(summary), "utf8");

    const events = [
      { at: "2026-09-17T14:00:00.000Z", state: "RECEIVED", message: "Job received" },
      { at: "2026-09-17T14:00:05.000Z", state: "DONE", message: "Job finished" },
    ];
    await writeFile(
      path.join(runDir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const review: ReviewResult = {
      verdict: "approved",
      summary: "Integration diff verified cleanly",
      findings: [],
      acceptance_criteria: [{ criterion: "Modules work", status: "passed", evidence: "tests passed" }],
    };
    await writeFile(path.join(runDir, "integration-review.json"), JSON.stringify(review), "utf8");

    const checks: CheckResult[] = [
      {
        command: "npm",
        args: ["test"],
        cwd: "/fake/repo",
        exitCode: 0,
        signal: null,
        stdout: "RAW_STDOUT_INTERNAL",
        stderr: "RAW_STDERR_INTERNAL",
        durationMs: 500,
        timedOut: false,
        passed: true,
      },
    ];
    await writeFile(path.join(runDir, "integration-checks.json"), JSON.stringify(checks), "utf8");

    const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
    await writeFile(path.join(runDir, "integration-diff.patch"), patch, "utf8");

    const server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    // 1. Status
    const statusRes = await fetch(`${server.url}/api/parallel-runs/${runId}`);
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as ParallelRunSummary;
    assert.equal(statusData.id, runId);
    assert.equal(statusData.state, "DONE");

    // 2. Events
    const eventsRes = await fetch(`${server.url}/api/parallel-runs/${runId}/events`);
    assert.equal(eventsRes.status, 200);
    const eventsData = await eventsRes.json();
    assert.deepEqual(eventsData, events);

    // 3. Integration review
    const reviewRes = await fetch(`${server.url}/api/parallel-runs/${runId}/integration-review`);
    assert.equal(reviewRes.status, 200);
    const reviewData = (await reviewRes.json()) as ReviewResult;
    assert.equal(reviewData.verdict, "approved");
    assert.equal(reviewData.summary, "Integration diff verified cleanly");

    // 4. Integration checks (must omit stdout/stderr)
    const checksRes = await fetch(`${server.url}/api/parallel-runs/${runId}/integration-checks`);
    assert.equal(checksRes.status, 200);
    const checksData = (await checksRes.json()) as any[];
    assert.equal(checksData.length, 1);
    assert.equal(checksData[0]?.passed, true);
    assert.equal(checksData[0]?.stdout, undefined);
    assert.equal(checksData[0]?.stderr, undefined);

    // 5. Integration diff (JSON by default)
    const diffRes = await fetch(`${server.url}/api/parallel-runs/${runId}/integration-diff`);
    assert.equal(diffRes.status, 200);
    const diffData = (await diffRes.json()) as { id: string; diff: string; truncated: boolean };
    assert.equal(diffData.id, runId);
    assert.ok(diffData.diff.includes("+new"));
    assert.equal(diffData.truncated, false);

    // 6. Integration diff text format
    const diffTextRes = await fetch(`${server.url}/api/parallel-runs/${runId}/integration-diff`, {
      headers: { Accept: "text/plain" },
    });
    assert.equal(diffTextRes.status, 200);
    const diffText = await diffTextRes.text();
    assert.ok(diffText.includes("+new"));

    await server.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("diff bounding truncates large diffs cleanly", () => {
  const largeDiff = Array.from({ length: 3000 }, (_, i) => `+line ${i}`).join("\n");
  const bounded = boundDiff(largeDiff, 10_000, 100);

  assert.equal(bounded.truncated, true);
  assert.ok(bounded.diff.includes("[diff truncated: maximum size limit reached]"));
  assert.ok(bounded.diff.split("\n").length <= 103);
});

test("traversal and symlink rejection returns safe JSON error responses", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-security-"));
  try {
    const dataDir = path.join(tempRoot, ".harness", "parallel-runs");
    await mkdir(dataDir, { recursive: true });

    // Create a secret file outside the harness data directory
    const secretFile = path.join(tempRoot, "secret.key");
    await writeFile(secretFile, "TOP_SECRET_API_KEY", "utf8");

    // Create a symlink escape pointing outside parallel-runs
    const symlinkDir = path.join(dataDir, "symlink-escape");
    let symlinkCreated = false;
    try {
      await symlink(tempRoot, symlinkDir, "dir");
      symlinkCreated = true;
    } catch {
      // Symlinks may require special privileges on some Windows configurations; skip symlink creation if not allowed
    }

    const server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    if (symlinkCreated) {
      const symlinkRes = await fetch(`${server.url}/api/parallel-runs/symlink-escape`);
      assert.equal(symlinkRes.status, 403);
      const symlinkJson = await symlinkRes.json();
      assert.ok(symlinkJson.error);
    }

    // 1. Direct path traversal in run ID
    const traversalRes = await fetch(`${server.url}/api/parallel-runs/..%2f..%2fsecret.key`);
    assert.equal(traversalRes.status, 400);
    const traversalJson = await traversalRes.json();
    assert.ok(traversalJson.error);
    assert.equal(traversalJson.stack, undefined);
    assert.equal(traversalJson.error.includes("TOP_SECRET"), false);

    // 2. Relative traversal
    const dotRes = await fetch(`${server.url}/api/parallel-runs/..`);
    assert.equal(dotRes.status, 400);

    // 3. Traversal in static file request
    const staticTraversalRes = await fetch(`${server.url}/../../secret.key`);
    assert.ok(staticTraversalRes.status === 400 || staticTraversalRes.status === 404);
    const staticJson = await staticTraversalRes.json();
    assert.ok(staticJson.error);
    assert.equal(staticJson.stack, undefined);

    // 4. Method not allowed
    const postRes = await fetch(`${server.url}/api/parallel-runs`, { method: "POST" });
    assert.equal(postRes.status, 405);
    const postJson = await postRes.json();
    assert.equal(postJson.error, "Method not allowed");

    await server.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("static file serving serves repository ui directory with safe fallback when missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-static-"));
  try {
    const server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    // 1. When ui/ does not exist, GET / serves fallback HTML
    const fallbackRes = await fetch(`${server.url}/`);
    assert.equal(fallbackRes.status, 200);
    assert.equal(fallbackRes.headers.get("content-type"), "text/html; charset=utf-8");
    const fallbackHtml = await fallbackRes.text();
    assert.ok(fallbackHtml.includes("Phase 4A API Active"));
    assert.ok(fallbackHtml.includes("AI Dev Team Harness"));

    // 2. Now create ui/ directory with custom index.html and style.css
    const uiDir = path.join(tempRoot, "ui");
    await mkdir(uiDir, { recursive: true });
    await writeFile(path.join(uiDir, "index.html"), "<html><body>Custom UI</body></html>", "utf8");
    await writeFile(path.join(uiDir, "style.css"), "body { color: blue; }", "utf8");

    const customIndexRes = await fetch(`${server.url}/`);
    assert.equal(customIndexRes.status, 200);
    assert.equal(await customIndexRes.text(), "<html><body>Custom UI</body></html>");

    const assetRes = await fetch(`${server.url}/style.css`);
    assert.equal(assetRes.status, 200);
    assert.equal(assetRes.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await assetRes.text(), "body { color: blue; }");

    // Missing asset returns 404 JSON
    const missingRes = await fetch(`${server.url}/missing.js`);
    assert.equal(missingRes.status, 404);
    const missingJson = await missingRes.json();
    assert.equal(missingJson.error, "Not found");

    await server.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
