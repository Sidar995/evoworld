import { isDeepStrictEqual } from 'node:util';
import { encodeCursor } from './archive.js';

export class PgStore {
  constructor(connectionString, { pool = null } = {}) {
    this.connectionString = connectionString;
    this.pool = pool;
    this.pool?.on('error', () => {});
    this.initialized = false;
  }
  async ready() {
    if (!this.pool) {
      if (!this.connectionString) throw new Error('Configure DATABASE_URL in .env and restart the server.');
      this.connecting ??= import('pg').then(({ default: pg }) => {
        this.pool = new pg.Pool({ connectionString: this.connectionString, connectionTimeoutMillis: 2500, max: 4 });
        this.pool.on('error', () => {});
      }).finally(() => { this.connecting = null; });
      await this.connecting;
    }
    if (!this.initialized) {
      this.initializing ??= (async () => {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS evo_experiments (
          id UUID PRIMARY KEY,
          record JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await this.pool.query('CREATE INDEX IF NOT EXISTS evo_experiments_created_id_idx ON evo_experiments (created_at DESC, id DESC)');
        this.initialized = true;
      })().finally(() => { this.initializing = null; });
      await this.initializing;
    }
    await this.pool.query('SELECT 1');
  }
  async list({ limit = 20, before = null } = {}) {
    await this.ready();
    const values = before ? [before.createdAt, before.id, limit + 1] : [limit + 1];
    const where = before ? 'WHERE (created_at, id) < ($1::timestamptz, $2::uuid)' : '';
    const limitParameter = before ? '$3' : '$1';
    const { rows } = await this.pool.query(`SELECT record - 'measurements' - 'interventions' AS record, created_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM evo_experiments ${where} ORDER BY created_at DESC, id DESC LIMIT ${limitParameter}`, values);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      experiments: page.map(({ record, created_at }) => ({ ...record, createdAt: created_at.toISOString() })),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.cursor_time, id: last.record.id }) : null,
    };
  }
  async get(id) {
    await this.ready();
    const { rows } = await this.pool.query('SELECT record, created_at FROM evo_experiments WHERE id = $1', [id]);
    return rows[0] ? { ...rows[0].record, createdAt: rows[0].created_at.toISOString() } : null;
  }
  async save(record) {
    await this.ready();
    const { rows } = await this.pool.query('INSERT INTO evo_experiments (id, record) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING record, created_at', [record.id, record]);
    if (rows[0]) return { experiment: { ...rows[0].record, createdAt: rows[0].created_at.toISOString() }, duplicate: false };
    const stored = await this.get(record.id);
    const { createdAt, ...existingRecord } = stored;
    if (!isDeepStrictEqual(existingRecord, record)) {
      const error = new Error('This experiment ID already belongs to a different result.');
      error.status = 409;
      throw error;
    }
    return { experiment: stored, duplicate: true };
  }
  async delete(id) {
    await this.ready();
    const result = await this.pool.query('DELETE FROM evo_experiments WHERE id=$1', [id]);
    return result.rowCount === 1;
  }
  async close() { await this.pool?.end(); }
}


