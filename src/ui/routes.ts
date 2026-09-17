import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import type { ParallelRunSummary, ParallelShardResult } from "../parallel-types.js";
import type { CheckResult, ReviewResult } from "../types.js";
import { getBoundedIntegrationDiff, type BoundedDiffResult } from "./diff.js";
import { assertGitRepository } from "../git.js";
import {
  assertSafeChildPath,
  assertValidOperationId,
  assertValidRunId,
  ConflictError,
  NotFoundError,
  sanitizeErrorMessage,
  SecurityError,
  UnsupportedMediaTypeError,
} from "./security.js";
import { OperationManager, type SanitizedOperation } from "./operations.js";
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

export function formatSafeCommand(argv: string[], platform: string = process.platform): string {
  if (!argv || argv.length === 0) return "";

  return argv
    .map((arg) => {
      if (arg === "") return "''";
      // If arg contains only safe characters: letters, numbers, dash, underscore, dot, slash, colon, equals
      if (/^[a-zA-Z0-9_\-./:=]+$/.test(arg)) {
        return arg;
      }
      if (platform === "win32") {
        // PowerShell single-quoted literal: escape embedded apostrophes by doubling them
        const escaped = arg.replace(/'/g, "''");
        return `'${escaped}'`;
      } else {
        // POSIX single-quote escaping: end single quote, literal escaped single quote, resume single quote
        const escaped = arg.replace(/'/g, "'\\''");
        return `'${escaped}'`;
      }
    })
    .join(" ");
}

export interface PrepareCherryPickResult {
  runId: string;
  sha: string;
  integrationCommitSha: string;
  repositoryPath: string;
  argv: string[];
  command: string;
}

export async function prepareCherryPick(
  dataRoot: string,
  runId: string,
  platform: string = process.platform,
): Promise<PrepareCherryPickResult> {
  assertValidRunId(runId);
  const runsDirectory = path.join(dataRoot, "parallel-runs");
  const safeDir = await assertSafeChildPath(runsDirectory, runId);
  const statusFile = path.join(safeDir, "status.json");

  if (!(await pathExists(statusFile))) {
    throw new NotFoundError(`Run '${runId}' not found`);
  }

  const raw = await readFile(statusFile, "utf8");
  let summary: ParallelRunSummary;
  try {
    summary = JSON.parse(raw) as ParallelRunSummary;
  } catch {
    throw new SecurityError(`Invalid status artifact for run '${runId}'`, 400);
  }

  if (summary.state !== "DONE") {
    throw new ConflictError(
      `Cannot prepare cherry-pick: run '${runId}' is in state '${summary.state || "UNKNOWN"}', requires state DONE`,
    );
  }

  const sha = summary.integrationCommitSha;
  if (!sha || typeof sha !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(sha.trim())) {
    throw new ConflictError(
      `Cannot prepare cherry-pick: run '${runId}' does not have a valid integration commit SHA`,
    );
  }

  const repoPath = summary.repositoryPath;
  if (!repoPath || typeof repoPath !== "string" || !path.isAbsolute(repoPath.trim())) {
    throw new ConflictError(
      `Cannot prepare cherry-pick: repositoryPath must be a valid absolute path`,
    );
  }

  const cleanRepo = path.resolve(repoPath.trim());
  try {
    const st = await stat(cleanRepo);
    if (!st.isDirectory()) {
      throw new ConflictError(
        `Cannot prepare cherry-pick: repositoryPath is not a directory`,
      );
    }
    await assertGitRepository(cleanRepo);
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    throw new ConflictError(
      `Cannot prepare cherry-pick: repositoryPath is not an existing Git repository`,
    );
  }

  const cleanSha = sha.trim();
  const argv = ["git", "-C", cleanRepo, "cherry-pick", cleanSha];
  const command = formatSafeCommand(argv, platform);

  return {
    runId,
    sha: cleanSha,
    integrationCommitSha: cleanSha,
    repositoryPath: cleanRepo,
    argv,
    command,
  };
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
const OPERATION_CANCEL_REGEX = /^(?:\/api)?\/operations\/([^/]+)\/cancel\/?$/;
const OPERATION_RETRY_REGEX = /^(?:\/api)?\/operations\/([^/]+)\/retry\/?$/;
const OPERATION_REPLAN_REGEX = /^(?:\/api)?\/operations\/([^/]+)\/replan\/?$/;
const OPERATION_ITEM_REGEX = /^(?:\/api)?\/operations\/([^/]+)\/?$/;
const CHERRY_PICK_POST_REGEX = /^(?:\/api)?\/(?:parallel-runs|runs)\/([^/]+)\/(?:prepare-cherry-pick|cherry-pick)\/?$/;

export async function readBoundedJson(
  req: IncomingMessage,
  maxSizeBytes = 64 * 1024,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rawContentLength = req.headers["content-length"];
    if (rawContentLength !== undefined) {
      const contentLength = parseInt(rawContentLength, 10);
      if (!Number.isNaN(contentLength) && contentLength > maxSizeBytes) {
        req.resume();
        return reject(new SecurityError("Payload too large", 413));
      }
    }

    let body = "";
    let receivedBytes = 0;
    let settled = false;

    req.setEncoding("utf8");

    req.on("data", (chunk: string) => {
      if (settled) return;
      receivedBytes += Buffer.byteLength(chunk, "utf8");
      if (receivedBytes > maxSizeBytes) {
        settled = true;
        req.pause();
        return reject(new SecurityError("Payload too large", 413));
      }
      body += chunk;
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) {
        return reject(new SecurityError("Request body is empty", 400));
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch {
        reject(new SecurityError("Malformed JSON payload", 400));
      }
    });

    req.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new SecurityError("Failed to read request body", 400));
    });
  });
}

