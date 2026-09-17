import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePort } from "../src/cli.js";
import type { HarnessConfig } from "../src/config.js";
import type { ParallelRunSummary } from "../src/parallel-types.js";
import type { CheckResult, ReviewResult } from "../src/types.js";
import {
  assertLoopbackHost,
  assertValidRunId,
  boundDiff,
  getBoundedIntegrationDiff,
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

function rawHttpRequest(
  port: number,
  requestPath: string,
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: { Connection: "close" },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
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
  let server: HarnessUiServer | undefined;
  try {
    const config = testConfig();
    server = new HarnessUiServer(config, tempRoot, { host: "127.0.0.1", port: 0 });

    assert.equal(server.listening, false);
    await server.start();
    assert.equal(server.listening, true);
    assert.ok(server.port > 0);
    assert.ok(server.url.startsWith("http://127.0.0.1:"));

    // Double start should reject
    await assert.rejects(() => server!.start(), /already running/);

    // Endpoint works
    const res = await fetch(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: "ok" });

    // Stop server
    await server.stop();
    assert.equal(server.listening, false);

    // After stop, connection should fail
    await assert.rejects(() => fetch(`${server!.url}/api/health`));
  } finally {
    if (server) {
      await server.stop();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("health endpoints: GET /api/health and /health", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-health-"));
  let server: HarnessUiServer | undefined;
  try {
    server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    const apiRes = await fetch(`${server.url}/api/health`);
    assert.equal(apiRes.status, 200);
    assert.deepEqual(await apiRes.json(), { status: "ok" });

    const rootRes = await fetch(`${server.url}/health`);
    assert.equal(rootRes.status, 200);
    assert.deepEqual(await rootRes.json(), { status: "ok" });
  } finally {
    if (server) {
      await server.stop();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("list parallel runs: returns newest-first and sanitizes raw process stdout/stderr", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-runs-list-"));
  let server: HarnessUiServer | undefined;
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

    server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
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
  } finally {
    if (server) {
      await server.stop();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("run status, events, review, checks, and diff endpoints", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-detail-"));
  let server: HarnessUiServer | undefined;
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

    server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
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
  } finally {
    if (server) {
      await server.stop();
    }
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
  let server: HarnessUiServer | undefined;
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

    server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
    await server.start();

    if (symlinkCreated) {
      const symlinkRes = await fetch(`${server.url}/api/parallel-runs/symlink-escape`);
      assert.equal(symlinkRes.status, 403);
      const symlinkJson = (await symlinkRes.json()) as { error?: string; stack?: unknown };
      assert.ok(symlinkJson.error);
      assert.equal(symlinkJson.stack, undefined);
    }

    // 1. Client-side URL normalization in standard fetch:
    // Standards-compliant clients normalize relative path segments before sending over the wire.
    const normalizedRunRes = await fetch(`${server.url}/api/parallel-runs/..`);
    // fetch normalizes /api/parallel-runs/.. to /api, which returns 404 (or 400 if client did not normalize)
    assert.ok(normalizedRunRes.status === 404 || normalizedRunRes.status === 400);
    const normalizedRunJson = (await normalizedRunRes.json()) as { error?: string; stack?: unknown };
    assert.ok(normalizedRunJson.error);
    assert.equal(normalizedRunJson.stack, undefined);
    assert.equal(JSON.stringify(normalizedRunJson).includes("TOP_SECRET"), false);

    const staticTraversalRes = await fetch(`${server.url}/../../secret.key`);
    // fetch normalizes /../../secret.key to /secret.key, returning 404
    assert.ok(staticTraversalRes.status === 400 || staticTraversalRes.status === 404);
    const staticJson = (await staticTraversalRes.json()) as { error?: string; stack?: unknown };
    assert.ok(staticJson.error);
    assert.equal(staticJson.stack, undefined);
    assert.equal(JSON.stringify(staticJson).includes("TOP_SECRET"), false);

    // 2. Encoded traversal via fetch (client may normalize or reroute before server validation)
    const encodedTraversalRes = await fetch(`${server.url}/api/parallel-runs/..%2f..%2fsecret.key`);
    assert.ok(encodedTraversalRes.status === 400 || encodedTraversalRes.status === 404);
    const encodedTraversalJson = (await encodedTraversalRes.json()) as { error?: string; stack?: unknown };
    assert.ok(encodedTraversalJson.error);
    assert.equal(encodedTraversalJson.stack, undefined);
    assert.equal(JSON.stringify(encodedTraversalJson).includes("TOP_SECRET"), false);

    // 3. Raw HTTP requests to exercise encoded and unnormalized traversal without client-side normalization
    // 3a. Encoded dot traversal in run ID (%2e%2e)
    const rawDotRes = await rawHttpRequest(server.port, "/api/parallel-runs/%2e%2e");
    assert.ok(rawDotRes.status === 400 || rawDotRes.status === 404);
    const rawDotJson = JSON.parse(rawDotRes.body) as { error?: string; stack?: unknown };
    assert.ok(rawDotJson.error);
    assert.equal(rawDotJson.stack, undefined);
    assert.equal(rawDotRes.body.includes("TOP_SECRET"), false);

    // 3b. Encoded path traversal in run ID (..%2f..%2fsecret.key)
    const rawRunTraversalRes = await rawHttpRequest(server.port, "/api/parallel-runs/..%2f..%2fsecret.key");
    assert.equal(rawRunTraversalRes.status, 400);
    const rawRunTraversalJson = JSON.parse(rawRunTraversalRes.body) as { error?: string; stack?: unknown };
    assert.ok(rawRunTraversalJson.error);
    assert.equal(rawRunTraversalJson.stack, undefined);
    assert.equal(rawRunTraversalRes.body.includes("TOP_SECRET"), false);

    // 3c. Encoded path traversal in static file request (/..%2fsecret.key)
    const rawStaticTraversalRes = await rawHttpRequest(server.port, "/..%2fsecret.key");
    assert.ok(rawStaticTraversalRes.status === 400 || rawStaticTraversalRes.status === 404);
    const rawStaticJson = JSON.parse(rawStaticTraversalRes.body) as { error?: string; stack?: unknown };
    assert.ok(rawStaticJson.error);
    assert.equal(rawStaticJson.stack, undefined);
    assert.equal(rawStaticTraversalRes.body.includes("TOP_SECRET"), false);

    // 4. Method not allowed
    const postRes = await fetch(`${server.url}/api/parallel-runs`, { method: "POST" });
    assert.equal(postRes.status, 405);
    const postJson = (await postRes.json()) as { error?: string };
    assert.equal(postJson.error, "Method not allowed");
  } finally {
    if (server) {
      await server.stop();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("static file serving serves repository ui directory with safe fallback when missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-static-"));
  let server: HarnessUiServer | undefined;
  try {
    server = new HarnessUiServer(testConfig(), tempRoot, { host: "127.0.0.1", port: 0 });
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
    const missingJson = (await missingRes.json()) as { error?: string };
    assert.equal(missingJson.error, "Not found");
  } finally {
    if (server) {
      await server.stop();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("cli parsePort strictly validates port numbers", () => {
  // Valid ports
  assert.equal(parsePort("4310"), 4310);
  assert.equal(parsePort("0"), 0);
  assert.equal(parsePort("80"), 80);
  assert.equal(parsePort("65535"), 65535);
  assert.equal(parsePort(undefined), 4310);

  // Rejects trailing characters
  assert.equal(parsePort("8080abc"), null);
  assert.equal(parsePort("4310 "), null);
  assert.equal(parsePort(" 4310"), null);
  assert.equal(parsePort("4310p"), null);

  // Rejects fractions
  assert.equal(parsePort("80.5"), null);
  assert.equal(parsePort("0.0"), null);
  assert.equal(parsePort("4310.00"), null);

  // Rejects negatives
  assert.equal(parsePort("-1"), null);
  assert.equal(parsePort("-4310"), null);

  // Rejects values above 65535
  assert.equal(parsePort("65536"), null);
  assert.equal(parsePort("99999"), null);
  assert.equal(parsePort("1000000"), null);

  // Rejects empty / non-numeric
  assert.equal(parsePort(""), null);
  assert.equal(parsePort("abc"), null);
  assert.equal(parsePort("NaN"), null);
});

test("getBoundedIntegrationDiff rejects worktrees outside run directory and ignores repositoryPath fallback", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-diff-security-"));
  try {
    const runDir = path.join(tempRoot, "run-1");
    const externalDir = path.join(tempRoot, "external-repo");
    await mkdir(runDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });

    // 1. status.json with integrationWorktreePath outside runDirectory
    const summaryEscapingWorktree = {
      id: "run-1",
      state: "DONE",
      message: "Done",
      repositoryPath: externalDir,
      baseSha: "abc123",
      integrationCommitSha: "def456",
      integrationWorktreePath: externalDir,
    };
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(summaryEscapingWorktree), "utf8");

    // Must return null without executing git on external directory
    const diff1 = await getBoundedIntegrationDiff(runDir);
    assert.equal(diff1, null);

    // 2. status.json with relative path traversal in integrationWorktreePath
    const summaryTraversal = {
      id: "run-1",
      state: "DONE",
      message: "Done",
      baseSha: "abc123",
      integrationWorktreePath: "../external-repo",
    };
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(summaryTraversal), "utf8");
    const diff2 = await getBoundedIntegrationDiff(runDir);
    assert.equal(diff2, null);

    // 3. status.json with repositoryPath fallback only (no integrationWorktreePath)
    // The unsafe fallback must be removed, so this must return null
    const summaryFallbackOnly = {
      id: "run-1",
      state: "DONE",
      message: "Done",
      repositoryPath: externalDir,
      baseSha: "abc123",
      integrationCommitSha: "def456",
    };
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(summaryFallbackOnly), "utf8");
    const diff3 = await getBoundedIntegrationDiff(runDir);
    assert.equal(diff3, null);

    // 4. Malicious baseSha in status.json
    const validChildWorktree = path.join(runDir, "integration-worktree");
    await mkdir(validChildWorktree, { recursive: true });
    const summaryBadSha = {
      id: "run-1",
      state: "DONE",
      message: "Done",
      baseSha: "--output=/escape",
      integrationWorktreePath: validChildWorktree,
    };
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(summaryBadSha), "utf8");
    const diff4 = await getBoundedIntegrationDiff(runDir);
    assert.equal(diff4, null);

    // 5. Standalone patch file still works as primary source
    await writeFile(path.join(runDir, "integration-diff.patch"), "--- a\n+++ b\n+hello\n", "utf8");
    const diff5 = await getBoundedIntegrationDiff(runDir);
    assert.ok(diff5);
    assert.ok(diff5.diff.includes("+hello"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
