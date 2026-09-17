import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertProcessSucceeded, runProcess } from "./process.js";
import type { ProcessResult } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;

async function git(repoPath: string, args: string[]) {
  return await runProcess("git", args, { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
}

export async function assertGitRepository(repoPath: string): Promise<void> {
  const result = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  assertProcessSucceeded(result, "git repository check");
  if (result.stdout.trim() !== "true") {
    throw new Error(`Not a Git working tree: ${repoPath}`);
  }
}

export async function assertCleanRepository(repoPath: string): Promise<void> {
  const result = await git(repoPath, ["status", "--porcelain"]);
  assertProcessSucceeded(result, "git status");
  if (result.stdout.trim()) {
    throw new Error("Target repository has uncommitted changes; commit or stash them before running the harness");
  }
}

export async function getHeadSha(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["rev-parse", "HEAD"]);
  assertProcessSucceeded(result, "git rev-parse HEAD");
  return result.stdout.trim();
}

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const result = await git(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
  assertProcessSucceeded(result, "git worktree add");
}

export async function commitAll(worktreePath: string, message: string): Promise<string> {
  const add = await git(worktreePath, ["add", "--all"]);
  assertProcessSucceeded(add, "git add");
  const commit = await git(worktreePath, ["commit", "--no-gpg-sign", "-m", message]);
  assertProcessSucceeded(commit, "git commit");
  return await getHeadSha(worktreePath);
}

export async function applyCommitWithoutCommit(
  worktreePath: string,
  commitSha: string,
): Promise<ProcessResult> {
  return await git(worktreePath, ["cherry-pick", "--no-commit", commitSha]);
}

export async function listUnmergedFiles(worktreePath: string): Promise<string[]> {
  const result = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  assertProcessSucceeded(result, "git list conflicts");
  return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

export async function listChangedFiles(worktreePath: string): Promise<string[]> {
  const result = await git(worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "-z",
  ]);
  assertProcessSucceeded(result, "git status in worktree");

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const filePart = entry.slice(3);
      const renameSeparator = filePart.indexOf(" -> ");
      const normalized = renameSeparator >= 0 ? filePart.slice(renameSeparator + 4) : filePart;
      return normalized.replaceAll("\\", "/");
    });
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
    }
  }
  source += "$";
  return new RegExp(source);
}

export function findOutOfScopeFiles(files: string[], allowedPaths: string[]): string[] {
  const patterns = allowedPaths.map(globToRegExp);
  return files.filter((file) => !patterns.some((pattern) => pattern.test(file)));
}
