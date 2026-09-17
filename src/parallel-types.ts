import { z } from "zod";
import { LeaderPlanSchema, WorkerResultSchema, type CheckResult, type ReviewResult } from "./types.js";

export const ParallelShardPlanSchema = LeaderPlanSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
}).strict();

export type ParallelShardPlan = z.infer<typeof ParallelShardPlanSchema>;

export const ParallelPlanSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(ParallelShardPlanSchema).min(2),
  integration_acceptance_criteria: z.array(z.string().min(1)).min(1),
  integration_checks: z.array(z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
  }).strict()),
}).strict();

export type ParallelPlan = z.infer<typeof ParallelPlanSchema>;

export const ParallelRunStateSchema = z.enum([
  "RECEIVED",
  "PLANNING",
  "SHARDS_RUNNING",
  "INTEGRATING",
  "INTEGRATION_CHECKING",
  "INTEGRATION_REVIEWING",
  "DONE",
  "REPLAN_REQUIRED",
  "FAILED",
]);

export type ParallelRunState = z.infer<typeof ParallelRunStateSchema>;

export interface ParallelShardResult {
  id: string;
  state: "APPROVED" | "FAILED";
  branch: string;
  worktreePath: string;
  revisionRound: number;
  message: string;
  changedFiles: string[];
  checks: CheckResult[];
  workerResult?: z.infer<typeof WorkerResultSchema>;
  review?: ReviewResult;
  commitSha?: string;
}

export interface ParallelRunSummary {
  id: string;
  state: ParallelRunState;
  message: string;
  repositoryPath: string;
  baseSha?: string;
  integrationBranch?: string;
  integrationWorktreePath?: string;
  integrationCommitSha?: string;
  conflictFiles?: string[];
  shardResults: ParallelShardResult[];
}
