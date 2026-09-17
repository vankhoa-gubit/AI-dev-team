import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HarnessConfig } from "../config.js";
import { assertProcessSucceeded, runProcess } from "../process.js";
import {
  WorkerResultSchema,
  type TaskSpec,
  type WorkerResult,
  type WorkerRunResult,
} from "../types.js";

export interface Worker {
  run(
    task: TaskSpec,
    jobDirectory: string,
    revisionFeedback?: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<WorkerRunResult>;
}

const AntigravityEnvelopeSchema = z.object({
  conversation_id: z.string().min(1).optional(),
  status: z.string().optional(),
  response: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  denied_actions: z.array(z.unknown()).optional(),
}).passthrough();

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!trimmed) {
    return undefined;
  }
  return JSON.parse(trimmed);
}

export function parseAntigravityOutput(raw: string): WorkerResult {
  if (!raw.trim()) {
    throw new Error("Antigravity returned empty output");
  }

  const envelope = AntigravityEnvelopeSchema.parse(JSON.parse(raw));
  const deniedActions = envelope.denied_actions ?? [];
  if (deniedActions.length > 0) {
    throw new Error(`Antigravity denied required actions: ${JSON.stringify(deniedActions)}`);
  }

  if (envelope.status && envelope.status.toUpperCase() !== "SUCCESS") {
    throw new Error(`Antigravity returned status ${envelope.status}`);
  }

  let structured: unknown;
  try {
    structured = parseJsonValue(envelope.structured_output);
    if (structured === undefined) {
      structured = parseJsonValue(envelope.response);
    }
  } catch (error) {
    throw new Error(`Antigravity returned invalid structured JSON: ${String(error)}`);
  }

  if (structured === undefined) {
    throw new Error("Antigravity reported success but returned empty structured output");
  }

  const result = WorkerResultSchema.parse(structured);
  return envelope.conversation_id
    ? { ...result, conversation_id: envelope.conversation_id }
    : result;
}

export class AntigravityAdapter implements Worker {
  constructor(
    private readonly config: HarnessConfig["antigravity"],
    private readonly harnessRoot: string,
  ) {}

  async run(
    task: TaskSpec,
    jobDirectory: string,
    revisionFeedback?: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<WorkerRunResult> {
    const promptTemplate = await readFile(path.join(this.harnessRoot, "prompts", "worker.md"), "utf8");
    const taskPath = path.join(jobDirectory, "task.json");
    const schemaPath = path.join(this.harnessRoot, "schemas", "worker-result.schema.json");
    const promptParts = [
      promptTemplate,
      "",
      `Read the task contract at @${taskPath} and implement it now.`,
    ];
    if (revisionFeedback) {
      promptParts.push("", "Revision feedback:", revisionFeedback);
    }

    const args = [
      "--print",
      promptParts.join("\n"),
      "--sandbox",
      "--output-format",
      "json",
      "--json-schema",
      schemaPath,
      "--mode",
      "accept-edits",
      "--effort",
      this.config.effort,
      "--print-timeout",
      `${Math.ceil(this.config.timeoutMs / 1000)}s`,
      "--add-dir",
      task.worktree_path,
      "--add-dir",
      jobDirectory,
    ];
    if (this.config.model) {
      args.push("--model", this.config.model);
    }
    if (conversationId) {
      args.push("--conversation", conversationId);
    }

    const runNumber = Date.now();
    const processResult = await runProcess(this.config.command, args, {
      cwd: task.worktree_path,
      timeoutMs: this.config.timeoutMs + 30_000,
      ...(signal ? { signal } : {}),
    });
    await Promise.all([
      writeFile(path.join(jobDirectory, `worker-${runNumber}.stdout.json`), processResult.stdout, "utf8"),
      writeFile(path.join(jobDirectory, `worker-${runNumber}.stderr.log`), processResult.stderr, "utf8"),
    ]);
    assertProcessSucceeded(processResult, "Antigravity worker");

    return {
      result: parseAntigravityOutput(processResult.stdout),
      process: processResult,
    };
  }
}