export interface HttpHandlerOptions {
  operationManager?: OperationManager | undefined;
}

export function createHttpHandler(
  config: HarnessConfig,
  harnessRoot: string,
  options?: HttpHandlerOptions,
) {
  const dataRoot = path.resolve(harnessRoot, config.dataDirectory);
  const uiRoot = path.resolve(harnessRoot, "ui");
  const operationManager = options?.operationManager ?? new OperationManager({
    harnessRoot,
    dataDirectory: config.dataDirectory,
  });

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase();
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    try {
      if (method === "POST") {
        if (pathname === "/api/runs" || pathname === "/runs") {
          const contentType = req.headers["content-type"];
          const mediaType = contentType ? contentType.split(";")[0]?.trim().toLowerCase() : "";
          if (mediaType !== "application/json") {
            throw new UnsupportedMediaTypeError("Content-Type must be application/json");
          }

          const rawBody = await readBoundedJson(req, 64 * 1024);
          if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
            throw new SecurityError("Invalid JSON body: expected an object", 400);
          }
          const body = rawBody as Record<string, unknown>;
          const op = await operationManager.startRun(
            body["repositoryPath"] as string,
            body["requirement"] as string,
          );
          sendJson(res, 201, op);
          return;
        }

        const cancelMatch = OPERATION_CANCEL_REGEX.exec(pathname);
        if (cancelMatch) {
          let rawId = cancelMatch[1] ?? "";
          try {
            rawId = decodeURIComponent(rawId);
          } catch {
            throw new SecurityError("Invalid URL encoding in operation id", 400);
          }
          assertValidOperationId(rawId);
          const op = await operationManager.cancelOperation(rawId);
          sendJson(res, 200, op);
          return;
        }

        const retryMatch = OPERATION_RETRY_REGEX.exec(pathname);
        if (retryMatch) {
          let rawId = retryMatch[1] ?? "";
          try {
            rawId = decodeURIComponent(rawId);
          } catch {
            throw new SecurityError("Invalid URL encoding in operation id", 400);
          }
          assertValidOperationId(rawId);

          const contentType = req.headers["content-type"];
          if (contentType) {
            const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
            if (mediaType !== "application/json") {
              throw new UnsupportedMediaTypeError("Content-Type must be application/json");
            }
            const contentLength = req.headers["content-length"];
            if (contentLength && contentLength !== "0") {
              await readBoundedJson(req, 64 * 1024);
            }
          }

          const op = await operationManager.retryOperation(rawId);
          sendJson(res, 201, op);
          return;
        }

        const replanMatch = OPERATION_REPLAN_REGEX.exec(pathname);
        if (replanMatch) {
          let rawId = replanMatch[1] ?? "";
          try {
            rawId = decodeURIComponent(rawId);
          } catch {
            throw new SecurityError("Invalid URL encoding in operation id", 400);
          }
          assertValidOperationId(rawId);

          const contentType = req.headers["content-type"];
          const mediaType = contentType ? contentType.split(";")[0]?.trim().toLowerCase() : "";
          if (mediaType !== "application/json") {
            throw new UnsupportedMediaTypeError("Content-Type must be application/json");
          }

          const rawBody = await readBoundedJson(req, 64 * 1024);
          if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
            throw new SecurityError("Invalid JSON body: expected an object", 400);
          }
          const body = rawBody as Record<string, unknown>;
          const feedback = (body["feedback"] ?? body["humanFeedback"]) as unknown;
          if (typeof feedback !== "string" || !feedback.trim()) {
            throw new SecurityError("feedback must be a non-empty string", 400);
          }

          const op = await operationManager.replanOperation(rawId, feedback);
          sendJson(res, 201, op);
          return;
        }

        const cherryMatch = CHERRY_PICK_POST_REGEX.exec(pathname);
        if (cherryMatch) {
          let rawRunId = cherryMatch[1] ?? "";
          try {
            rawRunId = decodeURIComponent(rawRunId);
          } catch {
            throw new SecurityError("Invalid URL encoding in run id", 400);
          }
          assertValidRunId(rawRunId);

          const contentType = req.headers["content-type"];
          if (contentType) {
            const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
            if (mediaType !== "application/json") {
              throw new UnsupportedMediaTypeError("Content-Type must be application/json");
            }
            const contentLength = req.headers["content-length"];
            if (contentLength && contentLength !== "0") {
              await readBoundedJson(req, 64 * 1024);
            }
          }

          const result = await prepareCherryPick(dataRoot, rawRunId);
          sendJson(res, 200, result);
          return;
        }

        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      // 1. Health
      if (pathname === "/api/health" || pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // 2. Operations endpoints
      if (pathname === "/api/operations" || pathname === "/operations") {
        const ops = await operationManager.getOperations();
        sendJson(res, 200, ops);
        return;
      }

      const opMatch = OPERATION_ITEM_REGEX.exec(pathname);
      if (opMatch) {
        let rawId = opMatch[1] ?? "";
        try {
          rawId = decodeURIComponent(rawId);
        } catch {
          throw new SecurityError("Invalid URL encoding in operation id", 400);
        }
        assertValidOperationId(rawId);
        const op = await operationManager.getOperation(rawId);
        sendJson(res, 200, op);
        return;
      }

      // 3. List parallel runs
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

        if (subroute === "prepare-cherry-pick" || subroute === "cherry-pick") {
          const result = await prepareCherryPick(dataRoot, rawRunId);
          sendJson(res, 200, result);
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
