import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertGitRepository } from "../git.js";
import {
  assertValidOperationId,
  ConflictError,
  isValidOperationId,
  NotFoundError,
  SecurityError,
} from "./security.js";

export { assertValidOperationId, isValidOperationId };

export type OperationStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type OperationAction = "start" | "retry" | "replan";

export interface OperationLineage {
  parentId?: string | undefined;
  rootId?: string | undefined;
  action?: OperationAction | undefined;
  feedback?: string | undefined;
}

export interface OperationRecord {
  id: string;
  status: OperationStatus;
  type: "parallel_run";
  repositoryPath: string;
  requirement: string;
  startedAt: string;
  completedAt?: string | undefined;
  runId?: string | undefined;
  message?: string | undefined;
  exitCode?: number | null | undefined;
  cancellable?: boolean | undefined;

  // Phase 4D Lineage metadata
  parentId?: string | undefined;
  rootId?: string | undefined;
  action?: OperationAction | undefined;
  feedback?: string | undefined;
  childOperationIds?: string[] | undefined;
}

export interface SanitizedOperation {
  id: string;
  status: OperationStatus;
  type: "parallel_run";
  repositoryPath: string;
  requirement: string;
  startedAt: string;
  completedAt?: string | undefined;
  runId?: string | undefined;
  message?: string | undefined;
  exitCode?: number | null | undefined;
  cancellable: boolean;

  // Phase 4D Lineage metadata
  parentId?: string | undefined;
  rootId?: string | undefined;
  action?: OperationAction | undefined;
  feedback?: string | undefined;
  childOperationIds: string[];
  lineage?: OperationLineage | undefined;
}

