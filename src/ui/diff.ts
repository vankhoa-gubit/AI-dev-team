import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../process.js";
import type { ParallelRunSummary } from "../parallel-types.js";

export const DEFAULT_MAX_DIFF_BYTES = 256 * 1024; // 256 KB
export const DEFAULT_MAX_DIFF_LINES = 2000;

export interface BoundedDiffResult {
  diff: string;
  truncated: boolean;
}

export function boundDiff(
  rawDiff: string,
  maxBytes = DEFAULT_MAX_DIFF_BYTES,
  maxLines = DEFAULT_MAX_DIFF_LINES,
): BoundedDiffResult {
  const lines = rawDiff.split(/\r?\n/);
  let truncated = false;
  let byteCount = 0;
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (i >= maxLines || byteCount + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    byteCount += lineBytes;
    resultLines.push(line);
  }

  if (truncated) {
    resultLines.push("", "[diff truncated: maximum size limit reached]");
  }

  return {
    diff: resultLines.join("\n"),
    truncated,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getBoundedIntegrationDiff(
  runDirectory: string,
  options: { maxBytes?: number; maxLines?: number } = {},
): Promise<BoundedDiffResult | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_DIFF_LINES;

  // 1. Check for standalone patch files in run directory
  for (const candidate of ["integration-diff.patch", "integration-diff.txt", "diff.patch"]) {
    const candidatePath = path.join(runDirectory, candidate);
    if (await pathExists(candidatePath)) {
      const raw = await readFile(candidatePath, "utf8");
      return boundDiff(raw, maxBytes, maxLines);
    }
  }

  // 2. Check status.json for repository and worktree details
  const statusPath = path.join(runDirectory, "status.json");
  if (!(await pathExists(statusPath))) {
    return null;
  }

  let summary: ParallelRunSummary;
  try {
    const raw = await readFile(statusPath, "utf8");
    summary = JSON.parse(raw);
  } catch {
    return null;
  }

  const { repositoryPath, baseSha, integrationCommitSha, integrationWorktreePath } = summary;

  // 3. Try running git diff in the integration worktree if it exists
  if (integrationWorktreePath && (await pathExists(integrationWorktreePath))) {
    const args = baseSha
      ? (integrationCommitSha ? ["diff", baseSha, integrationCommitSha] : ["diff", baseSha])
      : ["diff", "HEAD~1"];
    try {
      const result = await runProcess("git", args, {
        cwd: integrationWorktreePath,
        timeoutMs: 15_000,
      });
      if (result.exitCode === 0) {
        return boundDiff(result.stdout, maxBytes, maxLines);
      }
    } catch {
      // Fall through
    }
  }

  // 4. Try running git diff in the main repository if commits exist
  if (repositoryPath && (await pathExists(repositoryPath)) && baseSha && integrationCommitSha) {
    try {
      const result = await runProcess("git", ["diff", baseSha, integrationCommitSha], {
        cwd: repositoryPath,
        timeoutMs: 15_000,
      });
      if (result.exitCode === 0) {
        return boundDiff(result.stdout, maxBytes, maxLines);
      }
    } catch {
      // Fall through
    }
  }

  return null;
}
