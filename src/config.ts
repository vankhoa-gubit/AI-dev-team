import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const CodexConfigSchema = z.object({
  command: z.string().min(1).default("codex"),
  provider: z.string().min(1).optional(),
  providerBaseUrl: z.string().url().optional(),
  providerAuth: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
  }).strict().optional(),
  leaderModel: z.string().min(1).optional(),
  reviewerModel: z.string().min(1).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
  timeoutMs: z.number().int().positive().default(1_200_000),
}).strict();

const AntigravityConfigSchema = z.object({
  command: z.string().min(1).default("agy"),
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high"]).default("high"),
  timeoutMs: z.number().int().positive().default(1_200_000),
}).strict();

const ValidationConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(600_000),
  allowedExecutables: z.array(z.string().min(1)).min(1),
}).strict();

const RouterConfigSchema = z.object({
  baseUrl: z.string().url().default("http://127.0.0.1:20128/v1"),
  required: z.boolean().default(true),
}).strict();

const ParallelConfigSchema = z.object({
  maxWorkers: z.number().int().min(1).max(8).default(3),
  maxTasks: z.number().int().min(2).max(16).default(8),
}).strict();

export const HarnessConfigSchema = z.object({
  dataDirectory: z.string().min(1).default(".harness"),
  maxRevisionRounds: z.number().int().min(0).default(2),
  requireCleanRepository: z.boolean().default(true),
  router: RouterConfigSchema,
  codex: CodexConfigSchema,
  antigravity: AntigravityConfigSchema,
  validation: ValidationConfigSchema,
  parallel: ParallelConfigSchema,
}).strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  return HarnessConfigSchema.parse(JSON.parse(raw));
}
