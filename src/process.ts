import { spawn } from "node:child_process";
import path from "node:path";
import type { ProcessResult } from "./types.js";

export interface RunProcessOptions {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onStderrChunk?: (chunk: string) => void | Promise<void>;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes ? value : bytes.subarray(bytes.length - maxBytes).toString("utf8");
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
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdoutQueue = Promise.resolve();
    let stderrQueue = Promise.resolve();
    const maxStdout = options.maxStdoutBytes ?? (options.onStdoutChunk ? 64 * 1024 : 10 * 1024 * 1024);
    const maxStderr = options.maxStderrBytes ?? 64 * 1024;

    const cleanupResources = () => {
      try {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // Ignore errors during stream cleanup
      }
    };

    const abort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill errors if already exited
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const failure = error instanceof Error ? error : new Error(String(error));
      let rejected = false;
      const rejectAfterClose = () => {
        if (rejected) return;
        rejected = true;
        cleanupResources();
        reject(failure);
      };
      child.once("close", rejectAfterClose);
      abort();
      cleanupResources();
      const fallback = setTimeout(rejectAfterClose, 1_000);
      fallback.unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (options.onStdoutChunk) {
        child.stdout.pause();
        stdoutQueue = stdoutQueue
          .then(async () => await options.onStdoutChunk?.(chunk))
          .then(() => {
            if (!settled) child.stdout.resume();
          });
        void stdoutQueue.catch(fail);
      }
      const remainingStdoutBytes = maxStdout - Buffer.byteLength(stdout, "utf8");
      if (remainingStdoutBytes > 0) {
        stdout += utf8Prefix(chunk, remainingStdoutBytes);
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (options.onStderrChunk) {
        child.stderr.pause();
        stderrQueue = stderrQueue
          .then(async () => await options.onStderrChunk?.(chunk))
          .then(() => {
            if (!settled) child.stderr.resume();
          });
        void stderrQueue.catch(fail);
      }
      stderr = utf8Tail(stderr + chunk, maxStderr);
    });

    child.once("error", (error) => {
      fail(error);
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }, options.timeoutMs);

    child.once("close", (exitCode, signal) => {
      void Promise.all([stdoutQueue, stderrQueue]).then(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        cleanupResources();
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
      }).catch(fail);
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
