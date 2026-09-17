import { spawn } from "node:child_process";
import path from "node:path";
import type { ProcessResult } from "./types.js";

export interface RunProcessOptions {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function executableCandidates(command: string): string[] {
  if (process.platform !== "win32" || path.extname(command)) {
    return [command];
  }

  return [command, `${command}.exe`, `${command}.cmd`];
}

async function canStart(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.kill();
      resolve(true);
    });
  });
}

export async function resolveExecutable(command: string): Promise<string> {
  if (path.isAbsolute(command)) {
    return command;
  }

  for (const candidate of executableCandidates(command)) {
    if (await canStart(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Executable not found or could not be started: ${command}`);
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    throw new Error(`Process cancelled before start: ${command}`);
  }
  const resolvedCommand = await resolveExecutable(command);
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const abort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        command: resolvedCommand,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export function assertProcessSucceeded(result: ProcessResult, label: string): void {
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${result.durationMs}ms`);
  }
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`${label} exited with code ${String(result.exitCode)}: ${details}`);
  }
}