export function sanitizeMessage(rawMessage: string, allowedRepoPath: string): string {
  if (!rawMessage || typeof rawMessage !== "string") return "";

  let msg = rawMessage;

  // 1. Redact secrets: preserve key name, redact secret value
  msg = msg
    .replace(/bearer\s+[A-Za-z0-9_\-\.]+/gi, "bearer [REDACTED]")
    .replace(/sk-[a-zA-Z0-9_\-]{16,}/g, "[REDACTED_API_KEY]")
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/github_pat_[a-zA-Z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/xox[baprs]-[a-zA-Z0-9\-]+/g, "[REDACTED_TOKEN]")
    .replace(/(key|secret|password|token)([:=]\s*["']?)[A-Za-z0-9_\-\.]{8,}(["']?)/gi, "$1$2[REDACTED]$3");

  // 2. Redact arbitrary filesystem paths beyond the submitted repository path
  const normalizedRepo = path.resolve(allowedRepoPath).toLowerCase();

  // Windows absolute paths with backslashes
  msg = msg.replace(/[A-Za-z]:\\[^ \r\n\t"',;()<>]*/g, (match) => {
    try {
      const norm = path.resolve(match).toLowerCase();
      if (norm === normalizedRepo || norm.startsWith(normalizedRepo + path.sep.toLowerCase())) {
        return match;
      }
    } catch {
      // If resolution fails, redact
    }
    return "[REDACTED_PATH]";
  });

  // Windows absolute paths with forward slashes
  msg = msg.replace(/[A-Za-z]:\/[^ \r\n\t"',;()<>]*/g, (match) => {
    try {
      const norm = path.resolve(match).toLowerCase();
      if (norm === normalizedRepo || norm.startsWith(normalizedRepo + path.sep.toLowerCase())) {
        return match;
      }
    } catch {
      // If resolution fails, redact
    }
    return "[REDACTED_PATH]";
  });

  // Unix paths
  msg = msg.replace(/\/(?:Users|home|tmp|var|etc|usr|private|Volumes|app)[^ \r\n\t"',;()<>]*/g, (match) => {
    try {
      const norm = path.resolve(match).toLowerCase();
      if (norm === normalizedRepo || norm.startsWith(normalizedRepo + path.sep.toLowerCase())) {
        return match;
      }
    } catch {
      // If resolution fails, redact
    }
    return "[REDACTED_PATH]";
  });

  // 3. Truncate long messages to prevent buffer bloat
  if (msg.length > 500) {
    msg = msg.slice(0, 497) + "...";
  }

  return msg;
}

export function composeReplanRequirement(baseRequirement: string, feedback: string): string {
  if (typeof feedback !== "string" || !feedback.trim()) {
    throw new SecurityError("feedback must be a non-empty string", 400);
  }
  const trimmedFeedback = feedback.trim();
  if (trimmedFeedback.length > 20_000) {
    throw new SecurityError("feedback exceeds maximum allowed length of 20000 characters", 400);
  }
  const trimmedBase = (baseRequirement ?? "").trim();
  const composed = `${trimmedBase}\n\nReplan Feedback:\n${trimmedFeedback}`;
  if (composed.length > 20_000) {
    throw new SecurityError("Combined requirement exceeds maximum allowed length of 20000 characters", 400);
  }
  return composed;
}

export interface OperationManagerOptions {
  harnessRoot: string;
  dataDirectory?: string | undefined;
  cliScriptPath?: string | undefined;
}

export class OperationManager {
  private readonly harnessRoot: string;
  private readonly operationsDir: string;
  private readonly dataRoot: string;
  private readonly cliScriptPath: string;
  private readonly liveProcesses = new Map<string, ChildProcess>();
  private readonly cancelledOperations = new Set<string>();
  private readonly terminalOperations = new Map<string, OperationRecord>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly activeActionLocks = new Set<string>();

  constructor(options: OperationManagerOptions) {
    this.harnessRoot = path.resolve(options.harnessRoot);
    const dataDirName = options.dataDirectory ?? ".harness";
    this.dataRoot = path.resolve(this.harnessRoot, dataDirName);
    this.operationsDir = path.resolve(this.dataRoot, "ui", "operations");

    if (options.cliScriptPath) {
      this.cliScriptPath = path.resolve(options.cliScriptPath);
    } else {
      const distCli = path.join(this.harnessRoot, "dist", "cli.js");
      const srcCli = path.join(this.harnessRoot, "src", "cli.ts");
      this.cliScriptPath = existsSync(distCli) ? distCli : srcCli;
    }
  }

  get directory(): string {
    return this.operationsDir;
  }

  isLive(id: string): boolean {
    return this.liveProcesses.has(id);
  }

  private operationFilePath(id: string): string {
    assertValidOperationId(id);
    return path.join(this.operationsDir, `${id}.json`);
  }

  async persistOperation(op: OperationRecord): Promise<void> {
    // If operation is already terminal, never downgrade to RUNNING
    const terminal = this.terminalOperations.get(op.id);
    if (terminal) {
      op.status = terminal.status;
      op.completedAt = terminal.completedAt;
      op.exitCode = terminal.exitCode;
      op.cancellable = false;
      if (!op.message) op.message = terminal.message;
      if (!op.runId) op.runId = terminal.runId;
      if (op.childOperationIds) terminal.childOperationIds = op.childOperationIds;
      if (op.parentId) terminal.parentId = op.parentId;
      if (op.rootId) terminal.rootId = op.rootId;
      if (op.action) terminal.action = op.action;
      if (op.feedback) terminal.feedback = op.feedback;
    } else if (op.status === "COMPLETED" || op.status === "FAILED" || op.status === "CANCELLED") {
      this.terminalOperations.set(op.id, { ...op });
    }

    // Serialize file writes per operation ID to eliminate concurrent race conditions
    const prev = this.writeQueues.get(op.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.doAtomicPersist(op);
      });
    this.writeQueues.set(op.id, next);
    return next;
  }

  async addChildOperation(parentId: string, childId: string): Promise<void> {
    assertValidOperationId(parentId);
    assertValidOperationId(childId);

    const prev = this.writeQueues.get(parentId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const parent = await this.getOperationRaw(parentId);
        if (!parent) return;

        const existingChildren = new Set(parent.childOperationIds ?? []);
        existingChildren.add(childId);
        parent.childOperationIds = Array.from(existingChildren);

        const terminal = this.terminalOperations.get(parentId);
        if (terminal) {
          parent.status = terminal.status;
          parent.completedAt = terminal.completedAt;
          parent.exitCode = terminal.exitCode;
          parent.cancellable = false;
          terminal.childOperationIds = parent.childOperationIds;
        }

        await this.doAtomicPersist(parent);
      });

    this.writeQueues.set(parentId, next);
    await next;
  }

  private async doAtomicPersist(op: OperationRecord): Promise<void> {
    await mkdir(this.operationsDir, { recursive: true });
    const targetFile = this.operationFilePath(op.id);
    const tempFile = path.join(this.operationsDir, `.${op.id}.${randomUUID().slice(0, 8)}.tmp`);
    const content = JSON.stringify(op, null, 2);
    await writeFile(tempFile, content, "utf8");
    await rename(tempFile, targetFile);
  }

  async waitForOperationsToSettle(timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (this.liveProcesses.size > 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${this.liveProcesses.size} live operation(s) to settle`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all(Array.from(this.writeQueues.values()));
  }

  sanitize(op: OperationRecord): SanitizedOperation {
    const isLive = this.liveProcesses.has(op.id);
    const isCancellable = op.status === "RUNNING" && isLive;
    const childOperationIds = Array.isArray(op.childOperationIds) ? [...op.childOperationIds] : [];
    const rootId = op.rootId ?? op.parentId ?? op.id;
    const action = op.action ?? "start";

    const lineage: OperationLineage = {
      parentId: op.parentId,
      rootId,
      action,
      feedback: op.feedback,
    };

    return {
      id: op.id,
      status: op.status,
      type: op.type,
      repositoryPath: op.repositoryPath,
      requirement: op.requirement,
      startedAt: op.startedAt,
      completedAt: op.completedAt,
      runId: op.runId,
      message: op.message ? sanitizeMessage(op.message, op.repositoryPath) : undefined,
      exitCode: op.exitCode,
      cancellable: isCancellable,
      parentId: op.parentId,
      rootId,
      action,
      feedback: op.feedback,
      childOperationIds,
      lineage,
    };
  }

  async getOperationRaw(id: string): Promise<OperationRecord | null> {
    assertValidOperationId(id);
    const filePath = this.operationFilePath(id);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as OperationRecord;
    } catch {
      return null;
    }
  }

  async getOperation(id: string): Promise<SanitizedOperation> {
    const op = await this.getOperationRaw(id);
    if (!op) {
      throw new NotFoundError(`Operation '${id}' not found`);
    }
    return this.sanitize(op);
  }

  async getOperations(): Promise<SanitizedOperation[]> {
    try {
      await mkdir(this.operationsDir, { recursive: true });
      const entries = await readdir(this.operationsDir, { withFileTypes: true });
      const records: OperationRecord[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
        const opId = entry.name.slice(0, -5);
        if (!isValidOperationId(opId)) continue;
        try {
          const raw = await readFile(path.join(this.operationsDir, entry.name), "utf8");
          const parsed = JSON.parse(raw) as OperationRecord;
          records.push(parsed);
        } catch {
          // Skip corrupt files
        }
      }

      // Sort newest first by startedAt or id
      records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return records.map((r) => this.sanitize(r));
    } catch {
      return [];
    }
  }

  async validateRunRequest(repositoryPath: unknown, requirement: unknown): Promise<{
    resolvedRepo: string;
    boundedRequirement: string;
  }> {
    if (typeof repositoryPath !== "string" || !repositoryPath.trim()) {
      throw new SecurityError("repositoryPath must be a non-empty string", 400);
    }
    const trimmedRepo = repositoryPath.trim();
    if (!path.isAbsolute(trimmedRepo)) {
      throw new SecurityError("repositoryPath must be an absolute path", 400);
    }

    const resolvedRepo = path.resolve(trimmedRepo);
    try {
      const st = await stat(resolvedRepo);
      if (!st.isDirectory()) {
        throw new SecurityError("repositoryPath must be a directory", 400);
      }
    } catch (err) {
      if (err instanceof SecurityError) throw err;
      throw new SecurityError("repositoryPath does not exist", 400);
    }

    try {
      await assertGitRepository(resolvedRepo);
    } catch {
      throw new SecurityError("repositoryPath must be a Git repository", 400);
    }

    if (typeof requirement !== "string" || !requirement.trim()) {
      throw new SecurityError("requirement must be a non-empty string", 400);
    }
    const trimmedReq = requirement.trim();
    if (trimmedReq.length > 20_000) {
      throw new SecurityError("requirement exceeds maximum allowed length of 20000 characters", 400);
    }

    return { resolvedRepo, boundedRequirement: trimmedReq };
  }

  async startRun(repositoryPath: string, requirement: string): Promise<SanitizedOperation> {
    const { resolvedRepo, boundedRequirement } = await this.validateRunRequest(repositoryPath, requirement);

    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const id = `op-${timestamp}-${randomUUID().slice(0, 8)}`;

    const operation: OperationRecord = {
      id,
      status: "RUNNING",
      type: "parallel_run",
      repositoryPath: resolvedRepo,
      requirement: boundedRequirement,
      startedAt: new Date().toISOString(),
      cancellable: true,
      message: "Starting parallel harness run...",
      action: "start",
      rootId: id,
      childOperationIds: [],
    };

    await this.persistOperation(operation);
    this.spawnOperationProcess(operation, resolvedRepo, boundedRequirement);
    return this.sanitize(operation);
  }

  async retryOperation(sourceOperationId: string): Promise<SanitizedOperation> {
    assertValidOperationId(sourceOperationId);

    const actionKey = `${sourceOperationId}:retry`;
    if (this.activeActionLocks.has(actionKey)) {
      throw new ConflictError(
        `Cannot retry operation '${sourceOperationId}': a retry operation is already in progress`,
      );
    }

    this.activeActionLocks.add(actionKey);

    try {
      const parent = await this.getOperationRaw(sourceOperationId);
      if (!parent) {
        throw new NotFoundError(`Operation '${sourceOperationId}' not found`);
      }

      if (parent.status !== "COMPLETED" && parent.status !== "FAILED") {
        throw new ConflictError(
          `Cannot retry operation '${sourceOperationId}' with status '${parent.status}': only COMPLETED or FAILED operations can be retried`,
        );
      }

      // Durable child-state check: verify no child from this parent is currently RUNNING with action retry
      if (parent.childOperationIds && parent.childOperationIds.length > 0) {
        for (const childId of parent.childOperationIds) {
          const terminalChild = this.terminalOperations.get(childId);
          if (terminalChild) {
            if (terminalChild.action === "retry" && terminalChild.status === "RUNNING") {
              throw new ConflictError(
                `Cannot retry operation '${sourceOperationId}': active retry child '${childId}' is currently running`,
              );
            }
          } else {
            const childOp = await this.getOperationRaw(childId);
            if (childOp && childOp.action === "retry" && childOp.status === "RUNNING") {
              throw new ConflictError(
                `Cannot retry operation '${sourceOperationId}': active retry child '${childId}' is currently running`,
              );
            }
          }
        }
      }

      const { resolvedRepo, boundedRequirement } = await this.validateRunRequest(
        parent.repositoryPath,
        parent.requirement,
      );

      const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      const id = `op-${timestamp}-${randomUUID().slice(0, 8)}`;
      const rootId = parent.rootId ?? parent.id;

      const operation: OperationRecord = {
        id,
        status: "RUNNING",
        type: "parallel_run",
        repositoryPath: resolvedRepo,
        requirement: boundedRequirement,
        startedAt: new Date().toISOString(),
        cancellable: true,
        message: "Starting parallel harness run (retry)...",
        action: "retry",
        parentId: sourceOperationId,
        rootId,
        childOperationIds: [],
      };

      await this.persistOperation(operation);
      await this.addChildOperation(sourceOperationId, id);
      this.spawnOperationProcess(operation, resolvedRepo, boundedRequirement, () => {
        this.activeActionLocks.delete(actionKey);
      });
      return this.sanitize(operation);
    } catch (err) {
      this.activeActionLocks.delete(actionKey);
      throw err;
    }
  }

  async replanOperation(sourceOperationId: string, feedback: string): Promise<SanitizedOperation> {
    assertValidOperationId(sourceOperationId);

    const actionKey = `${sourceOperationId}:replan`;
    if (this.activeActionLocks.has(actionKey)) {
      throw new ConflictError(
        `Cannot replan operation '${sourceOperationId}': a replan operation is already in progress`,
      );
    }

    this.activeActionLocks.add(actionKey);

    try {
      const parent = await this.getOperationRaw(sourceOperationId);
      if (!parent) {
        throw new NotFoundError(`Operation '${sourceOperationId}' not found`);
      }

      if (parent.status !== "COMPLETED" && parent.status !== "FAILED") {
        throw new ConflictError(
          `Cannot replan operation '${sourceOperationId}' with status '${parent.status}': only COMPLETED or FAILED operations can be replanned`,
        );
      }

      // Durable child-state check: verify no child from this parent is currently RUNNING with action replan
      if (parent.childOperationIds && parent.childOperationIds.length > 0) {
        for (const childId of parent.childOperationIds) {
          const terminalChild = this.terminalOperations.get(childId);
          if (terminalChild) {
            if (terminalChild.action === "replan" && terminalChild.status === "RUNNING") {
              throw new ConflictError(
                `Cannot replan operation '${sourceOperationId}': active replan child '${childId}' is currently running`,
              );
            }
          } else {
            const childOp = await this.getOperationRaw(childId);
            if (childOp && childOp.action === "replan" && childOp.status === "RUNNING") {
              throw new ConflictError(
                `Cannot replan operation '${sourceOperationId}': active replan child '${childId}' is currently running`,
              );
            }
          }
        }
      }

      const composedRequirement = composeReplanRequirement(parent.requirement, feedback);
      const { resolvedRepo, boundedRequirement } = await this.validateRunRequest(
        parent.repositoryPath,
        composedRequirement,
      );

      const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      const id = `op-${timestamp}-${randomUUID().slice(0, 8)}`;
      const rootId = parent.rootId ?? parent.id;

      const operation: OperationRecord = {
        id,
        status: "RUNNING",
        type: "parallel_run",
        repositoryPath: resolvedRepo,
        requirement: boundedRequirement,
        startedAt: new Date().toISOString(),
        cancellable: true,
        message: "Starting parallel harness run (replan)...",
        action: "replan",
        parentId: sourceOperationId,
        rootId,
        feedback: feedback.trim(),
        childOperationIds: [],
      };

      await this.persistOperation(operation);
      await this.addChildOperation(sourceOperationId, id);
      this.spawnOperationProcess(operation, resolvedRepo, boundedRequirement, () => {
        this.activeActionLocks.delete(actionKey);
      });
      return this.sanitize(operation);
    } catch (err) {
      this.activeActionLocks.delete(actionKey);
      throw err;
    }
  }

  private spawnOperationProcess(
    operation: OperationRecord,
    resolvedRepo: string,
    boundedRequirement: string,
    onComplete?: () => void,
  ): void {
    const id = operation.id;
    const args = [this.cliScriptPath, "parallel", "--repo", resolvedRepo, "--requirement", boundedRequirement];

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: this.harnessRoot,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      onComplete?.();
      operation.status = "FAILED";
      operation.completedAt = new Date().toISOString();
      operation.message = this.sanitizeErrorMessage(error, resolvedRepo);
      operation.cancellable = false;
      this.terminalOperations.set(id, { ...operation });
      void this.persistOperation(operation);
      return;
    }

    this.liveProcesses.set(id, child);

    let stdoutBuffer = "";
    let stderrBuffer = "";

    const checkDiscoveredRunId = (chunk: string) => {
      if (this.cancelledOperations.has(id)) return;
      if (!operation.runId) {
        const match = /(?:parallel-\d{14}-[a-zA-Z0-9_-]+)/.exec(chunk) ||
          /(?:parallel-[a-zA-Z0-9_-]+)/.exec(chunk);
        if (match?.[0]) {
          operation.runId = match[0];
          void this.persistOperation(operation);
        }
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.cancelledOperations.has(id)) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 50_000) {
        stdoutBuffer = stdoutBuffer.slice(-25_000);
      }
      checkDiscoveredRunId(chunk);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (this.cancelledOperations.has(id)) return;
      stderrBuffer += chunk;
      if (stderrBuffer.length > 50_000) {
        stderrBuffer = stderrBuffer.slice(-25_000);
      }
    });

    child.once("error", (err) => {
      onComplete?.();
      this.liveProcesses.delete(id);
      if (this.cancelledOperations.has(id) || operation.status === "CANCELLED") return;

      operation.status = "FAILED";
      operation.completedAt = new Date().toISOString();
      operation.cancellable = false;
      operation.message = sanitizeMessage(`Failed to start child process: ${err.message}`, resolvedRepo);
      this.terminalOperations.set(id, { ...operation });
      void this.persistOperation(operation);
    });

    child.once("close", (exitCode, signal) => {
      onComplete?.();
      this.liveProcesses.delete(id);
      if (this.cancelledOperations.has(id) || operation.status === "CANCELLED") return;

      operation.completedAt = new Date().toISOString();
      operation.exitCode = exitCode;
      operation.cancellable = false;

      // Check stdout buffer one last time for run id
      checkDiscoveredRunId(stdoutBuffer);

      if (exitCode === 0) {
        operation.status = "COMPLETED";
        operation.message = "Parallel run completed successfully";
      } else {
        operation.status = "FAILED";
        const combined = (stderrBuffer || stdoutBuffer).trim();
        const lastLine = combined ? combined.split(/\r?\n/).filter(Boolean).pop() ?? "" : "";
        const detail = lastLine ? `: ${lastLine}` : ` with exit code ${exitCode ?? signal ?? 1}`;
        operation.message = sanitizeMessage(`Parallel run failed${detail}`, resolvedRepo);
      }

      this.terminalOperations.set(id, { ...operation });
      void this.persistOperation(operation);
    });
  }

  async cancelOperation(id: string): Promise<SanitizedOperation> {
    assertValidOperationId(id);
    const op = await this.getOperationRaw(id);
    if (!op) {
      throw new NotFoundError(`Operation '${id}' not found`);
    }

    // Idempotent: if already completed, failed, or cancelled, return existing state
    if (op.status === "CANCELLED" || op.status === "COMPLETED" || op.status === "FAILED") {
      return this.sanitize(op);
    }

    // A persisted RUNNING operation not owned by this manager must return 409 Conflict
    const child = this.liveProcesses.get(id);
    if (!child) {
      throw new ConflictError("Cannot cancel operation: process is not tracked by this server instance");
    }

    // Mark cancellation intent and state before killing the process
    this.cancelledOperations.add(id);
    this.liveProcesses.delete(id);

    op.status = "CANCELLED";
    op.completedAt = new Date().toISOString();
    op.message = "Operation cancelled by user";
    op.cancellable = false;
    this.terminalOperations.set(op.id, { ...op });

    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill errors
    }

    if (op.parentId && op.action) {
      this.activeActionLocks.delete(`${op.parentId}:${op.action}`);
    }

    await this.persistOperation(op);
    return this.sanitize(op);
  }

  private sanitizeErrorMessage(error: unknown, repoPath: string): string {
    const raw = error instanceof Error ? error.message : String(error);
    return sanitizeMessage(raw, repoPath);
  }
}
