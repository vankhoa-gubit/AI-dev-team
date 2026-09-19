import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Worker } from "./adapters/antigravity.js";
import type { HarnessConfig } from "./config.js";
import {
  assertCleanRepository,
  assertGitRepository,
  commitAll,
  createWorktree,
  findOutOfScopeFiles,
  getHeadSha,
  getWorktreeDiff,
  listChangedFiles,
} from "./git.js";
import { boundText, formatCommand } from "./output.js";
import { findOverlappingScope } from "./scope.js";
import {
  ClientRequestIdSchema,
  TaskSpecSchema,
  ValidationCommandSchema,
  WorkerResultSchema,
  type CheckResult,
  type TaskSpec,
  type WorkerResult,
} from "./types.js";
import { formatCheckFailures, runValidationChecks } from "./validation.js";

export const DelegationRequestSchema = z.object({
  repository_path: z.string().min(1),
  objective: z.string().min(1),
  allowed_paths: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  checks: z.array(ValidationCommandSchema).default([]),
  worker_instructions: z.string().min(1).optional(),
  client_request_id: ClientRequestIdSchema.optional(),
}).strict();

export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

export const DelegationStateSchema = z.enum([
  "PREPARING",
  "WORKER_RUNNING",
  "CHECKING",
  "INTERRUPTED",
  "WAITING_FOR_REVISION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export type DelegationState = z.infer<typeof DelegationStateSchema>;

const AttemptTriggerSchema = z.enum(["initial", "revision", "resume"]);
const AttemptOutcomeSchema = z.enum([
  "running",
  "completed",
  "waiting_for_revision",
  "failed",
  "cancelled",
  "interrupted",
]);
const FailureCategorySchema = z.enum([
  "provider_error",
  "empty_output",
  "denied_action",
  "timeout",
  "scope_violation",
  "validation_failure",
]);

const WorkerAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  trigger: AttemptTriggerSchema,
  started_at: z.string(),
  finished_at: z.string().optional(),
  duration_ms: z.number().int().min(0).optional(),
  provider_duration_ms: z.number().int().min(0).optional(),
  validation_duration_ms: z.number().int().min(0).optional(),
  outcome: AttemptOutcomeSchema,
  conversation_reused: z.boolean(),
  validation_passed: z.boolean().optional(),
  failure_category: FailureCategorySchema.optional(),
}).strict();

export type AttemptTrigger = z.infer<typeof AttemptTriggerSchema>;
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;
export type FailureCategory = z.infer<typeof FailureCategorySchema>;
export type WorkerAttempt = z.infer<typeof WorkerAttemptSchema>;

const CheckEvidenceSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  passed: z.boolean(),
  exit_code: z.number().nullable(),
  duration_ms: z.number(),
  timed_out: z.boolean(),
  stdout_tail: z.string(),
  stderr_tail: z.string(),
}).strict();

export const DelegationSnapshotSchema = z.object({
  id: z.string().min(1),
  state: DelegationStateSchema,
  objective: z.string(),
  repository_path: z.string(),
  worktree_path: z.string(),
  branch: z.string(),
  base_sha: z.string().min(1).optional(),
  revision_round: z.number().int().min(0),
  max_revision_rounds: z.number().int().min(0),
  worker_attempts: z.number().int().min(0).default(0),
  codex_process_invocations: z.literal(0).default(0),
  message: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string(),
  changed_files: z.array(z.string()).default([]),
  checks: z.array(CheckEvidenceSchema).default([]),
  worker_result: WorkerResultSchema.optional(),
  revision_feedback: z.string().optional(),
  commit_sha: z.string().min(1).optional(),
  client_request_id: ClientRequestIdSchema.optional(),
  attempt_history: z.array(WorkerAttemptSchema).default([]),
}).strict();

export type DelegationSnapshot = z.infer<typeof DelegationSnapshotSchema>;

export interface DelegationDiff {
  worker_id: string;
  base_sha: string;
  changed_files: string[];
  diff: string;
  truncated: boolean;
}

export interface CherryPickHandoff {
  worker_id: string;
  repository_path: string;
  branch: string;
  commit_sha: string;
  argv: string[];
  command: string;
}

export interface WaitWorkerResult {
  timed_out: boolean;
  snapshot: DelegationSnapshot;
}

