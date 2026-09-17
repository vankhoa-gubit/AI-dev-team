import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { JobState } from "./types.js";

export class HarnessDatabase {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        requirement TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        revision_round INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        state TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  createJob(id: string, requirement: string, repositoryPath: string): void {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO jobs (id, state, requirement, repository_path, message, created_at, updated_at)
      VALUES (?, 'RECEIVED', ?, ?, 'Job received', ?, ?)
    `).run(id, requirement, repositoryPath, now, now);
    this.recordEvent(id, "RECEIVED", "Job received");
  }

  transition(
    id: string,
    state: JobState,
    message: string,
    fields: { branch?: string; worktreePath?: string; revisionRound?: number } = {},
    payload?: unknown,
  ): void {
    const now = new Date().toISOString();
    this.#db.prepare(`
      UPDATE jobs
      SET state = ?, message = ?, branch = COALESCE(?, branch),
          worktree_path = COALESCE(?, worktree_path),
          revision_round = COALESCE(?, revision_round), updated_at = ?
      WHERE id = ?
    `).run(
      state,
      message,
      fields.branch ?? null,
      fields.worktreePath ?? null,
      fields.revisionRound ?? null,
      now,
      id,
    );
    this.recordEvent(id, state, message, payload);
  }

  recordEvent(jobId: string, state: JobState, message: string, payload?: unknown): void {
    this.#db.prepare(`
      INSERT INTO events (job_id, state, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      jobId,
      state,
      message,
      payload === undefined ? null : JSON.stringify(payload),
      new Date().toISOString(),
    );
  }

  close(): void {
    this.#db.close();
  }
}
