import path from "node:path";
import type { HarnessConfig } from "./config.js";
import { runProcess } from "./process.js";
import type { CheckResult, ValidationCommand } from "./types.js";

function normalizedExecutable(command: string): string {
  return path.basename(command).toLowerCase();
}

export function assertAllowedValidationCommand(
  check: ValidationCommand,
  allowedExecutables: string[],
): void {
  const allowed = new Set(allowedExecutables.map((entry) => entry.toLowerCase()));
  if (!allowed.has(normalizedExecutable(check.command))) {
    throw new Error(`Validation executable is not allowed: ${check.command}`);
  }
}

export async function runValidationChecks(
  checks: ValidationCommand[],
  worktreePath: string,
  config: HarnessConfig["validation"],
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    assertAllowedValidationCommand(check, config.allowedExecutables);
    const result = await runProcess(check.command, check.args, {
      cwd: worktreePath,
      timeoutMs: config.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    results.push({
      ...result,
      passed: !result.timedOut && result.exitCode === 0,
    });
  }
  return results;
}

export function formatCheckFailures(checks: CheckResult[]): string {
  return checks
    .filter((check) => !check.passed)
    .map((check) => [
      `Command: ${[check.command, ...check.args].join(" ")}`,
      `Exit code: ${String(check.exitCode)}`,
      `Timed out: ${String(check.timedOut)}`,
      `stdout:\n${check.stdout.slice(-4000)}`,
      `stderr:\n${check.stderr.slice(-4000)}`,
    ].join("\n"))
    .join("\n\n");
}
