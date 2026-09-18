import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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

const DelegationConfigSchema = z.object({
  maxConcurrentWorkers: z.number().int().min(1).max(8).default(3),
  maxDiffBytes: z.number().int().positive().max(2 * 1024 * 1024).default(256 * 1024),
  maxDiffLines: z.number().int().positive().max(20_000).default(2_000),
}).strict();

export const HarnessConfigSchema = z.object({
  dataDirectory: z.string().min(1).default(".harness"),
  maxRevisionRounds: z.number().int().min(0).default(2),
  requireCleanRepository: z.boolean().default(true),
  antigravity: AntigravityConfigSchema,
  validation: ValidationConfigSchema,
  delegation: DelegationConfigSchema,
}).strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  return HarnessConfigSchema.parse(JSON.parse(raw));
}