export type DelegationStartResult = DelegationSnapshot & {
  delegation_outcome: "created" | "reused";
};

export interface WorkerMetrics {
  worker_id: string;
  state: DelegationState;
  worker_attempts: number;
  revision_rounds: number;
  initial_attempts: number;
  revision_attempts: number;
  resume_attempts: number;
  completed_attempts: number;
  failed_attempts: number;
  conversation_reuse_count: number;
  total_duration_ms: number;
  total_provider_duration_ms: number;
  total_validation_duration_ms: number;
  last_failure_category?: FailureCategory;
  attempts: WorkerAttempt[];
}

interface ActiveDelegation {
  task: TaskSpec;
  jobDirectory: string;
  snapshot: DelegationSnapshot;
  controller?: AbortController;
  runPromise?: Promise<void>;
  cancelRequested: boolean;
}

export interface InteractiveDelegationApi {
  list(repositoryPath?: string): Promise<DelegationSnapshot[]>;
  delegate(request: DelegationRequest): Promise<DelegationStartResult>;
  getStatus(id: string): Promise<DelegationSnapshot>;
  getMetrics(id: string): Promise<WorkerMetrics>;
  waitForWorker(id: string, timeoutMs: number): Promise<WaitWorkerResult>;
  getResult(id: string): Promise<DelegationSnapshot>;
  getDiff(id: string): Promise<DelegationDiff>;
  prepareCherryPick(id: string): Promise<CherryPickHandoff>;
  resumeWorker(id: string): Promise<DelegationSnapshot>;
  requestRevision(id: string, feedback: string): Promise<DelegationSnapshot>;
  cancel(id: string): Promise<DelegationSnapshot>;
}

