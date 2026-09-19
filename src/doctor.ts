import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter, type Worker } from "./adapters/antigravity.js";
import type { HarnessConfig } from "./config.js";
import { InteractiveDelegationService } from "./interactive-delegation.js";
import { assertProcessSucceeded, resolveExecutable, runProcess } from "./process.js";

const EXPECTED_CONTENT = "antigravity deep doctor ok\n";
const FIXTURE_FILE = "doctor/antigravity.txt";

export type DoctorFailureCategory =
  | "cli_not_found"
  | "auth_or_model_unavailable"
  | "permission_denied"
  | "malformed_output"
  | "empty_output"
  | "process_start_failure"
  | "timeout"
  | "scope_violation"
  | "validation_failure"
  | "worker_no_change"
  | "conversation_missing"
  | "provider_error"
  | "cleanup_failure"
  | "unknown";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DeepDoctorReport {
  run_id: string;
  mode: "deep";
  ok: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  failure_category?: DoctorFailureCategory;
  error?: string;
  worker_id?: string;
  conversation_id?: string;
  checks: DoctorCheck[];
  artifact_directory: string;
  artifact_manifest: string[];
  fixture_removed: boolean;
}

export interface DeepDoctorOptions {
  worker?: Worker;
  artifactRoot?: string;
  temporaryParent?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyDoctorFailure(error: unknown): DoctorFailureCategory {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("cleanup") || message.includes("worktree remove") || message.includes("worktree still exists")) {
    return "cleanup_failure";
  }
  if (message.includes("executable not found") || message.includes("could not be started")) {
    return "cli_not_found";
  }
  if (
    message.includes("authentication")
    || message.includes("unauthorized")
    || message.includes("forbidden")
    || message.includes("model not found")
    || message.includes("model unavailable")
    || message.includes("not entitled")
  ) {
    return "auth_or_model_unavailable";
  }
  if (message.includes("denied required actions") || message.includes("permission denied")) {
    return "permission_denied";
  }
  if (message.includes("empty output") || message.includes("empty structured output")) {
    return "empty_output";
  }
  if (
    message.includes("invalid structured json")
    || message.includes("invalid json")
    || message.includes("zoderror")
  ) {
    return "malformed_output";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("out-of-scope") || message.includes("outside allowed")) {
    return "scope_violation";
  }
  if (message.includes("validation") || message.includes("check failed")) {
    return "validation_failure";
  }
  if (message.includes("no changes") || message.includes("made no change")) {
    return "worker_no_change";
  }
  if (message.includes("conversation_id") || message.includes("conversation id")) {
    return "conversation_missing";
  }
  if (message.includes("spawn") || message.includes("process cancelled before start")) {
    return "process_start_failure";
  }
  if (message.includes("antigravity") || message.includes("provider")) {
    return "provider_error";
  }
  return "unknown";
}

export async function runPrerequisiteChecks(config: HarnessConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [name, command] of [
    ["Antigravity CLI", config.antigravity.command],
    ["Git", "git"],
  ] as const) {
    try {
      const resolved = await resolveExecutable(command);
      checks.push({ name, ok: true, detail: resolved });
    } catch (error) {
      checks.push({ name, ok: false, detail: errorMessage(error) });
    }
  }
  return checks;
}

function validationCommand(config: HarnessConfig): string {
  const configured = new Map(
    config.validation.allowedExecutables.map((entry) => [entry.toLowerCase(), entry]),
  );
  const command = configured.get("node") ?? configured.get("node.exe");
  if (!command) {
    throw new Error("Deep doctor validation requires node or node.exe in validation.allowedExecutables");
  }
  return command;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 60_000 });
  assertProcessSucceeded(result, `git ${args[0] ?? "command"}`);
}

async function createFixture(repositoryPath: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(path.join(repositoryPath, "README.md"), "AI Dev Team deep doctor fixture\n", "utf8");
  await git(repositoryPath, ["init"]);
  await git(repositoryPath, ["config", "user.email", "deep-doctor@example.invalid"]);
  await git(repositoryPath, ["config", "user.name", "AI Dev Team Deep Doctor"]);
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, ["commit", "--no-gpg-sign", "-m", "deep doctor fixture"]);
}

