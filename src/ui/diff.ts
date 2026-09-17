import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../process.js";

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

function isValidGitRef(ref: unknown): ref is string {
  return (
    typeof ref === "string" &&
    ref.length >= 1 &&
    ref.length <= 128 &&
    /^[a-zA-Z0-9._~^/-]+$/.test(ref) &&
    !ref.startsWith("-")
  );
}

export async function getValidatedChildWorktree(
  parentDir: string,
  candidateChild: string,
): Promise<string | null> {
  try {
    const realParent = await realpath(path.resolve(parentDir));
    const resolvedCandidate = path.resolve(parentDir, candidateChild);
    const realChild = await realpath(resolvedCandidate);

    const rel = path.relative(realParent, realChild);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null;
    }
    return realChild;
  } catch {
    return null;
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

  let statusData: unknown;
  try {
    const raw = await readFile(statusPath, "utf8");
    statusData = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!statusData || typeof statusData !== "object") {
    return null;
  }

  const { baseSha, integrationCommitSha, integrationWorktreePath } = statusData as {
    baseSha?: unknown;
    integrationCommitSha?: unknown;
    integrationWorktreePath?: unknown;
  };

  // 3. Try running git diff in the integration worktree ONLY if it exists and is a real child of runDirectory
  if (typeof integrationWorktreePath !== "string" || !integrationWorktreePath.trim()) {
    return null;
  }

  const validatedWorktree = await getValidatedChildWorktree(runDirectory, integrationWorktreePath);
  if (!validatedWorktree) {
    return null;
  }

  // Treat ref fields as untrusted
  if (baseSha !== undefined && !isValidGitRef(baseSha)) {
    return null;
  }
  if (integrationCommitSha !== undefined && !isValidGitRef(integrationCommitSha)) {
    return null;
  }

  const validBase = isValidGitRef(baseSha) ? baseSha : undefined;
  const validIntegration = isValidGitRef(integrationCommitSha) ? integrationCommitSha : undefined;

  const args = validBase
    ? (validIntegration ? ["diff", validBase, validIntegration] : ["diff", validBase])
    : ["diff", "HEAD~1"];

  try {
    const result = await runProcess("git", args, {
      cwd: validatedWorktree,
      timeoutMs: 15_000,
    });
    if (result.exitCode === 0) {
      return boundDiff(result.stdout, maxBytes, maxLines);
    }
  } catch {
    // Fall through
  }

  return null;
}
