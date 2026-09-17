import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParallelPlanner, Reviewer } from "./adapters/codex.js";
import type { Worker } from "./adapters/antigravity.js";
import type { HarnessConfig } from "./config.js";
import {
  applyCommitWithoutCommit,
  assertCleanRepository,
  assertGitRepository,
  commitAll,
  createWorktree,
  findOutOfScopeFiles,
  getHeadSha,
  listChangedFiles,
  listUnmergedFiles,
} from "./git.js";
import {
  ParallelPlanSchema,
  type ParallelPlan,
  type ParallelRunState,
  type ParallelRunSummary,
  type ParallelShardPlan,
  type ParallelShardResult,
} from "./parallel-types.js";
import { checkRouter, codexProviderIsConfigured } from "./router.js";
import { TaskSpecSchema, type CheckResult, type TaskSpec, type ValidationCommand } from "./types.js";
import { formatCheckFailures, runValidationChecks } from "./validation.js";

export interface ParallelOrchestratorDependencies {
  planner: ParallelPlanner;
  worker: Worker;
  reviewer: Reviewer;
}

interface ScopeDescriptor {
  kind: "exact" | "tree";
  value: string;
  original: string;
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `parallel-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function normalizeScope(pattern: string): ScopeDescriptor {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const wildcard = normalized.search(/[?*]/);
  if (wildcard < 0) {
    return { kind: "exact", value: normalized, original: pattern };
  }
  const slash = normalized.lastIndexOf("/", wildcard);
  const root = slash < 0 ? "" : normalized.slice(0, slash);
  if (!root) {
    throw new Error(`Parallel task scope is too broad to prove disjoint: ${pattern}`);
  }
  return { kind: "tree", value: root, original: pattern };
}

function scopesOverlap(left: ScopeDescriptor, right: ScopeDescriptor): boolean {
  if (left.kind === "exact" && right.kind === "exact") {
    return left.value === right.value;
  }
  if (left.kind === "tree" && right.kind === "tree") {
    return left.value === right.value
      || left.value.startsWith(`${right.value}/`)
      || right.value.startsWith(`${left.value}/`);
  }
  const tree = left.kind === "tree" ? left : right;
  const exact = left.kind === "exact" ? left : right;
  return exact.value === tree.value || exact.value.startsWith(`${tree.value}/`);
}

export function assertDisjointTaskPaths(plan: ParallelPlan): void {
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate parallel task id: ${task.id}`);
    }
    ids.add(task.id);
  }

  for (let leftIndex = 0; leftIndex < plan.tasks.length; leftIndex += 1) {
    const left = plan.tasks[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < plan.tasks.length; rightIndex += 1) {
      const right = plan.tasks[rightIndex];
      if (!right) continue;
      for (const leftPattern of left.allowed_paths) {
        const leftScope = normalizeScope(leftPattern);
        for (const rightPattern of right.allowed_paths) {
          const rightScope = normalizeScope(rightPattern);
          if (scopesOverlap(leftScope, rightScope)) {
            throw new Error(
              `Parallel task scopes overlap: ${left.id}:${leftScope.original} and ${right.id}:${rightScope.original}`,
            );
          }
        }
      }
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runner = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await operation(item, index);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => runner(),
  ));
  return results;
}

function uniqueChecks(plan: ParallelPlan): ValidationCommand[] {
  const seen = new Set<string>();
  const result: ValidationCommand[] = [];
  for (const check of [
    ...plan.tasks.flatMap((task) => task.checks),
    ...plan.integration_checks,
  ]) {
    const key = JSON.stringify(check);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(check);
    }
  }
  return result;
}

export class ParallelOrchestrator {
  constructor(
    private readonly config: HarnessConfig,
    private readonly harnessRoot: string,
    private readonly dependencies: ParallelOrchestratorDependencies,
  ) {}

