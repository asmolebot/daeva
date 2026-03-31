import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { JobRecord, JobStatus } from './types.js';

/**
 * Minimal storage interface for job records.
 * Implementations handle persistence; the JobManager owns queue/processing logic.
 */
export interface JobStore {
  save(job: JobRecord): void;
  get(id: string): JobRecord | undefined;
  list(): JobRecord[];
  listRecent(limit: number): JobRecord[];
  delete(id: string): boolean;
  /** Remove jobs older than ttlMs based on updatedAt. Returns count deleted. */
  cleanup(ttlMs: number): number;
  /** Close any underlying resources (e.g. database connections). */
  close(): void;
}

// ── In-Memory Store ────────────────────────────────────────────────────

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  save(job: JobRecord): void {
    this.jobs.set(job.id, job);
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listRecent(limit: number): JobRecord[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  delete(id: string): boolean {
    return this.jobs.delete(id);
  }

  cleanup(ttlMs: number): number {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (job.updatedAt < cutoff && (job.status === 'completed' || job.status === 'failed')) {
        this.jobs.delete(id);
        count++;
      }
    }
    return count;
  }

  close(): void {
    // no-op
  }
}

// ── SQLite Store ───────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  request       TEXT NOT NULL,
  selected_pod_id     TEXT,
  resolved_capability TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  result        TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
`;

export interface SqliteJobStoreOptions {
  /** Path to the SQLite database file. Defaults to ASMO_JOB_DB_PATH env or ./data/jobs.db */
  dbPath?: string;
  /** TTL in ms for completed/failed jobs. Defaults to ASMO_JOB_TTL_MS env or 86400000 (24h). */
  ttlMs?: number;
  /** Auto-cleanup interval in ms. Set to 0 to disable. Default: 3600000 (1h). */
  cleanupIntervalMs?: number;
}

const resolveDbPath = (explicit?: string): string =>
  explicit ?? process.env.ASMO_JOB_DB_PATH ?? './data/jobs.db';

const resolveTtlMs = (explicit?: number): number => {
  if (explicit !== undefined) return explicit;
  const env = process.env.ASMO_JOB_TTL_MS;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 86_400_000; // 24 hours
};

const toRow = (job: JobRecord) => ({
  id: job.id,
  created_at: job.createdAt,
  updated_at: job.updatedAt,
  status: job.status,
  request: JSON.stringify(job.request),
  selected_pod_id: job.selectedPodId ?? null,
  resolved_capability: job.resolvedCapability ?? null,
  started_at: job.startedAt ?? null,
  completed_at: job.completedAt ?? null,
  result: job.result ? JSON.stringify(job.result) : null,
  error: job.error ? JSON.stringify(job.error) : null
});

const fromRow = (row: Record<string, unknown>): JobRecord => {
  const job: JobRecord = {
    id: row.id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    status: row.status as JobStatus,
    request: JSON.parse(row.request as string)
  };

  if (row.selected_pod_id) job.selectedPodId = row.selected_pod_id as string;
  if (row.resolved_capability) job.resolvedCapability = row.resolved_capability as JobRecord['resolvedCapability'];
  if (row.started_at) job.startedAt = row.started_at as string;
  if (row.completed_at) job.completedAt = row.completed_at as string;
  if (row.result) job.result = JSON.parse(row.result as string);
  if (row.error) job.error = JSON.parse(row.error as string);

  return job;
};

export class SqliteJobStore implements JobStore {
  private readonly db: Database.Database;
  readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Prepared statements (lazy-initialized after schema creation)
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtList: Database.Statement;
  private readonly stmtListRecent: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtCleanup: Database.Statement;

  constructor(options: SqliteJobStoreOptions = {}) {
    const dbPath = resolveDbPath(options.dbPath);
    this.ttlMs = resolveTtlMs(options.ttlMs);

    // Ensure parent directory exists
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);

    // Mark any jobs left in 'running' state as 'failed' (process crashed/restarted)
    this.db.prepare(
      `UPDATE jobs SET status = 'failed', updated_at = ?, error = ? WHERE status = 'running'`
    ).run(
      new Date().toISOString(),
      JSON.stringify({ code: 'PROCESS_RESTART', message: 'Job interrupted by process restart', retriable: true })
    );

    // Prepare statements
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO jobs (id, created_at, updated_at, status, request, selected_pod_id, resolved_capability, started_at, completed_at, result, error)
      VALUES (@id, @created_at, @updated_at, @status, @request, @selected_pod_id, @resolved_capability, @started_at, @completed_at, @result, @error)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = @updated_at,
        status = @status,
        request = @request,
        selected_pod_id = @selected_pod_id,
        resolved_capability = @resolved_capability,
        started_at = @started_at,
        completed_at = @completed_at,
        result = @result,
        error = @error
    `);
    this.stmtGet = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    this.stmtList = this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC');
    this.stmtListRecent = this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?');
    this.stmtDelete = this.db.prepare('DELETE FROM jobs WHERE id = ?');
    this.stmtCleanup = this.db.prepare(
      `DELETE FROM jobs WHERE updated_at < ? AND status IN ('completed', 'failed')`
    );

    // Auto-cleanup timer
    const cleanupInterval = options.cleanupIntervalMs ?? 3_600_000;
    if (cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(this.ttlMs), cleanupInterval);
      this.cleanupTimer.unref();
    }
  }

  save(job: JobRecord): void {
    this.stmtUpsert.run(toRow(job));
  }

  get(id: string): JobRecord | undefined {
    const row = this.stmtGet.get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): JobRecord[] {
    const rows = this.stmtList.all() as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  listRecent(limit: number): JobRecord[] {
    const rows = this.stmtListRecent.all(limit) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  cleanup(ttlMs: number): number {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const result = this.stmtCleanup.run(cutoff);
    return result.changes;
  }

  /** Get jobs with status 'queued', ordered by creation time (for queue recovery). */
  getQueuedJobIds(): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC`
    ).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.db.close();
  }
}