async function copyRawArtifacts(sourceDirectory: string, targetDirectory: string): Promise<string[]> {
  const copied: string[] = [];
  try {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    await mkdir(targetDirectory, { recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const destination = path.join(targetDirectory, entry.name);
      await copyFile(path.join(sourceDirectory, entry.name), destination);
      copied.push(path.posix.join("raw", entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return copied.sort();
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function assertDisposablePath(temporaryRoot: string, temporaryParent: string): void {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolvedParent = path.resolve(temporaryParent);
  const rootForComparison = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const parentForComparison = process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent;
  if (!rootForComparison.startsWith(`${parentForComparison}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected deep doctor fixture: ${resolvedRoot}`);
  }
}

async function writeReport(report: DeepDoctorReport): Promise<void> {
  await mkdir(report.artifact_directory, { recursive: true });
  await writeFile(
    path.join(report.artifact_directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

export async function runDeepDoctor(
  config: HarnessConfig,
  harnessRoot: string,
  options: DeepDoctorOptions = {},
): Promise<DeepDoctorReport> {
  const startedAtMs = Date.now();
  const runId = `doctor-${new Date(startedAtMs).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactDirectory = path.resolve(
    options.artifactRoot ?? path.join(harnessRoot, config.dataDirectory, "doctor", runId),
  );
  const temporaryParent = path.resolve(options.temporaryParent ?? os.tmpdir());
  await mkdir(temporaryParent, { recursive: true });

  const report: DeepDoctorReport = {
    run_id: runId,
    mode: "deep",
    ok: false,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(startedAtMs).toISOString(),
    duration_ms: 0,
    checks: [],
    artifact_directory: artifactDirectory,
    artifact_manifest: ["report.json"],
    fixture_removed: false,
  };

  let temporaryRoot: string | undefined;
  let workerId: string | undefined;
  let delegationDirectory: string | undefined;
  try {
    report.checks.push(...await runPrerequisiteChecks(config));
    const failedPrerequisite = report.checks.find((check) => !check.ok);
    if (failedPrerequisite) {
      throw new Error(failedPrerequisite.detail);
    }

    temporaryRoot = await mkdtemp(path.join(temporaryParent, "ai-dev-team-doctor-"));
    const repositoryPath = path.join(temporaryRoot, "target-repository");
    const runtimeDirectory = path.join(temporaryRoot, "runtime");
    await createFixture(repositoryPath);
    report.checks.push({ name: "Disposable Git fixture", ok: true, detail: repositoryPath });

    const worker = options.worker ?? new AntigravityAdapter(config.antigravity, harnessRoot);
    const service = new InteractiveDelegationService(
      { ...config, dataDirectory: runtimeDirectory },
      harnessRoot,
      worker,
    );
    await service.initialize();
    const nodeCommand = validationCommand(config);
    const started = await service.delegate({
      repository_path: repositoryPath,
      objective: `Create ${FIXTURE_FILE} containing exactly one line: antigravity deep doctor ok`,
      allowed_paths: ["doctor/**"],
      acceptance_criteria: [
        `${FIXTURE_FILE} exists`,
        `${FIXTURE_FILE} contains exactly the expected line`,
        "No file outside doctor/** is changed",
      ],
      checks: [{
        command: nodeCommand,
        args: [
          "-e",
          `const fs=require('node:fs');if(fs.readFileSync('${FIXTURE_FILE}','utf8')!==${JSON.stringify(EXPECTED_CONTENT)})process.exit(1)`,
        ],
      }],
      worker_instructions: `Create only ${FIXTURE_FILE}. Its complete content must be exactly: ${EXPECTED_CONTENT.trimEnd()}`,
      client_request_id: runId,
    });
    workerId = started.id;
    report.worker_id = workerId;
    delegationDirectory = path.join(runtimeDirectory, "delegations", workerId);

    const waited = await service.waitForWorker(workerId, config.antigravity.timeoutMs + 120_000);
    if (waited.timed_out) {
      await service.cancel(workerId);
      throw new Error(`Deep doctor timed out while waiting for worker ${workerId}`);
    }
    if (waited.snapshot.state !== "COMPLETED") {
      throw new Error(`Deep doctor worker ended in ${waited.snapshot.state}: ${waited.snapshot.message}`);
    }
    report.checks.push({
      name: "Antigravity execution",
      ok: true,
      detail: `worker=${workerId}`,
    });

    const actual = await readFile(path.join(waited.snapshot.worktree_path, FIXTURE_FILE), "utf8");
    if (actual !== EXPECTED_CONTENT) {
      throw new Error(`Deep doctor validation failed: ${FIXTURE_FILE} did not contain the expected text`);
    }
    report.checks.push({ name: "Read/write and validation", ok: true, detail: FIXTURE_FILE });

    const conversationId = waited.snapshot.worker_result?.conversation_id;
    if (!conversationId) {
      throw new Error("Deep doctor result is missing conversation_id");
    }
    report.conversation_id = conversationId;
    report.checks.push({ name: "Structured output and conversation", ok: true, detail: conversationId });

    await service.prepareCherryPick(workerId);
    const cleanup = await service.previewCleanup(workerId);
    if (!cleanup.confirmation_token) {
      throw new Error(`Deep doctor cleanup was blocked: ${cleanup.blockers.join("; ")}`);
    }
    try {
      await service.cleanupWorker(workerId, cleanup.confirmation_token);
    } catch (error) {
      throw new Error(`Deep doctor cleanup failed: ${errorMessage(error)}`);
    }
    report.checks.push({ name: "Handoff and worktree cleanup", ok: true, detail: "completed" });
    report.ok = true;
  } catch (error) {
    report.error = errorMessage(error);
    report.failure_category = classifyDoctorFailure(error);
    report.checks.push({
      name: "Deep doctor outcome",
      ok: false,
      detail: report.error,
    });
  } finally {
    try {
      if (delegationDirectory) {
        const copied = await copyRawArtifacts(delegationDirectory, path.join(artifactDirectory, "raw"));
        report.artifact_manifest.push(...copied);
      }
    } catch (error) {
      report.ok = false;
      report.failure_category ??= "unknown";
      report.error = `${report.error ? `${report.error}; ` : ""}Could not preserve raw artifacts: ${errorMessage(error)}`;
    }

    if (temporaryRoot) {
      try {
        assertDisposablePath(temporaryRoot, temporaryParent);
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        report.fixture_removed = !await pathExists(temporaryRoot);
      } catch (error) {
        report.ok = false;
        report.fixture_removed = false;
        report.failure_category = "cleanup_failure";
        report.error = `${report.error ? `${report.error}; ` : ""}Fixture cleanup failed: ${errorMessage(error)}`;
      }
    } else {
      report.fixture_removed = true;
    }

    const finishedAtMs = Date.now();
    report.finished_at = new Date(finishedAtMs).toISOString();
    report.duration_ms = finishedAtMs - startedAtMs;
    await writeReport(report);
  }

  return report;
}