  async run(requirement: string, repositoryPath: string): Promise<ParallelRunSummary> {
    const repoPath = path.resolve(repositoryPath);
    const runId = createRunId();
    const runDirectory = path.resolve(
      this.harnessRoot,
      this.config.dataDirectory,
      "parallel-runs",
      runId,
    );
    await mkdir(runDirectory, { recursive: true });
    let summary: ParallelRunSummary = {
      id: runId,
      state: "RECEIVED",
      message: "Parallel run received",
      repositoryPath: repoPath,
      shardResults: [],
    };

    const transition = async (
      state: ParallelRunState,
      message: string,
      patch: Partial<ParallelRunSummary> = {},
    ) => {
      summary = { ...summary, ...patch, state, message };
      await Promise.all([
        writeFile(path.join(runDirectory, "status.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
        appendFile(path.join(runDirectory, "events.jsonl"), `${JSON.stringify({
          at: new Date().toISOString(),
          state,
          message,
        })}\n`, "utf8"),
      ]);
    };

    await transition("RECEIVED", "Parallel run received");
    try {
      await assertGitRepository(repoPath);
      if (this.config.requireCleanRepository) {
        await assertCleanRepository(repoPath);
      }
      if (this.config.router.required) {
        const router = await checkRouter(this.config.router.baseUrl);
        if (!router.reachable) throw new Error(router.message);
        if (this.config.codex.provider && !this.config.codex.providerBaseUrl) {
          const configured = await codexProviderIsConfigured(this.config.codex.provider);
          if (!configured) {
            throw new Error(`Codex provider '${this.config.codex.provider}' is not configured`);
          }
        }
      }

      const baseSha = await getHeadSha(repoPath);
      await transition("PLANNING", "Codex leader is creating disjoint parallel tasks", { baseSha });
      const plan = ParallelPlanSchema.parse(
        await this.dependencies.planner.planParallel(requirement, repoPath, runDirectory),
      );
      if (plan.tasks.length > this.config.parallel.maxTasks) {
        throw new Error(
          `Parallel plan contains ${plan.tasks.length} tasks; maximum is ${this.config.parallel.maxTasks}`,
        );
      }
      assertDisjointTaskPaths(plan);
      await writeFile(path.join(runDirectory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

      await transition("SHARDS_RUNNING", `Running ${plan.tasks.length} isolated worker shards`);
      const shardResults = await mapWithConcurrency(
        plan.tasks,
        this.config.parallel.maxWorkers,
        async (shard) => await this.runShard(
          runId,
          runDirectory,
          repoPath,
          baseSha,
          requirement,
          shard,
        ),
      );
      await writeFile(
        path.join(runDirectory, "shard-results.json"),
        `${JSON.stringify(shardResults, null, 2)}\n`,
        "utf8",
      );
      if (shardResults.some((result) => result.state !== "APPROVED")) {
        await transition("FAILED", "One or more worker shards failed", { shardResults });
        return summary;
      }

      const integrationBranch = `harness/${runId}/integration`;
      const integrationWorktreePath = path.join(runDirectory, "integration-worktree");
      await transition("INTEGRATING", "Applying approved shard commits in plan order", {
        shardResults,
        integrationBranch,
        integrationWorktreePath,
      });
      await createWorktree(repoPath, integrationWorktreePath, integrationBranch, baseSha);
      for (const shard of shardResults) {
        if (!shard.commitSha) {
          throw new Error(`Approved shard ${shard.id} has no commit SHA`);
        }
        const applied = await applyCommitWithoutCommit(integrationWorktreePath, shard.commitSha);
        if (applied.exitCode !== 0 || applied.timedOut) {
          const conflictFiles = await listUnmergedFiles(integrationWorktreePath);
          await transition(
            "REPLAN_REQUIRED",
            `Integration conflict while applying shard ${shard.id}: ${applied.stderr.trim() || applied.stdout.trim()}`,
            { conflictFiles },
          );
          return summary;
        }
      }

      const allowedPaths = [...new Set(plan.tasks.flatMap((task) => task.allowed_paths))];
      const changedFiles = await listChangedFiles(integrationWorktreePath);
      const outOfScope = findOutOfScopeFiles(changedFiles, allowedPaths);
      if (outOfScope.length > 0) {
        await transition(
          "REPLAN_REQUIRED",
          `Integrated diff contains files outside the union of shard scopes: ${outOfScope.join(", ")}`,
          { conflictFiles: outOfScope },
        );
        return summary;
      }

      const integrationChecks = uniqueChecks(plan);
      await transition("INTEGRATION_CHECKING", "Running validation on the integrated diff");
      const checkResults = await runValidationChecks(
        integrationChecks,
        integrationWorktreePath,
        this.config.validation,
      );
      await writeFile(
        path.join(runDirectory, "integration-checks.json"),
        `${JSON.stringify(checkResults, null, 2)}\n`,
        "utf8",
      );
      if (checkResults.some((check) => !check.passed)) {
        await transition(
          "REPLAN_REQUIRED",
          `Integrated validation failed:\n${formatCheckFailures(checkResults)}`,
        );
        return summary;
      }

      const integrationTask = TaskSpecSchema.parse({
        id: `${runId}-integration`,
        requirement,
        repository_path: repoPath,
        worktree_path: integrationWorktreePath,
        base_sha: baseSha,
        branch: integrationBranch,
        max_revision_rounds: 0,
        objective: plan.objective,
        allowed_paths: allowedPaths,
        acceptance_criteria: plan.integration_acceptance_criteria,
        checks: integrationChecks,
        worker_instructions: "Review the combined approved shard diff as one integration change.",
      });
      await writeFile(
        path.join(runDirectory, "integration-task.json"),
        `${JSON.stringify(integrationTask, null, 2)}\n`,
        "utf8",
      );
      const integrationReviewDirectory = path.join(runDirectory, "integration-review");
      await mkdir(integrationReviewDirectory, { recursive: true });
      await transition("INTEGRATION_REVIEWING", "Codex reviewer is reviewing the integrated diff");
      const review = await this.dependencies.reviewer.review(
        integrationTask,
        checkResults,
        integrationReviewDirectory,
      );
      await writeFile(
        path.join(runDirectory, "integration-review.json"),
        `${JSON.stringify(review.result, null, 2)}\n`,
        "utf8",
      );
      if (review.result.verdict !== "approved") {
        await transition(
          "REPLAN_REQUIRED",
          `Integration review requested changes: ${review.result.summary}`,
        );
        return summary;
      }

      const integrationCommitSha = await commitAll(
        integrationWorktreePath,
        `harness(${runId}): integrate approved parallel shards`,
      );
      await transition("DONE", "Parallel shards integrated and approved", { integrationCommitSha });
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (summary.state !== "REPLAN_REQUIRED" && summary.state !== "DONE") {
        await transition("FAILED", message);
      }
      return summary;
    }
  }

  private async runShard(
    runId: string,
    runDirectory: string,
    repositoryPath: string,
    baseSha: string,
    requirement: string,
    shard: ParallelShardPlan,
  ): Promise<ParallelShardResult> {
    const shardDirectory = path.join(runDirectory, "shards", shard.id);
    const worktreePath = path.join(shardDirectory, "worktree");
    const branch = `harness/${runId}/shard/${shard.id}`;
    await mkdir(shardDirectory, { recursive: true });
    let revisionRound = 0;
    let changedFiles: string[] = [];
    let checks: CheckResult[] = [];
    let workerResult: ParallelShardResult["workerResult"];
    let review: ParallelShardResult["review"];

    const persistResult = async (result: ParallelShardResult): Promise<ParallelShardResult> => {
      await writeFile(
        path.join(shardDirectory, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
      return result;
    };

    try {
      await createWorktree(repositoryPath, worktreePath, branch, baseSha);
      const task = TaskSpecSchema.parse({
        ...shard,
        id: `${runId}-${shard.id}`,
        requirement,
        repository_path: repositoryPath,
        worktree_path: worktreePath,
        base_sha: baseSha,
        branch,
        max_revision_rounds: this.config.maxRevisionRounds,
      });
      await writeFile(path.join(shardDirectory, "task.json"), `${JSON.stringify(task, null, 2)}\n`, "utf8");
      let feedback: string | undefined;
      let conversationId: string | undefined;

      while (true) {
        const workerRun = await this.dependencies.worker.run(
          task,
          shardDirectory,
          feedback,
          conversationId,
        );
        workerResult = workerRun.result;
        conversationId = workerResult.conversation_id ?? conversationId;
        if (workerResult.status !== "success") {
          throw new Error(`Worker returned ${workerResult.status}: ${workerResult.summary}`);
        }

        changedFiles = await listChangedFiles(worktreePath);
        const outOfScope = findOutOfScopeFiles(changedFiles, task.allowed_paths);
        let failure: string | undefined;
        checks = [];
        if (changedFiles.length === 0) {
          failure = "No files changed";
        } else if (outOfScope.length > 0) {
          failure = `Out-of-scope files: ${outOfScope.join(", ")}`;
        } else {
          checks = await runValidationChecks(task.checks, worktreePath, this.config.validation);
          if (checks.some((check) => !check.passed)) {
            failure = `Validation failed:\n${formatCheckFailures(checks)}`;
          }
        }

        if (failure) {
          if (revisionRound >= this.config.maxRevisionRounds) {
            throw new Error(`Revision limit reached. ${failure}`);
          }
          revisionRound += 1;
          feedback = failure;
          continue;
        }

        const reviewRun = await this.dependencies.reviewer.review(task, checks, shardDirectory);
        review = reviewRun.result;
        if (review.verdict === "approved") {
          const commitSha = await commitAll(
            worktreePath,
            `harness(${runId}): approve shard ${shard.id}`,
          );
          return await persistResult({
            id: shard.id,
            state: "APPROVED",
            branch,
            worktreePath,
            revisionRound,
            message: review.summary,
            changedFiles,
            checks,
            workerResult,
            review,
            commitSha,
          });
        }
        if (revisionRound >= this.config.maxRevisionRounds) {
          throw new Error(`Review requested changes after revision limit: ${review.summary}`);
        }
        revisionRound += 1;
        feedback = `Codex review requested changes:\n${JSON.stringify(review, null, 2)}`;
      }
    } catch (error) {
      const result: ParallelShardResult = {
        id: shard.id,
        state: "FAILED",
        branch,
        worktreePath,
        revisionRound,
        message: error instanceof Error ? error.message : String(error),
        changedFiles,
        checks,
        ...(workerResult ? { workerResult } : {}),
        ...(review ? { review } : {}),
      };
      return await persistResult(result);
    }
  }
}