function createDelegationId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `delegation-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function checkEvidence(checks: CheckResult[]) {
  return checks.map((check) => ({
    command: check.command,
    args: check.args,
    passed: check.passed,
    exit_code: check.exitCode,
    duration_ms: check.durationMs,
    timed_out: check.timedOut,
    stdout_tail: check.stdout.slice(-4000),
    stderr_tail: check.stderr.slice(-4000),
  }));
}

function isActive(state: DelegationState): boolean {
  return state === "PREPARING" || state === "WORKER_RUNNING" || state === "CHECKING";
}

function classifyFailure(error: unknown): FailureCategory {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("denied required actions")) return "denied_action";
  if (message.includes("empty output") || message.includes("empty structured output")) return "empty_output";
  if (message.includes("timed out")) return "timeout";
  return "provider_error";
}

function assertDelegationId(id: string): void {
  if (!/^delegation-[A-Za-z0-9-]+$/.test(id)) {
    throw new Error("Invalid delegation id");
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export class InteractiveDelegationService implements InteractiveDelegationApi {
  private readonly active = new Map<string, ActiveDelegation>();
  private readonly pendingDelegations = new Map<string, Promise<DelegationStartResult>>();
  private readonly delegationsRoot: string;

  constructor(
    private readonly config: HarnessConfig,
    private readonly harnessRoot: string,
    private readonly worker: Worker,
  ) {
    this.delegationsRoot = path.resolve(harnessRoot, config.dataDirectory, "delegations");
  }

  async initialize(): Promise<void> {
    await mkdir(this.delegationsRoot, { recursive: true });
    const entries = await readdir(this.delegationsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^delegation-[A-Za-z0-9-]+$/.test(entry.name)) continue;
      try {
        const snapshot = await this.loadSnapshot(entry.name);
        if (!isActive(snapshot.state)) continue;
        const job = await this.loadActiveJob(entry.name);
        const worktreeAvailable = await pathExists(job.task.worktree_path);
        await this.update(job, worktreeAvailable
          ? {
              state: "INTERRUPTED",
              message: "MCP server restarted during execution; worktree was preserved. Resume the worker without consuming a revision.",
              revision_feedback: "Resume after MCP server restart and complete the task.",
              attempt_history: this.finishAttemptHistory(job, "interrupted"),
            }
          : {
              state: "FAILED",
              message: "MCP server restarted before the isolated worktree was available.",
              attempt_history: this.finishAttemptHistory(job, "failed", "provider_error"),
            });
      } catch {
        // A corrupt delegation remains on disk for manual diagnosis and does not block the server.
      }
    }
  }

  async list(repositoryPath?: string): Promise<DelegationSnapshot[]> {
    await mkdir(this.delegationsRoot, { recursive: true });
    const resolvedRepository = repositoryPath ? path.resolve(repositoryPath) : undefined;
    const entries = await readdir(this.delegationsRoot, { withFileTypes: true });
    const snapshots: DelegationSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^delegation-[A-Za-z0-9-]+$/.test(entry.name)) continue;
      try {
        const snapshot = await this.loadSnapshot(entry.name);
        if (!resolvedRepository || snapshot.repository_path === resolvedRepository) {
          snapshots.push(snapshot);
        }
      } catch {
        // Ignore incomplete/corrupt entries while preserving their artifacts on disk.
      }
    }
    return snapshots.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async delegate(input: DelegationRequest): Promise<DelegationStartResult> {
    const request = DelegationRequestSchema.parse(input);
    const repositoryPath = path.resolve(request.repository_path);
    if (!request.client_request_id) {
      return await this.createDelegation(request, repositoryPath);
    }

    const repositoryKey = process.platform === "win32"
      ? repositoryPath.toLowerCase()
      : repositoryPath;
    const pendingKey = `${repositoryKey}\0${request.client_request_id}`;
    const pending = this.pendingDelegations.get(pendingKey);
    if (pending) {
      await pending;
      return await this.delegateIdempotently(request, repositoryPath);
    }

    const operation = this.delegateIdempotently(request, repositoryPath);
    this.pendingDelegations.set(pendingKey, operation);
    try {
      return await operation;
    } finally {
      this.pendingDelegations.delete(pendingKey);
    }
  }

  private async delegateIdempotently(
    request: DelegationRequest,
    repositoryPath: string,
  ): Promise<DelegationStartResult> {
    const existing = await this.findByClientRequestId(repositoryPath, request.client_request_id!);
    if (existing) {
      const expectedContract = JSON.stringify({
        objective: request.objective,
        allowed_paths: request.allowed_paths,
        acceptance_criteria: request.acceptance_criteria,
        checks: request.checks,
        worker_instructions: request.worker_instructions ?? request.objective,
      });
      const existingContract = JSON.stringify({
        objective: existing.task.objective,
        allowed_paths: existing.task.allowed_paths,
        acceptance_criteria: existing.task.acceptance_criteria,
        checks: existing.task.checks,
        worker_instructions: existing.task.worker_instructions,
      });
      if (expectedContract !== existingContract) {
        throw new Error(
          `client_request_id ${request.client_request_id} is already used by ${existing.task.id} with a different task contract`,
        );
      }
      return { ...existing.snapshot, delegation_outcome: "reused" };
    }
    return await this.createDelegation(request, repositoryPath);
  }

  private async findByClientRequestId(
    repositoryPath: string,
    clientRequestId: string,
  ): Promise<ActiveDelegation | undefined> {
    await mkdir(this.delegationsRoot, { recursive: true });
    const entries = await readdir(this.delegationsRoot, { withFileTypes: true });
    const matches: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^delegation-[A-Za-z0-9-]+$/.test(entry.name)) continue;
      try {
        const snapshot = await this.loadSnapshot(entry.name);
        const sameRepository = process.platform === "win32"
          ? snapshot.repository_path.toLowerCase() === repositoryPath.toLowerCase()
          : snapshot.repository_path === repositoryPath;
        if (sameRepository && snapshot.client_request_id === clientRequestId) {
          matches.push(entry.name);
        }
      } catch {
        // Corrupt entries are preserved for diagnosis and cannot satisfy an idempotency lookup.
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `client_request_id ${clientRequestId} has multiple persisted delegations in ${repositoryPath}`,
      );
    }
    return matches[0] ? await this.loadActiveJob(matches[0]) : undefined;
  }

  private async createDelegation(
    request: DelegationRequest,
    repositoryPath: string,
  ): Promise<DelegationStartResult> {
    await assertGitRepository(repositoryPath);
    if (this.config.requireCleanRepository) {
      await assertCleanRepository(repositoryPath);
    }

    const running = [...this.active.values()].filter((job) => isActive(job.snapshot.state));
    if (running.length >= this.config.delegation.maxConcurrentWorkers) {
      throw new Error(
        `Concurrent worker limit reached (${this.config.delegation.maxConcurrentWorkers})`,
      );
    }
    for (const job of running) {
      if (job.task.repository_path !== repositoryPath) continue;
      const overlap = findOverlappingScope(request.allowed_paths, job.task.allowed_paths);
      if (overlap) {
        throw new Error(
          `Delegation scope overlaps active worker ${job.task.id}: ${overlap.left} and ${overlap.right}`,
        );
      }
    }

    const id = createDelegationId();
    const jobDirectory = path.join(this.delegationsRoot, id);
    const worktreePath = path.join(jobDirectory, "worktree");
    const branch = `harness/${id}`;
    const baseSha = await getHeadSha(repositoryPath);
    await mkdir(jobDirectory, { recursive: true });

    const task = TaskSpecSchema.parse({
      id,
      requirement: request.objective,
      repository_path: repositoryPath,
      worktree_path: worktreePath,
      base_sha: baseSha,
      branch,
      max_revision_rounds: this.config.maxRevisionRounds,
      objective: request.objective,
      allowed_paths: request.allowed_paths,
      acceptance_criteria: request.acceptance_criteria,
      checks: request.checks,
      worker_instructions: request.worker_instructions ?? request.objective,
      client_request_id: request.client_request_id,
    });
    await writeFile(path.join(jobDirectory, "task.json"), `${JSON.stringify(task, null, 2)}\n`, "utf8");

    const now = new Date().toISOString();
    const snapshot: DelegationSnapshot = {
      id,
      state: "PREPARING",
      objective: request.objective,
      repository_path: repositoryPath,
      worktree_path: worktreePath,
      branch,
      base_sha: baseSha,
      revision_round: 0,
      max_revision_rounds: this.config.maxRevisionRounds,
      worker_attempts: 0,
      codex_process_invocations: 0,
      message: "Creating isolated Git worktree",
      created_at: now,
      updated_at: now,
      changed_files: [],
      checks: [],
      client_request_id: request.client_request_id,
      attempt_history: [],
    };
    const job: ActiveDelegation = { task, jobDirectory, snapshot, cancelRequested: false };
    this.active.set(id, job);
    await this.persist(job);

    try {
      await createWorktree(repositoryPath, worktreePath, branch, baseSha);
      await this.update(job, {
        state: "WORKER_RUNNING",
        message: "Antigravity worker is running",
      });
      await this.startWorker(job, "initial");
    } catch (error) {
      await this.fail(job, error);
    }
    return { ...job.snapshot, delegation_outcome: "created" };
  }

  async getStatus(id: string): Promise<DelegationSnapshot> {
    return await this.loadSnapshot(id);
  }

  async getMetrics(id: string): Promise<WorkerMetrics> {
    const snapshot = await this.loadSnapshot(id);
    const attempts = snapshot.attempt_history;
    let lastFailureCategory: FailureCategory | undefined;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      if (attempt?.failure_category) {
        lastFailureCategory = attempt.failure_category;
        break;
      }
    }
    return {
      worker_id: id,
      state: snapshot.state,
      worker_attempts: snapshot.worker_attempts,
      revision_rounds: snapshot.revision_round,
      initial_attempts: attempts.filter((attempt) => attempt.trigger === "initial").length,
      revision_attempts: attempts.filter((attempt) => attempt.trigger === "revision").length,
      resume_attempts: attempts.filter((attempt) => attempt.trigger === "resume").length,
      completed_attempts: attempts.filter((attempt) => attempt.outcome === "completed").length,
      failed_attempts: attempts.filter((attempt) => attempt.outcome === "failed").length,
      conversation_reuse_count: attempts.filter((attempt) => attempt.conversation_reused).length,
      total_duration_ms: attempts.reduce((total, attempt) => total + (attempt.duration_ms ?? 0), 0),
      total_provider_duration_ms: attempts.reduce(
        (total, attempt) => total + (attempt.provider_duration_ms ?? 0),
        0,
      ),
      total_validation_duration_ms: attempts.reduce(
        (total, attempt) => total + (attempt.validation_duration_ms ?? 0),
        0,
      ),
      ...(lastFailureCategory ? { last_failure_category: lastFailureCategory } : {}),
      attempts,
    };
  }

  async waitForWorker(id: string, timeoutMs: number): Promise<WaitWorkerResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("Worker wait timeout must be a non-negative finite number");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const snapshot = await this.loadSnapshot(id);
      if (!isActive(snapshot.state)) {
        return { timed_out: false, snapshot };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { timed_out: true, snapshot };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
    }
  }

  async getResult(id: string): Promise<DelegationSnapshot> {
    const snapshot = await this.loadSnapshot(id);
    if (isActive(snapshot.state)) {
      throw new Error(`Delegation ${id} is still ${snapshot.state}`);
    }
    return snapshot;
  }

  async getDiff(id: string): Promise<DelegationDiff> {
    const job = await this.loadActiveJob(id);
    if (job.snapshot.state === "PREPARING") {
      throw new Error(`Delegation ${id} does not have a worktree yet`);
    }
    const raw = await getWorktreeDiff(job.task.worktree_path, job.task.base_sha);
    const bounded = boundText(
      raw,
      this.config.delegation.maxDiffBytes,
      this.config.delegation.maxDiffLines,
    );
    const liveChangedFiles = await listChangedFiles(job.task.worktree_path);
    return {
      worker_id: id,
      base_sha: job.task.base_sha,
      changed_files: liveChangedFiles.length > 0 ? liveChangedFiles : job.snapshot.changed_files,
      diff: bounded.text,
      truncated: bounded.truncated,
    };
  }

  async prepareCherryPick(id: string): Promise<CherryPickHandoff> {
    const job = await this.loadActiveJob(id);
    if (job.snapshot.state !== "COMPLETED") {
      throw new Error(`Delegation ${id} must be COMPLETED before preparing cherry-pick`);
    }

    let commitSha = job.snapshot.commit_sha;
    if (!commitSha) {
      const changedFiles = await listChangedFiles(job.task.worktree_path);
      const outOfScope = findOutOfScopeFiles(changedFiles, job.task.allowed_paths);
      if (changedFiles.length === 0) {
        throw new Error(`Delegation ${id} has no uncommitted changes to hand off`);
      }
      if (outOfScope.length > 0) {
        throw new Error(`Delegation ${id} contains out-of-scope files: ${outOfScope.join(", ")}`);
      }
      const checks = await runValidationChecks(
        job.task.checks,
        job.task.worktree_path,
        this.config.validation,
      );
      if (checks.some((check) => !check.passed)) {
        throw new Error(`Validation failed before handoff:\n${formatCheckFailures(checks)}`);
      }
      commitSha = await commitAll(job.task.worktree_path, `harness(${id}): approved delegation`);
      await this.update(job, {
        commit_sha: commitSha,
        changed_files: changedFiles,
        checks: checkEvidence(checks),
        message: "Worker change committed on its isolated branch; ready for explicit cherry-pick",
      });
    }

    const argv = ["git", "-C", job.task.repository_path, "cherry-pick", commitSha];
    return {
      worker_id: id,
      repository_path: job.task.repository_path,
      branch: job.task.branch,
      commit_sha: commitSha,
      argv,
      command: formatCommand(argv),
    };
  }

  async resumeWorker(id: string): Promise<DelegationSnapshot> {
    const job = await this.loadActiveJob(id);
    if (job.snapshot.state !== "INTERRUPTED") {
      throw new Error(`Delegation ${id} cannot be resumed from state ${job.snapshot.state}`);
    }
    if (job.snapshot.commit_sha) {
      throw new Error(`Delegation ${id} is already committed for handoff`);
    }
    if (!await pathExists(job.task.worktree_path)) {
      throw new Error(`Delegation ${id} cannot be resumed because its worktree is unavailable`);
    }

    const resumeFeedback = job.snapshot.revision_feedback
      ?? "Resume after MCP server restart and complete the task.";
    job.cancelRequested = false;
    await this.update(job, {
      state: "WORKER_RUNNING",
      message: "Antigravity worker is resuming after MCP server restart",
      revision_feedback: resumeFeedback,
      checks: [],
    });
    await this.startWorker(job, "resume", resumeFeedback);
    return job.snapshot;
  }

  async requestRevision(id: string, feedback: string): Promise<DelegationSnapshot> {
    if (!feedback.trim()) {
      throw new Error("Revision feedback must not be empty");
    }
    const job = await this.loadActiveJob(id);
    if (job.snapshot.state !== "WAITING_FOR_REVISION" && job.snapshot.state !== "COMPLETED") {
      throw new Error(`Delegation ${id} cannot be revised from state ${job.snapshot.state}`);
    }
    if (job.snapshot.revision_round >= job.snapshot.max_revision_rounds) {
      throw new Error(`Delegation ${id} reached its revision limit`);
    }
    if (job.snapshot.commit_sha) {
      throw new Error(`Delegation ${id} is already committed for handoff`);
    }

    job.cancelRequested = false;
    await this.update(job, {
      state: "WORKER_RUNNING",
      revision_round: job.snapshot.revision_round + 1,
      message: "Antigravity worker is applying revision feedback",
      revision_feedback: feedback,
      checks: [],
    });
    await this.startWorker(job, "revision", feedback);
    return job.snapshot;
  }

  async cancel(id: string): Promise<DelegationSnapshot> {
    const job = await this.loadActiveJob(id);
    if (!isActive(job.snapshot.state)) {
      throw new Error(`Delegation ${id} is not active; current state is ${job.snapshot.state}`);
    }
    job.cancelRequested = true;
    job.controller?.abort();
    await this.update(job, {
      state: "CANCELLED",
      message: "Worker cancellation requested; worktree and branch were preserved",
      attempt_history: this.finishAttemptHistory(job, "cancelled"),
    });
    return job.snapshot;
  }

  private async startWorker(
    job: ActiveDelegation,
    trigger: AttemptTrigger,
    feedback?: string,
  ): Promise<void> {
    const attempt = job.snapshot.worker_attempts + 1;
    const conversationId = job.snapshot.worker_result?.conversation_id;
    await this.update(job, {
      worker_attempts: attempt,
      attempt_history: [
        ...job.snapshot.attempt_history,
        {
          attempt,
          trigger,
          started_at: new Date().toISOString(),
          outcome: "running",
          conversation_reused: conversationId !== undefined,
        },
      ],
    });
    const controller = new AbortController();
    job.controller = controller;
    job.runPromise = this.executeWorker(job, feedback, controller.signal);
  }

  private async executeWorker(
    job: ActiveDelegation,
    feedback: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let phase: "provider" | "validation" = "provider";
    try {
      const conversationId = job.snapshot.worker_result?.conversation_id;
      const workerRun = await this.worker.run(
        job.task,
        job.jobDirectory,
        feedback,
        conversationId,
        signal,
      );
      if (job.cancelRequested || signal.aborted) {
        return;
      }
      if (workerRun.result.status !== "success") {
        throw new Error(`Antigravity worker returned ${workerRun.result.status}: ${workerRun.result.summary}`);
      }

      await this.update(job, {
        state: "CHECKING",
        message: "Checking worker scope and validation commands",
        worker_result: workerRun.result,
        attempt_history: this.patchCurrentAttempt(job, {
          provider_duration_ms: workerRun.process.durationMs,
        }),
      });
      phase = "validation";
      const changedFiles = await listChangedFiles(job.task.worktree_path);
      const outOfScope = findOutOfScopeFiles(changedFiles, job.task.allowed_paths);
      let checks: CheckResult[] = [];
      let feedbackMessage: string | undefined;
      let failureCategory: FailureCategory | undefined;

      if (changedFiles.length === 0) {
        feedbackMessage = "No files changed. Implement the task and produce a reviewable diff.";
        failureCategory = "validation_failure";
      } else if (outOfScope.length > 0) {
        feedbackMessage = [
          "The diff contains files outside allowed_paths.",
          `Out-of-scope files: ${outOfScope.join(", ")}`,
        ].join("\n");
        failureCategory = "scope_violation";
      } else {
        checks = await runValidationChecks(
          job.task.checks,
          job.task.worktree_path,
          this.config.validation,
          signal,
        );
        if (checks.some((check) => !check.passed)) {
          feedbackMessage = `Required validation failed:\n${formatCheckFailures(checks)}`;
          failureCategory = checks.some((check) => check.timedOut)
            ? "timeout"
            : "validation_failure";
        }
      }

      if (job.cancelRequested || signal.aborted) {
        return;
      }
      if (feedbackMessage) {
        await this.update(job, {
          state: "WAITING_FOR_REVISION",
          message: feedbackMessage,
          revision_feedback: feedbackMessage,
          changed_files: changedFiles,
          checks: checkEvidence(checks),
          attempt_history: this.finishAttemptHistory(
            job,
            "waiting_for_revision",
            failureCategory,
            checks,
            false,
          ),
        });
        return;
      }
      await this.update(job, {
        state: "COMPLETED",
        message: "Worker result passed scope and validation gates; ready for Codex review",
        changed_files: changedFiles,
        checks: checkEvidence(checks),
        revision_feedback: undefined,
        attempt_history: this.finishAttemptHistory(job, "completed", undefined, checks, true),
      });
    } catch (error) {
      if (job.cancelRequested || signal.aborted) {
        if (job.snapshot.state !== "CANCELLED") {
          await this.update(job, {
            state: "CANCELLED",
            message: "Worker was cancelled; worktree and branch were preserved",
          });
        }
        return;
      }
      await this.fail(
        job,
        error,
        phase === "validation"
          ? ((error instanceof Error ? error.message : String(error)).toLowerCase().includes("timed out")
              ? "timeout"
              : "validation_failure")
          : classifyFailure(error),
      );
    } finally {
      delete job.controller;
      delete job.runPromise;
    }
  }

  private async fail(
    job: ActiveDelegation,
    error: unknown,
    failureCategory: FailureCategory = classifyFailure(error),
  ): Promise<void> {
    await this.update(job, {
      state: "FAILED",
      message: error instanceof Error ? error.message : String(error),
      attempt_history: this.finishAttemptHistory(job, "failed", failureCategory),
    });
  }

  private patchCurrentAttempt(
    job: ActiveDelegation,
    patch: Partial<WorkerAttempt>,
  ): WorkerAttempt[] {
    const attempts = [...job.snapshot.attempt_history];
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      if (attempt?.outcome === "running") {
        attempts[index] = WorkerAttemptSchema.parse({ ...attempt, ...patch });
        break;
      }
    }
    return attempts;
  }

  private finishAttemptHistory(
    job: ActiveDelegation,
    outcome: Exclude<AttemptOutcome, "running">,
    failureCategory?: FailureCategory,
    checks: CheckResult[] = [],
    validationPassed?: boolean,
  ): WorkerAttempt[] {
    const finishedAt = new Date();
    const attempts = [...job.snapshot.attempt_history];
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      if (attempt?.outcome === "running") {
        const startedAt = Date.parse(attempt.started_at);
        attempts[index] = WorkerAttemptSchema.parse({
          ...attempt,
          outcome,
          finished_at: finishedAt.toISOString(),
          duration_ms: Number.isFinite(startedAt) ? Math.max(0, finishedAt.getTime() - startedAt) : 0,
          validation_duration_ms: checks.reduce((total, check) => total + check.durationMs, 0),
          ...(validationPassed !== undefined ? { validation_passed: validationPassed } : {}),
          ...(failureCategory ? { failure_category: failureCategory } : {}),
        });
        break;
      }
    }
    return attempts;
  }

  private async update(
    job: ActiveDelegation,
    patch: Partial<DelegationSnapshot>,
  ): Promise<void> {
    job.snapshot = DelegationSnapshotSchema.parse({
      ...job.snapshot,
      ...patch,
      updated_at: new Date().toISOString(),
    });
    await this.persist(job);
  }

  private async persist(job: ActiveDelegation): Promise<void> {
    await writeFile(
      path.join(job.jobDirectory, "status.json"),
      `${JSON.stringify(job.snapshot, null, 2)}\n`,
      "utf8",
    );
  }

  private async loadSnapshot(id: string): Promise<DelegationSnapshot> {
    assertDelegationId(id);
    const active = this.active.get(id);
    if (active) {
      return active.snapshot;
    }
    const raw = await readFile(path.join(this.delegationsRoot, id, "status.json"), "utf8");
    return DelegationSnapshotSchema.parse(JSON.parse(raw));
  }

  private async loadActiveJob(id: string): Promise<ActiveDelegation> {
    assertDelegationId(id);
    const existing = this.active.get(id);
    if (existing) {
      return existing;
    }
    const jobDirectory = path.join(this.delegationsRoot, id);
    const [taskRaw, snapshot] = await Promise.all([
      readFile(path.join(jobDirectory, "task.json"), "utf8"),
      this.loadSnapshot(id),
    ]);
    const job: ActiveDelegation = {
      task: TaskSpecSchema.parse(JSON.parse(taskRaw)),
      jobDirectory,
      snapshot,
      cancelRequested: false,
    };
    this.active.set(id, job);
    return job;
  }
}
