import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AntigravityAdapter } from "../dist/adapters/antigravity.js";
import { loadConfig } from "../dist/config.js";
import { InteractiveDelegationService } from "../dist/interactive-delegation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ai-dev-team-smoke-"));
const repositoryPath = path.join(temporaryRoot, "target-repository");
const dataDirectory = path.join(temporaryRoot, "harness-artifacts");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitForTerminal(service, workerId) {
  const activeStates = new Set(["PREPARING", "WORKER_RUNNING", "CHECKING"]);
  const deadline = Date.now() + 25 * 60 * 1000;
  let previous;
  while (Date.now() < deadline) {
    const snapshot = await service.getStatus(workerId);
    if (snapshot.state !== previous) {
      console.log(`[smoke] ${snapshot.state}: ${snapshot.message}`);
      previous = snapshot.state;
    }
    if (!activeStates.has(snapshot.state)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Worker ${workerId} did not finish within 25 minutes`);
}

try {
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(path.join(repositoryPath, "README.md"), "Smoke fixture\n", "utf8");
  git(repositoryPath, ["init"]);
  git(repositoryPath, ["config", "user.email", "smoke@example.com"]);
  git(repositoryPath, ["config", "user.name", "AI Dev Team Smoke"]);
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "-m", "smoke fixture"]);

  const baseConfig = await loadConfig(path.join(projectRoot, "harness.config.json"));
  const config = { ...baseConfig, dataDirectory };
  const worker = new AntigravityAdapter(config.antigravity, projectRoot);
  const service = new InteractiveDelegationService(config, projectRoot, worker);
  await service.initialize();

  const initialHead = git(repositoryPath, ["rev-parse", "HEAD"]);
  const started = await service.delegate({
    repository_path: repositoryPath,
    objective: "Create src/result.txt containing exactly the line 'first pass'. Do not modify any other file.",
    allowed_paths: ["src/**"],
    acceptance_criteria: [
      "src/result.txt exists",
      "The first line is exactly 'first pass'",
      "No file outside src/** is changed",
    ],
    checks: [{
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs');const lines=fs.readFileSync('src/result.txt','utf8').trim().split(/\\r?\\n/);if(lines[0]!=='first pass'||lines.length>2||(lines[1]&&lines[1]!=='revision complete'))process.exit(1)",
      ],
    }],
    worker_instructions: "Make the smallest possible implementation. Create only src/result.txt.",
  });

  let terminal = await waitForTerminal(service, started.id);
  if (terminal.state === "WAITING_FOR_REVISION") {
    await service.requestRevision(
      started.id,
      `Fix the harness gate failure and keep the change inside src/**. Gate feedback:\n${terminal.message}`,
    );
    terminal = await waitForTerminal(service, started.id);
  }
  assert.equal(terminal.state, "COMPLETED", terminal.message);

  assert.ok(
    terminal.revision_round < terminal.max_revision_rounds,
    "No revision budget remains for the review-revision smoke step",
  );
  await service.requestRevision(
    started.id,
    "Codex review requests one bounded revision: append a second line containing exactly 'revision complete'. Keep the first line unchanged and modify no other file.",
  );
  terminal = await waitForTerminal(service, started.id);
  assert.equal(terminal.state, "COMPLETED", terminal.message);
  assert.equal(terminal.worker_result?.conversation_id !== undefined, true);

  const diff = await service.getDiff(started.id);
  assert.match(diff.diff, /first pass/);
  assert.match(diff.diff, /revision complete/);
  assert.deepEqual(diff.changed_files, ["src/result.txt"]);
  assert.equal(git(repositoryPath, ["rev-parse", "HEAD"]), initialHead);
  assert.equal(git(repositoryPath, ["status", "--porcelain"]), "");

  const handoff = await service.prepareCherryPick(started.id);
  assert.equal(git(repositoryPath, ["rev-parse", "HEAD"]), initialHead);
  const cherryPick = spawnSync(handoff.argv[0], handoff.argv.slice(1), {
    cwd: repositoryPath,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(cherryPick.status, 0, cherryPick.stderr || cherryPick.stdout);
  assert.notEqual(git(repositoryPath, ["rev-parse", "HEAD"]), initialHead);
  assert.equal(
    (await readFile(path.join(repositoryPath, "src", "result.txt"), "utf8"))
      .replace(/\r\n/g, "\n")
      .trim(),
    "first pass\nrevision complete",
  );
  console.log(`[smoke] PASS worker=${started.id} commit=${handoff.commit_sha}`);
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedOsTemp = path.resolve(os.tmpdir());
  if (!resolvedTemporaryRoot.startsWith(`${resolvedOsTemp}${path.sep}`)) {
    throw new Error(`Refusing to clean unexpected path: ${resolvedTemporaryRoot}`);
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
