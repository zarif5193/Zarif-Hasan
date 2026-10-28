/**
 * Node.js PostgreSQL adapter for Vercel/serverless runtimes.
 * Uses the maintained pg driver; Cloudflare Workers should use the original Cloudflare-sockets adapter.
 */
import pg from 'pg';
const { Client } = pg;

export class PgClient {
  static async connect(connectionString) {
    const client = new Client({
      connectionString,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
      keepAlive: true,
    });
    await client.connect();
    return new PgClient(client);
  }
  constructor(client) { this.client = client; }
  async query(text) {
    const result = await this.client.query(text);
    if (Array.isArray(result)) {
      const last = result[result.length - 1];
      return last && last.rows ? last.rows : [];
    }
    return result.rows || [];
  }
  async close() { await this.client.end(); }
}

export function pgLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return "'" + value.toISOString() + "'";
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return "'" + s.replace(/\u0000/g, '').replace(/'/g, "''") + "'";
}