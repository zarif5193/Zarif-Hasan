/**
 * Database abstraction layer.
 *
 *  • If a D1 binding named DB exists -> uses Cloudflare D1 (SQLite)
 *  • Else if DATABASE_URL / POSTGRES_URL set -> uses PostgreSQL over TCP+TLS
 */
import { PgClient, pgLiteral } from './pg.js';
import { TABLES, DEFAULT_SETTINGS, DEFAULT_ROWS, ddlFor } from './schema.js';
export const lit = pgLiteral;

function d1Adapter(d1) {
  const bind = (sql, values) => (values && values.length ? d1.prepare(sql).bind(...values) : d1.prepare(sql));
  return {
    dialect: 'sqlite',
    async exec(sql) { await d1.exec(sql); },
    async run(sql, values = []) { return await bind(sql, values).run(); },
    async query(sql, values = []) {
      try { const res = await bind(sql, values).all(); return res.results || []; }
      catch (e) { await bind(sql, values).run(); return []; }
    },
    async insert(table, data) {
      const cols = Object.keys(data), values = cols.map((c) => data[c]);
      const stmt = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      const res = await d1.batch([bind(stmt, values), d1.prepare('SELECT last_insert_rowid() AS id')]);
      const row = (res[1].results || [])[0] || {};
      return { id: Number(row.id) };
    },
    async close() {},
  };
}
function pgAdapter(url) {
  let clientPromise = null;
  const getClient = () => {
    if (!clientPromise) clientPromise = PgClient.connect(url).catch((e) => { clientPromise = null; throw e; });
    return clientPromise;
  };
  const fill = (sql, values) => {
    if (!values || !values.length) return sql;
    let out = '', i = 0;
    for (const ch of sql) out += ch === '?' && i < values.length ? lit(values[i++]) : ch;
    return out;
  };
  return {
    dialect: 'postgres',
    async exec(sql) { const c = await getClient(); await c.query(sql); },
    async run(sql, values = []) { const c = await getClient(); return await c.query(fill(sql, values)); },
    async query(sql, values = []) { const c = await getClient(); return await c.query(fill(sql, values)); },
    async insert(table, data) {
      const cols = Object.keys(data), values = cols.map((c) => data[c]);
      const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING "id"`;
      const c = await getClient(), rows = await c.query(fill(sql, values));
      return { id: Number(rows[0] && rows[0].id) };
    },
    async close() {
      if (!clientPromise) return;
      try { const c = await clientPromise; await c.close(); } catch {}
      clientPromise = null;
    },
  };
}
export function hasDB(env) { return Boolean((env && env.DB) || (env && (env.DATABASE_URL || env.DATABASE_URL_PG || env.POSTGRES_URL))); }
export function getDB(env) {
  if (env && env.DB) return d1Adapter(env.DB);
  const url = env && (env.DATABASE_URL || env.DATABASE_URL_PG || env.POSTGRES_URL);
  if (url) return pgAdapter(url);
  throw new Error('No database configured. Bind a D1 database as "DB" in wrangler.toml, or set the DATABASE_URL secret.');
}
let schemaReady = null;
export async function ensureSchema(db) {
  if (!schemaReady) schemaReady = (async () => {
    for (const stmt of ddlFor(db.dialect)) await db.exec(stmt);
    await seedIfEmpty(db);
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
async function seedIfEmpty(db) {
  const existing = await db.query('SELECT COUNT(*) AS n FROM "settings"');
  if (Number((existing[0] || {}).n || 0) === 0)
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) await db.run('INSERT INTO "settings" ("key", "value") VALUES (?, ?)', [key, value]);
  for (const [table, rows] of Object.entries(DEFAULT_ROWS)) {
    const count = await db.query(`SELECT COUNT(*) AS n FROM "${table}"`);
    if (Number((count[0] || {}).n || 0) > 0) continue;
    for (const row of rows) await db.insert(table, row);
  }
  await db.run('DELETE FROM "settings" WHERE "key" = ?', ['__seeded']);
  await db.run('INSERT INTO "settings" ("key", "value") VALUES (?, ?)', ['__seeded', '1']);
}
const INT_COLUMNS = new Set(['id', 'sort_order', 'is_visible', 'is_read']);
export function coerceRows(rows) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = INT_COLUMNS.has(k) && v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    return out;
  });
}
export function tableMeta(name) { return TABLES[name]; }
export async function allRows(db, table) {
  const meta = TABLES[table], order = meta && meta.order ? ` ORDER BY ${meta.order}` : '';
  return coerceRows(await db.query(`SELECT * FROM "${table}"${order}`));
}
export async function loadAdminData(db) {
  const settingsRows = await db.query('SELECT "key", "value" FROM "settings"'), settings = {};
  for (const r of settingsRows) if (!String(r.key).startsWith('__')) settings[r.key] = r.value;
  const tables = {};
  for (const name of Object.keys(TABLES)) tables[name] = await allRows(db, name);
  return { settings, tables };
}
export async function loadSiteData(db) {
  const settingsRows = await db.query('SELECT "key", "value" FROM "settings"'), settings = {};
  for (const r of settingsRows) if (!String(r.key).startsWith('__')) settings[r.key] = r.value;
  const visible = async (table) => (await allRows(db, table)).filter((r) => r.is_visible === undefined || Number(r.is_visible) === 1);
  return { settings, education: await visible('education'), skills: await visible('skills'), interests: await visible('interests'), socials: await visible('socials'), phones: await visible('phones') };
}