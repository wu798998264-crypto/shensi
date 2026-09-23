import { normalizeState } from "./store.mjs";

const STATE_KEY = "primary";

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS shensi_skill_platform_state (
        state_key text PRIMARY KEY,
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      "INSERT INTO shensi_skill_platform_state (state_key, payload) VALUES ($1, $2::jsonb) ON CONFLICT (state_key) DO NOTHING",
      [STATE_KEY, JSON.stringify(normalizeState(null))],
    );
    const result = await this.pool.query(
      "SELECT payload FROM shensi_skill_platform_state WHERE state_key = $1",
      [STATE_KEY],
    );
    this.state = normalizeState(result.rows[0]?.payload);
    return this;
  }

  snapshot() {
    return structuredClone(normalizeState(this.state));
  }

  async transact(mutator) {
    this.queue = this.queue.then(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          "SELECT payload FROM shensi_skill_platform_state WHERE state_key = $1 FOR UPDATE",
          [STATE_KEY],
        );
        const next = structuredClone(normalizeState(locked.rows[0]?.payload));
        const result = await mutator(next);
        await client.query(
          "UPDATE shensi_skill_platform_state SET payload = $2::jsonb, updated_at = now() WHERE state_key = $1",
          [STATE_KEY, JSON.stringify(next)],
        );
        await client.query("COMMIT");
        this.state = next;
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
    return this.queue;
  }

  async health() {
    const result = await this.pool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }
}

export const createPostgresStore = async ({ connectionString, ssl = false } = {}) => {
  if (!connectionString) throw new Error("生产环境缺少 PostgreSQL 连接地址");
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    return await new PostgresStore(pool).init();
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
};
