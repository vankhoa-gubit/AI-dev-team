import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export type JsonFileState = "valid" | "missing" | "corrupt";

export interface JsonFileInspection<T> {
  path: string;
  state: JsonFileState;
  value?: T;
  error?: string;
}

export interface JsonRecovery<T> {
  value: T;
  source: "primary" | "backup";
  primary: JsonFileInspection<T>;
  backup?: JsonFileInspection<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

export async function inspectJsonFile<T>(
  filePath: string,
  parse: (input: unknown) => T,
): Promise<JsonFileInspection<T>> {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      return { path: filePath, state: "valid", value: parse(JSON.parse(raw)) };
    } catch (error) {
      return { path: filePath, state: "corrupt", error: errorMessage(error) };
    }
  } catch (error) {
    if (isMissing(error)) return { path: filePath, state: "missing" };
    return { path: filePath, state: "corrupt", error: errorMessage(error) };
  }
}

async function writeTextAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx");
    created = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    created = false;
  } finally {
    if (created) await rm(temporaryPath, { force: true });
  }
}

async function preserveCorruptEvidence(filePath: string, content: string): Promise<string> {
  const evidencePath = `${filePath}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}`;
  await writeTextAtomically(evidencePath, content);
  return evidencePath;
}

export async function writeJsonAtomically<T>(
  filePath: string,
  value: T,
  options: {
    backupPath?: string;
    parseExisting?: (input: unknown) => unknown;
  } = {},
): Promise<void> {
  if (options.backupPath && options.parseExisting) {
    try {
      const existing = await readFile(filePath, "utf8");
      let valid = true;
      try {
        options.parseExisting(JSON.parse(existing));
      } catch {
        valid = false;
      }
      if (valid) {
        try {
          const previousBackup = await readFile(options.backupPath, "utf8");
          try {
            options.parseExisting(JSON.parse(previousBackup));
          } catch {
            await preserveCorruptEvidence(options.backupPath, previousBackup);
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await writeTextAtomically(options.backupPath, existing);
      } else {
        await preserveCorruptEvidence(filePath, existing);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  await writeTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonWithFallback<T>(
  primaryPath: string,
  backupPath: string | undefined,
  parse: (input: unknown) => T,
): Promise<JsonRecovery<T>> {
  const primary = await inspectJsonFile(primaryPath, parse);
  if (primary.state === "valid") {
    return { value: primary.value!, source: "primary", primary };
  }
  if (backupPath) {
    const backup = await inspectJsonFile(backupPath, parse);
    if (backup.state === "valid") {
      return { value: backup.value!, source: "backup", primary, backup };
    }
    throw new Error(
      `Cannot recover ${primaryPath}: primary is ${primary.state} and backup is ${backup.state}`,
    );
  }
  throw new Error(`Cannot load ${primaryPath}: file is ${primary.state}`);
}

export async function listCorruptEvidence(filePath: string): Promise<string[]> {
  try {
    const prefix = `${path.basename(filePath)}.corrupt.`;
    return (await readdir(path.dirname(filePath)))
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .map((entry) => path.join(path.dirname(filePath), entry));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
