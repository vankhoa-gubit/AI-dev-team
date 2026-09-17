import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import type { ParallelRunSummary, ParallelShardResult } from "../parallel-types.js";
import type { CheckResult, ReviewResult } from "../types.js";
import { getBoundedIntegrationDiff, type BoundedDiffResult } from "./diff.js";
import {
  assertSafeChildPath,
  assertValidRunId,
  NotFoundError,
  sanitizeErrorMessage,
  SecurityError,
} from "./security.js";
import { serveStatic } from "./static.js";

export type SanitizedCheckResult = Omit<CheckResult, "stdout" | "stderr">;

export function sanitizeCheckResult(check: CheckResult): SanitizedCheckResult {
  const { stdout, stderr, ...rest } = check;
  return rest;
}

export function sanitizeShardResult(shard: ParallelShardResult): ParallelShardResult {
  return {
    ...shard,
    checks: shard.checks.map(sanitizeCheckResult) as CheckResult[],
  };
}

export function sanitizeRunSummary(summary: ParallelRunSummary): ParallelRunSummary {
  return {
    ...summary,
    shardResults: summary.shardResults.map(sanitizeShardResult),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function getParallelRuns(dataRoot: string): Promise<ParallelRunSummary[]> {
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  if (!(await pathExists(runsDirectory))) {
    return [];
  }

  const entries = await readdir(runsDirectory, { withFileTypes: true });
  const runSummaries: Array<{ summary: ParallelRunSummary; orderKey: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    try {
      assertValidRunId(runId);
      const safeDir = await assertSafeChildPath(runsDirectory, runId);
      const statusFile = path.join(safeDir, "status.json");
      if (await pathExists(statusFile)) {
        const raw = await readFile(statusFile, "utf8");
        const parsed = JSON.parse(raw) as ParallelRunSummary;
        runSummaries.push({
          summary: sanitizeRunSummary(parsed),
          orderKey: runId,
        });
      } else {
        runSummaries.push({
          summary: {
            id: runId,
            state: "RECEIVED",
            message: "",
            repositoryPath: "",
            shardResults: [],
          },
          orderKey: runId,
        });
      }
    } catch {
      // Ignore invalid or unreadable directories
    }
  }

  // Newest first: parallel run IDs start with parallel-YYYYMMDDHHMMSS-...
  runSummaries.sort((a, b) => b.orderKey.localeCompare(a.orderKey));
  return runSummaries.map((item) => item.summary);
}

export async function getParallelRunStatus(
  dataRoot: string,
  runId: string,
): Promise<ParallelRunSummary> {
  assertValidRunId(runId);
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  const safeDir = await assertSafeChildPath(runsDirectory, runId);
  const statusFile = path.join(safeDir, "status.json");

  if (!(await pathExists(statusFile))) {
    throw new NotFoundError(`Run '${runId}' not found`);
  }

  const raw = await readFile(statusFile, "utf8");
  const parsed = JSON.parse(raw) as ParallelRunSummary;
  return sanitizeRunSummary(parsed);
}

export async function getParallelRunEvents(
  dataRoot: string,
  runId: string,
): Promise<Array<{ at: string; state: string; message: string }>> {
  assertValidRunId(runId);
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  const safeDir = await assertSafeChildPath(runsDirectory, runId);

  if (!(await pathExists(safeDir))) {
    throw new NotFoundError(`Run '${runId}' not found`);
  }

  const eventsFile = path.join(safeDir, "events.jsonl");
  if (!(await pathExists(eventsFile))) {
    return [];
  }

  const raw = await readFile(eventsFile, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: Array<{ at: string; state: string; message: string }> = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore corrupt event lines
    }
  }

  return events;
}

export async function getIntegrationReview(
  dataRoot: string,
  runId: string,
): Promise<ReviewResult> {
  assertValidRunId(runId);
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  const safeDir = await assertSafeChildPath(runsDirectory, runId);

  if (!(await pathExists(safeDir))) {
    throw new NotFoundError(`Run '${runId}' not found`);
  }

  const reviewFile = path.join(safeDir, "integration-review.json");
  if (!(await pathExists(reviewFile))) {
    throw new NotFoundError(`Integration review for run '${runId}' not found`);
  }

  const raw = await readFile(reviewFile, "utf8");
  return JSON.parse(raw) as ReviewResult;
}

export async function getIntegrationChecks(
  dataRoot: string,
  runId: string,
): Promise<SanitizedCheckResult[]> {
  assertValidRunId(runId);
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  const safeDir = await assertSafeChildPath(runsDirectory, runId);

  if (!(await pathExists(safeDir))) {
    throw new NotFoundError(`Run '${runId}' not found`);
  }

  const checksFile = path.join(safeDir, "integration-checks.json");
  if (!(await pathExists(checksFile))) {
    throw new NotFoundError(`Integration checks for run '${runId}' not found`);
  }

  const raw = await readFile(checksFile, "utf8");
  const checks = JSON.parse(raw) as CheckResult[];
  return checks.map(sanitizeCheckResult);
}

export async function getIntegrationDiff(
  dataRoot: string,
  runId: string,
): Promise<BoundedDiffResult> {
  assertValidRunId(runId);
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  const safeDir = await assertSafeChildPath(runsDirectory, runId);

  if (!(await pathExists(safeDir))) {
    throw new NotFoundError(`Run '${runId}' not found`);
  }

  const diffResult = await getBoundedIntegrationDiff(safeDir);
  if (!diffResult) {
    throw new NotFoundError(`Integration diff for run '${runId}' not found`);
  }

  return diffResult;
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

export function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

const RUN_SUBROUTE_REGEX = /^(?:\/api)?\/(?:parallel-runs|runs)\/([^/]+)(?:\/([^/]+))?\/?$/;

export function createHttpHandler(config: HarnessConfig, harnessRoot: string) {
  const dataRoot = path.resolve(harnessRoot, config.dataDirectory);
  const uiRoot = path.resolve(harnessRoot, "ui");

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    try {
      // 1. Health
      if (pathname === "/api/health" || pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // 2. List parallel runs
      if (
        pathname === "/api/parallel-runs" ||
        pathname === "/api/runs" ||
        pathname === "/parallel-runs" ||
        pathname === "/runs"
      ) {
        const runs = await getParallelRuns(dataRoot);
        sendJson(res, 200, runs);
        return;
      }

      // 3. Single run endpoints
      const runMatch = RUN_SUBROUTE_REGEX.exec(pathname);
      if (runMatch) {
        let rawRunId = runMatch[1] ?? "";
        try {
          rawRunId = decodeURIComponent(rawRunId);
        } catch {
          throw new SecurityError("Invalid URL encoding in run id", 400);
        }

        const subroute = runMatch[2];

        if (!subroute || subroute === "status") {
          const summary = await getParallelRunStatus(dataRoot, rawRunId);
          sendJson(res, 200, summary);
          return;
        }

        if (subroute === "events") {
          const events = await getParallelRunEvents(dataRoot, rawRunId);
          sendJson(res, 200, events);
          return;
        }

        if (subroute === "integration-review" || subroute === "review") {
          const review = await getIntegrationReview(dataRoot, rawRunId);
          sendJson(res, 200, review);
          return;
        }

        if (subroute === "integration-checks" || subroute === "checks") {
          const checks = await getIntegrationChecks(dataRoot, rawRunId);
          sendJson(res, 200, checks);
          return;
        }
        if (subroute === "integration-diff" || subroute === "diff") {
          const diffResult = await getIntegrationDiff(dataRoot, rawRunId);
          const rawAccept = req.headers["accept"];
          const accept = Array.isArray(rawAccept) ? rawAccept.join(",") : (rawAccept ?? "");
          if (accept.includes("text/plain") || parsedUrl.searchParams.get("format") === "text") {
            sendText(res, 200, diffResult.diff);
          } else {
            sendJson(res, 200, {
              id: rawRunId,
              diff: diffResult.diff,
              truncated: diffResult.truncated,
            });
          }
          return;
        }

        throw new NotFoundError("Endpoint not found");
      }

      // 4. API 404 catch-all
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        throw new NotFoundError("API endpoint not found");
      }

      // 5. Static files & fallback
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch {
        throw new SecurityError("Invalid URL encoding in path", 400);
      }

      const handled = await serveStatic(uiRoot, decodedPath, res);
      if (!handled) {
        throw new NotFoundError("Not found");
      }
    } catch (error: unknown) {
      const { message, statusCode } = sanitizeErrorMessage(error);
      sendJson(res, statusCode, { error: message });
    }
  };
}
