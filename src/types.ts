import { z } from "zod";

export const ValidationCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
}).strict();

export type ValidationCommand = z.infer<typeof ValidationCommandSchema>;

export const ClientRequestIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const TaskContractSchema = z.object({
  objective: z.string().min(1),
  allowed_paths: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  checks: z.array(ValidationCommandSchema),
  worker_instructions: z.string().min(1),
}).strict();

export type TaskContract = z.infer<typeof TaskContractSchema>;

export const TaskSpecSchema = TaskContractSchema.extend({
  id: z.string().min(1),
  requirement: z.string().min(1),
  repository_path: z.string().min(1),
  worktree_path: z.string().min(1),
  base_sha: z.string().min(1),
  branch: z.string().min(1),
  max_revision_rounds: z.number().int().min(0),
  client_request_id: ClientRequestIdSchema.optional(),
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
