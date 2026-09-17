import { z } from "zod";

export const ValidationCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
}).strict();

export type ValidationCommand = z.infer<typeof ValidationCommandSchema>;

export const LeaderPlanSchema = z.object({
  objective: z.string().min(1),
  allowed_paths: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  checks: z.array(ValidationCommandSchema),
  worker_instructions: z.string().min(1),
}).strict();

export type LeaderPlan = z.infer<typeof LeaderPlanSchema>;

export const TaskSpecSchema = LeaderPlanSchema.extend({
  id: z.string().min(1),
  requirement: z.string().min(1),
  repository_path: z.string().min(1),
  worktree_path: z.string().min(1),
  base_sha: z.string().min(1),
  branch: z.string().min(1),
  max_revision_rounds: z.number().int().min(0),
}).strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const WorkerResultSchema = z.object({
  status: z.enum(["success", "blocked", "failed"]),
  summary: z.string(),
  files_changed: z.array(z.string()),
  checks_attempted: z.array(z.string()),
  residual_risks: z.array(z.string()),
  conversation_id: z.string().min(1).optional(),
}).strict();

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string(),
  detail: z.string(),
  path: z.string().nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
}).strict();

export const ReviewCriterionSchema = z.object({
  criterion: z.string(),
  status: z.enum(["passed", "failed", "unclear"]),
  evidence: z.string(),
}).strict();

export const ReviewResultSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  summary: z.string(),
  findings: z.array(ReviewFindingSchema),
  acceptance_criteria: z.array(ReviewCriterionSchema),
}).strict();

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const JobStateSchema = z.enum([
  "RECEIVED",
  "PLANNING",
  "READY",
  "WORKER_RUNNING",
  "CHECKING",
  "REVIEWING",
  "REVISION_REQUIRED",
  "APPROVED",
  "FAILED",
]);

export type JobState = z.infer<typeof JobStateSchema>;

export interface ProcessResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CheckResult extends ProcessResult {
  passed: boolean;
}

export interface WorkerRunResult {
  result: WorkerResult;
  process: ProcessResult;
}

export interface ReviewRunResult {
  result: ReviewResult;
  process: ProcessResult;
}

export interface JobSummary {
  id: string;
  state: JobState;
  branch?: string;
  worktreePath?: string;
  taskPath?: string;
  revisionRound: number;
  message: string;
}
