import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import { ParallelPlanSchema, type ParallelPlan } from "../parallel-types.js";
import { assertProcessSucceeded, runProcess } from "../process.js";
import {
  LeaderPlanSchema,
  ReviewResultSchema,
  type CheckResult,
  type LeaderPlan,
  type ReviewRunResult,
  type TaskSpec,
} from "../types.js";

export interface Planner {
  plan(requirement: string, repositoryPath: string, jobDirectory: string): Promise<LeaderPlan>;
}

export interface ParallelPlanner {
  planParallel(requirement: string, repositoryPath: string, runDirectory: string): Promise<ParallelPlan>;
}

export interface Reviewer {
  review(task: TaskSpec, checks: CheckResult[], jobDirectory: string): Promise<ReviewRunResult>;
}

function parseJsonDocument(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} returned empty structured output`);
  }

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${String(error)}`);
  }
}

function codexModelArgs(
  model: string | undefined,
  config: HarnessConfig["codex"],
): string[] {
  const args: string[] = [];
  if (model) {
    args.push("--model", model);
  }
  if (config.provider) {
    args.push("-c", `model_provider=${JSON.stringify(config.provider)}`);
    if (config.providerBaseUrl) {
      const prefix = `model_providers.${config.provider}`;
      args.push(
        "-c", `${prefix}.name=${JSON.stringify("9Router")}`,
        "-c", `${prefix}.base_url=${JSON.stringify(config.providerBaseUrl)}`,
        "-c", `${prefix}.wire_api=${JSON.stringify("responses")}`,
        "-c", `${prefix}.supports_websockets=false`,
      );
      if (config.providerAuth) {
        args.push(
          "-c", `${prefix}.auth.command=${JSON.stringify(config.providerAuth.command)}`,
          "-c", `${prefix}.auth.args=${JSON.stringify(config.providerAuth.args)}`,
          "-c", `${prefix}.auth.timeout_ms=5000`,
          "-c", `${prefix}.auth.refresh_interval_ms=0`,
        );
      }
    }
  }
  args.push("-c", `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`);
  return args;
}

async function persistProcessLogs(
  directory: string,
  prefix: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  await Promise.all([
    writeFile(path.join(directory, `${prefix}.stdout.jsonl`), stdout, "utf8"),
    writeFile(path.join(directory, `${prefix}.stderr.log`), stderr, "utf8"),
  ]);
}

export class CodexAdapter implements Planner, ParallelPlanner, Reviewer {
  constructor(
    private readonly config: HarnessConfig["codex"],
    private readonly harnessRoot: string,
  ) {}

  async plan(requirement: string, repositoryPath: string, jobDirectory: string): Promise<LeaderPlan> {
    await mkdir(jobDirectory, { recursive: true });
    const promptTemplate = await readFile(path.join(this.harnessRoot, "prompts", "leader.md"), "utf8");
    const outputPath = path.join(jobDirectory, "leader-plan.json");
    const schemaPath = path.join(this.harnessRoot, "schemas", "leader-plan.schema.json");
    const prompt = `${promptTemplate}\n\nUser requirement:\n${requirement}\n`;

    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      ...codexModelArgs(this.config.leaderModel, this.config),
      "-",
    ];

    const processResult = await runProcess(this.config.command, args, {
      cwd: repositoryPath,
      stdin: prompt,
      timeoutMs: this.config.timeoutMs,
    });
    await persistProcessLogs(jobDirectory, "leader", processResult.stdout, processResult.stderr);
    assertProcessSucceeded(processResult, "Codex leader");

    const raw = await readFile(outputPath, "utf8");
    return LeaderPlanSchema.parse(parseJsonDocument(raw, "Codex leader"));
  }

  async planParallel(
    requirement: string,
    repositoryPath: string,
    runDirectory: string,
  ): Promise<ParallelPlan> {
    await mkdir(runDirectory, { recursive: true });
    const promptTemplate = await readFile(
      path.join(this.harnessRoot, "prompts", "parallel-leader.md"),
      "utf8",
    );
    const outputPath = path.join(runDirectory, "parallel-plan.json");
    const schemaPath = path.join(this.harnessRoot, "schemas", "parallel-plan.schema.json");
    const prompt = `${promptTemplate}\n\nUser requirement:\n${requirement}\n`;
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      ...codexModelArgs(this.config.leaderModel, this.config),
      "-",
    ];
    const processResult = await runProcess(this.config.command, args, {
      cwd: repositoryPath,
      stdin: prompt,
      timeoutMs: this.config.timeoutMs,
    });
    await persistProcessLogs(runDirectory, "parallel-leader", processResult.stdout, processResult.stderr);
    assertProcessSucceeded(processResult, "Codex parallel leader");
    const raw = await readFile(outputPath, "utf8");
    return ParallelPlanSchema.parse(parseJsonDocument(raw, "Codex parallel leader"));
  }

  async review(task: TaskSpec, checks: CheckResult[], jobDirectory: string): Promise<ReviewRunResult> {
    const promptTemplate = await readFile(path.join(this.harnessRoot, "prompts", "reviewer.md"), "utf8");
    const outputPath = path.join(jobDirectory, `review-${Date.now()}.json`);
    const schemaPath = path.join(this.harnessRoot, "schemas", "review-result.schema.json");
    const checkEvidence = checks.map((check) => ({
      command: [check.command, ...check.args],
      passed: check.passed,
      exitCode: check.exitCode,
      stdout: check.stdout.slice(-4000),
      stderr: check.stderr.slice(-4000),
    }));
    const prompt = [
      promptTemplate,
      "",
      "Task contract:",
      JSON.stringify(task, null, 2),
      "",
      "Validation evidence:",
      JSON.stringify(checkEvidence, null, 2),
    ].join("\n");

    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      ...codexModelArgs(this.config.reviewerModel, this.config),
      "-",
    ];

    const processResult = await runProcess(this.config.command, args, {
      cwd: task.worktree_path,
      stdin: prompt,
      timeoutMs: this.config.timeoutMs,
    });
    await persistProcessLogs(jobDirectory, `review-${Date.now()}`, processResult.stdout, processResult.stderr);
    assertProcessSucceeded(processResult, "Codex reviewer");

    const raw = await readFile(outputPath, "utf8");
    return {
      result: ReviewResultSchema.parse(parseJsonDocument(raw, "Codex reviewer")),
      process: processResult,
    };
  }
}
