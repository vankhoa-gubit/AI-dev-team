import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Worker } from "./adapters/antigravity.js";
import type { HarnessConfig } from "./config.js";
import {
  assertCleanRepository,
  assertGitRepository,
  createWorktree,
  findOutOfScopeFiles,
  getHeadSha,
  listChangedFiles,
} from "./git.js";
import {
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
}).strict();

export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

export const DelegationStateSchema = z.enum([
  "PREPARING",
  "WORKER_RUNNING",
  "CHECKING",
  "WAITING_FOR_REVISION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export type DelegationState = z.infer<typeof DelegationStateSchema>;

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
  revision_round: z.number().int().min(0),
  max_revision_rounds: z.number().int().min(0),
  message: z.string(),
  updated_at: z.string(),
  changed_files: z.array(z.string()).default([]),
  checks: z.array(CheckEvidenceSchema).default([]),
  worker_result: WorkerResultSchema.optional(),
  revision_feedback: z.string().optional(),
}).strict();

export type DelegationSnapshot = z.infer<typeof DelegationSnapshotSchema>;

interface ActiveDelegation {
  task: TaskSpec;
  jobDirectory: string;
  snapshot: DelegationSnapshot;
  controller?: AbortController;
  runPromise?: Promise<void>;
  cancelRequested: boolean;
}

export interface InteractiveDelegationApi {
  delegate(request: DelegationRequest): Promise<DelegationSnapshot>;
  getStatus(id: string): Promise<DelegationSnapshot>;
  getResult(id: string): Promise<DelegationSnapshot>;
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

function assertDelegationId(id: string): void {
  if (!/^delegation-[A-Za-z0-9-]+$/.test(id)) {
    throw new Error("Invalid delegation id");
  }
}

export class InteractiveDelegationService implements InteractiveDelegationApi {
  private readonly active = new Map<string, ActiveDelegation>();
  private readonly delegationsRoot: string;

  constructor(
    private readonly config: HarnessConfig,
    private readonly harnessRoot: string,
    private readonly worker: Worker,
  ) {
    this.delegationsRoot = path.resolve(harnessRoot, config.dataDirectory, "delegations");
  }

  async delegate(input: DelegationRequest): Promise<DelegationSnapshot> {
    const request = DelegationRequestSchema.parse(input);
    const repositoryPath = path.resolve(request.repository_path);
    await assertGitRepository(repositoryPath);
    if (this.config.requireCleanRepository) {
      await assertCleanRepository(repositoryPath);
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
    });
    await writeFile(path.join(jobDirectory, "task.json"), `${JSON.stringify(task, null, 2)}\n`, "utf8");

    const snapshot: DelegationSnapshot = {
      id,
      state: "PREPARING",
      objective: request.objective,
      repository_path: repositoryPath,
      worktree_path: worktreePath,
      branch,
      revision_round: 0,
      max_revision_rounds: this.config.maxRevisionRounds,
      message: "Creating isolated Git worktree",
      updated_at: new Date().toISOString(),
      changed_files: [],
      checks: [],
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
      this.startWorker(job);
    } catch (error) {
      await this.fail(job, error);
    }
    return job.snapshot;
  }

  async getStatus(id: string): Promise<DelegationSnapshot> {
    return await this.loadSnapshot(id);
  }

  async getResult(id: string): Promise<DelegationSnapshot> {
    const snapshot = await this.loadSnapshot(id);
    if (isActive(snapshot.state)) {
      throw new Error(`Delegation ${id} is still ${snapshot.state}`);
    }
    return snapshot;
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

    job.cancelRequested = false;
    await this.update(job, {
      state: "WORKER_RUNNING",
      revision_round: job.snapshot.revision_round + 1,
      message: "Antigravity worker is applying revision feedback",
      revision_feedback: feedback,
      checks: [],
    });
    this.startWorker(job, feedback);
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
    });
    return job.snapshot;
  }

  private startWorker(job: ActiveDelegation, feedback?: string): void {
    const controller = new AbortController();
    job.controller = controller;
    job.runPromise = this.executeWorker(job, feedback, controller.signal);
  }

  private async executeWorker(
    job: ActiveDelegation,
    feedback: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
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
      });
      const changedFiles = await listChangedFiles(job.task.worktree_path);
      const outOfScope = findOutOfScopeFiles(changedFiles, job.task.allowed_paths);
      let checks: CheckResult[] = [];
      let feedbackMessage: string | undefined;

      if (changedFiles.length === 0) {
        feedbackMessage = "No files changed. Implement the task and produce a reviewable diff.";
      } else if (outOfScope.length > 0) {
        feedbackMessage = [
          "The diff contains files outside allowed_paths.",
          `Out-of-scope files: ${outOfScope.join(", ")}`,
        ].join("\n");
      } else {
        checks = await runValidationChecks(
          job.task.checks,
          job.task.worktree_path,
          this.config.validation,
          signal,
        );
        if (checks.some((check) => !check.passed)) {
          feedbackMessage = `Required validation failed:\n${formatCheckFailures(checks)}`;
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
        });
        return;
      }
      await this.update(job, {
        state: "COMPLETED",
        message: "Worker result passed scope and validation gates; ready for Codex review",
        changed_files: changedFiles,
        checks: checkEvidence(checks),
        revision_feedback: undefined,
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
      await this.fail(job, error);
    } finally {
      delete job.controller;
      delete job.runPromise;
    }
  }

  private async fail(job: ActiveDelegation, error: unknown): Promise<void> {
    await this.update(job, {
      state: "FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
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
