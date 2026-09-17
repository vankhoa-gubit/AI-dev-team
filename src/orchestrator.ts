import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "./config.js";
import { HarnessDatabase } from "./database.js";
import {
  assertCleanRepository,
  assertGitRepository,
  createWorktree,
  findOutOfScopeFiles,
  getHeadSha,
  listChangedFiles,
} from "./git.js";
import { checkRouter, codexProviderIsConfigured } from "./router.js";
import { assertTransition } from "./state-machine.js";
import {
  TaskSpecSchema,
  type CheckResult,
  type JobState,
  type JobSummary,
  type ReviewResult,
  type TaskSpec,
} from "./types.js";
import { formatCheckFailures, runValidationChecks } from "./validation.js";
import type { Planner, Reviewer } from "./adapters/codex.js";
import type { Worker } from "./adapters/antigravity.js";

export interface OrchestratorDependencies {
  planner: Planner;
  worker: Worker;
  reviewer: Reviewer;
}

function createJobId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `job-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function summarizeReview(review: ReviewResult): string {
  return JSON.stringify({
    verdict: review.verdict,
    summary: review.summary,
    findings: review.findings,
    acceptance_criteria: review.acceptance_criteria,
  }, null, 2);
}

export class Orchestrator {
  constructor(
    private readonly config: HarnessConfig,
    private readonly harnessRoot: string,
    private readonly dependencies: OrchestratorDependencies,
  ) {}

  async run(requirement: string, repositoryPath: string): Promise<JobSummary> {
    const repoPath = path.resolve(repositoryPath);
    const dataRoot = path.resolve(this.harnessRoot, this.config.dataDirectory);
    const jobId = createJobId();
    const jobDirectory = path.join(dataRoot, "jobs", jobId);
    const worktreePath = path.join(jobDirectory, "worktree");
    const branch = `harness/${jobId}`;
    await mkdir(jobDirectory, { recursive: true });

    const database = new HarnessDatabase(path.join(dataRoot, "harness.sqlite"));
    let state: JobState = "RECEIVED";
    let revisionRound = 0;

    const transition = (
      next: JobState,
      message: string,
      payload?: unknown,
      fields: { branch?: string; worktreePath?: string; revisionRound?: number } = {},
    ) => {
      assertTransition(state, next);
      state = next;
      database.transition(jobId, next, message, fields, payload);
    };

    database.createJob(jobId, requirement, repoPath);

    try {
      await assertGitRepository(repoPath);
      if (this.config.requireCleanRepository) {
        await assertCleanRepository(repoPath);
      }

      if (this.config.router.required) {
        const router = await checkRouter(this.config.router.baseUrl);
        if (!router.reachable) {
          throw new Error(router.message);
        }
        if (this.config.codex.provider && !this.config.codex.providerBaseUrl) {
          const configured = await codexProviderIsConfigured(this.config.codex.provider);
          if (!configured) {
            throw new Error(
              `Codex provider '${this.config.codex.provider}' is not configured in the active Codex config`,
            );
          }
        }
      }

      const baseSha = await getHeadSha(repoPath);
      transition("PLANNING", "Codex leader is preparing the task contract");
      const plan = await this.dependencies.planner.plan(requirement, repoPath, jobDirectory);

      await createWorktree(repoPath, worktreePath, branch, baseSha);
      const task = TaskSpecSchema.parse({
        ...plan,
        id: jobId,
        requirement,
        repository_path: repoPath,
        worktree_path: worktreePath,
        base_sha: baseSha,
        branch,
        max_revision_rounds: this.config.maxRevisionRounds,
      });
      const taskPath = path.join(jobDirectory, "task.json");
      await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
      transition("READY", "Task contract and isolated worktree are ready", task, { branch, worktreePath });

      let revisionFeedback: string | undefined;
      let conversationId: string | undefined;

      while (true) {
        transition("WORKER_RUNNING", `Antigravity worker is running revision ${revisionRound}`);
        const workerRun = await this.dependencies.worker.run(
          task,
          jobDirectory,
          revisionFeedback,
          conversationId,
        );
        conversationId = workerRun.result.conversation_id ?? conversationId;
        if (workerRun.result.status !== "success") {
          throw new Error(`Antigravity worker returned ${workerRun.result.status}: ${workerRun.result.summary}`);
        }

        transition("CHECKING", "Checking worker scope and validation commands");
        const changedFiles = await listChangedFiles(worktreePath);
        const outOfScope = findOutOfScopeFiles(changedFiles, task.allowed_paths);
        let checks: CheckResult[] = [];
        let failureFeedback: string | undefined;

        if (changedFiles.length === 0) {
          failureFeedback = "No files changed. Implement the task and produce a reviewable diff.";
        } else if (outOfScope.length > 0) {
          failureFeedback = [
            "The diff contains files outside allowed_paths. Revert those edits and keep the required implementation in scope.",
            `Out-of-scope files: ${outOfScope.join(", ")}`,
          ].join("\n");
        } else {
          checks = await runValidationChecks(task.checks, worktreePath, this.config.validation);
          if (checks.some((check) => !check.passed)) {
            failureFeedback = `Required validation failed:\n${formatCheckFailures(checks)}`;
          }
        }

        if (failureFeedback) {
          if (revisionRound >= this.config.maxRevisionRounds) {
            throw new Error(`Revision limit reached. ${failureFeedback}`);
          }
          revisionRound += 1;
          revisionFeedback = failureFeedback;
          transition("REVISION_REQUIRED", failureFeedback, { changedFiles, checks }, { revisionRound });
          continue;
        }

        transition("REVIEWING", "Codex reviewer is reviewing the diff", { changedFiles, checks });
        const reviewRun = await this.dependencies.reviewer.review(task, checks, jobDirectory);
        await writeFile(
          path.join(jobDirectory, `review-result-${revisionRound}.json`),
          `${JSON.stringify(reviewRun.result, null, 2)}\n`,
          "utf8",
        );

        if (reviewRun.result.verdict === "approved") {
          transition("APPROVED", "Codex reviewer approved the worker diff", reviewRun.result, {
            revisionRound,
          });
          return {
            id: jobId,
            state,
            branch,
            worktreePath,
            taskPath,
            revisionRound,
            message: reviewRun.result.summary,
          };
        }

        if (revisionRound >= this.config.maxRevisionRounds) {
          throw new Error(`Reviewer requested changes after the revision limit: ${reviewRun.result.summary}`);
        }
        revisionRound += 1;
        revisionFeedback = `Independent Codex review requested changes:\n${summarizeReview(reviewRun.result)}`;
        transition("REVISION_REQUIRED", reviewRun.result.summary, reviewRun.result, { revisionRound });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedFromState = String(state) as JobState;
      if (failedFromState !== "FAILED" && failedFromState !== "APPROVED") {
        transition("FAILED", message);
      }
      const summary: JobSummary = {
        id: jobId,
        state: "FAILED",
        revisionRound,
        message,
      };
      if (failedFromState !== "RECEIVED" && failedFromState !== "PLANNING") {
        summary.branch = branch;
        summary.worktreePath = worktreePath;
      }
      return summary;
    } finally {
      database.close();
    }
  }
}
