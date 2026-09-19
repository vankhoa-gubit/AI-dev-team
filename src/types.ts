import { z } from "zod";

export const ValidationCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
}).strict();

export type ValidationCommand = z.infer<typeof ValidationCommandSchema>;

export const ChangeBudgetSchema = z.object({
  max_changed_files: z.number().int().min(1).max(10_000),
  max_diff_lines: z.number().int().min(1).max(20_000),
  max_diff_bytes: z.number().int().min(1).max(2 * 1024 * 1024),
}).strict();

export type ChangeBudget = z.infer<typeof ChangeBudgetSchema>;

export const CriterionCheckMappingSchema = z.object({
  criterion_index: z.number().int().min(0),
  check_indices: z.array(z.number().int().min(0)).min(1),
}).strict();

export type CriterionCheckMapping = z.infer<typeof CriterionCheckMappingSchema>;

export const ClientRequestIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

const TaskContractShape = {
  objective: z.string().min(1),
  allowed_paths: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  checks: z.array(ValidationCommandSchema),
  worker_instructions: z.string().min(1),
  budgets: ChangeBudgetSchema.optional(),
  criterion_check_mapping: z.array(CriterionCheckMappingSchema).default([]),
};

function validateCriterionCheckMapping(
  value: {
    acceptance_criteria: string[];
    checks: ValidationCommand[];
    criterion_check_mapping: CriterionCheckMapping[];
  },
  context: z.RefinementCtx,
): void {
  const seenCriteria = new Set<number>();
  for (let mappingIndex = 0; mappingIndex < value.criterion_check_mapping.length; mappingIndex += 1) {
    const mapping = value.criterion_check_mapping[mappingIndex]!;
    if (mapping.criterion_index >= value.acceptance_criteria.length) {
      context.addIssue({
        code: "custom",
        path: ["criterion_check_mapping", mappingIndex, "criterion_index"],
        message: `criterion_index ${mapping.criterion_index} does not reference an acceptance criterion`,
      });
    }
    if (seenCriteria.has(mapping.criterion_index)) {
      context.addIssue({
        code: "custom",
        path: ["criterion_check_mapping", mappingIndex, "criterion_index"],
        message: `criterion_index ${mapping.criterion_index} is mapped more than once`,
      });
    }
    seenCriteria.add(mapping.criterion_index);
    const seenChecks = new Set<number>();
    for (let checkIndex = 0; checkIndex < mapping.check_indices.length; checkIndex += 1) {
      const referencedCheck = mapping.check_indices[checkIndex]!;
      if (referencedCheck >= value.checks.length) {
        context.addIssue({
          code: "custom",
          path: ["criterion_check_mapping", mappingIndex, "check_indices", checkIndex],
          message: `check index ${referencedCheck} does not reference a validation check`,
        });
      }
      if (seenChecks.has(referencedCheck)) {
        context.addIssue({
          code: "custom",
          path: ["criterion_check_mapping", mappingIndex, "check_indices", checkIndex],
          message: `check index ${referencedCheck} is duplicated for criterion ${mapping.criterion_index}`,
        });
      }
      seenChecks.add(referencedCheck);
    }
  }
}

export const TaskContractSchema = z.object(TaskContractShape)
  .strict()
  .superRefine(validateCriterionCheckMapping);

export type TaskContract = z.infer<typeof TaskContractSchema>;

export const TaskSpecSchema = z.object({
  ...TaskContractShape,
  id: z.string().min(1),
  requirement: z.string().min(1),
  repository_path: z.string().min(1),
  worktree_path: z.string().min(1),
  base_sha: z.string().min(1),
  branch: z.string().min(1),
  max_revision_rounds: z.number().int().min(0),
  client_request_id: ClientRequestIdSchema.optional(),
}).strict().superRefine(validateCriterionCheckMapping);

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
