/**
 * Cloudflare Worker entry point.
 *  /                 -> portfolio page (HTML from /public, data injected from DB)
 *  /admin            -> admin panel (login protected)
 *  /api/*            -> JSON API
 * Everything else is served from the static assets binding.
 */

import { getDB, hasDB, ensureSchema, loadSiteData, loadAdminData, allRows } from '../lib/db.js';
import { TABLES, SETTINGS_FIELDS } from '../lib/schema.js';
import {
  adminPassword,
  safeEqual,
  createSessionCookie,
  clearSessionCookie,
  isLoggedIn,
  requireAdmin,
  json,
} from '../lib/auth.js';

const TEXT_LIMIT = 4000;
const LONG_LIMIT = 20000;

function noStore(headers = {}) {
  return { 'Cache-Control': 'no-store, must-revalidate', ...headers };
}
function withHtmlHeaders(res) {
  const h = new Headers(res.headers);
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store, must-revalidate');
  return h;
}
async function asset(env, request, pathname) {
  if (!env.ASSETS) return new Response('Static assets binding missing', { status: 500 });
  const url = new URL(request.url);
  url.pathname = pathname;
  return env.ASSETS.fetch(new Request(url.toString(), request));
}
async function serveSite(request, env) {
  const indexRes = await asset(env, request, '/index.html');
  if (!indexRes.ok) return indexRes;
  let html = await indexRes.text();
  let payload = { settings: {}, education: [], skills: [], interests: [], socials: [], phones: [], admin: false, dbError: null };
  try {
    const db = getDB(env);
    await ensureSchema(db);
    const data = await loadSiteData(db);
    payload = { ...data, admin: await isLoggedIn(request, env) };
  } catch (err) {
    payload.dbError = String((err && err.message) || err);
    console.error('site data error:', payload.dbError);
  }
  const jsonData = JSON.stringify(payload).replace(/</g, '\\u003c');
  html = html.replace('<!--SITE_DATA-->', `<script id="site-data" type="application/json">${jsonData}</script>`);
  return new Response(html, { status: 200, headers: withHtmlHeaders(indexRes) });
}
async function serveAdmin(request, env, url) {
  const isShell = url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin/index.html';
  if (!isShell) return asset(env, request, url.pathname);
  const res = await asset(env, request, '/admin/index.html');
  if (!res.ok) return res;
  return new Response(await res.text(), {
    status: 200,
    headers: noStore({ 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin' }),
  });
}
function cleanValue(def, value) {
  if (def.type === 'int') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : Number(def.default ?? 0);
  }
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s.length > (def.type === 'textarea' ? LONG_LIMIT : TEXT_LIMIT) ? s.slice(0, LONG_LIMIT) : s;
}
function sanitizeRow(table, body, { partial = false } = {}) {
  const meta = TABLES[table];
  if (!meta) throw new Error('unknown table: ' + table);
  const out = {};
  for (const [key, def] of Object.entries(meta.columns)) {
    if (partial && !(key in body)) continue;
    if (key === 'created_at') continue;
    out[key] = cleanValue(def, body[key]);
  }
  return out;
}
function sanitizeSettings(body) {
  const allowed = new Set(SETTINGS_FIELDS.map((f) => f.key));
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!allowed.has(k)) continue;
    const field = SETTINGS_FIELDS.find((f) => f.key === k);
    const s = v === null || v === undefined ? '' : String(v);
    out[k] = s.length > (field && field.type === 'textarea' ? LONG_LIMIT : TEXT_LIMIT) ? s.slice(0, LONG_LIMIT) : s;
  }
  return out;
}
async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  let db = null;
  const openDB = async () => { db = getDB(env); await ensureSchema(db); return db; };
  try {
    if (path === '/api/health') {
      if (!hasDB(env)) return json({ ok: false, db: null, error: 'DATABASE_URL / D1 binding missing' }, 200);
      const d = await openDB();
      const now = await d.query('SELECT 1 AS ok');
      return json({ ok: true, dialect: d.dialect, now });
    }
    if (path === '/api/site' && method === 'GET') {
      const d = await openDB();
      const data = await loadSiteData(d);
      return json({ ...data, admin: await isLoggedIn(request, env) });
    }
    if (path === '/api/session' && method === 'GET') return json({ loggedIn: await isLoggedIn(request, env) });
    if (path === '/api/login' && method === 'POST') {
      const { password } = await readJson(request);
      if (!adminPassword(env)) return json({ error: 'ADMIN_PASSWORD সেট করা হয়নি। Cloudflare Secret-এ এটা যোগ করুন।' }, 500);
      if (!password || !safeEqual(password, adminPassword(env))) {
        await new Promise((r) => setTimeout(r, 600));
        return json({ error: 'পাসওয়ার্ড সঠিক নয়।' }, 401);
      }
      return json({ ok: true }, 200, { 'Set-Cookie': await createSessionCookie(env) });
    }
    if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    if (path === '/api/contact' && method === 'POST') {
      const b = await readJson(request);
      if (b.honey) return json({ ok: true });
      const name = String(b.name || '').trim().slice(0, 120);
      const email = String(b.email || '').trim().slice(0, 160);
      const phone = String(b.phone || '').trim().slice(0, 60);
      const message = String(b.message || '').trim().slice(0, 4000);
      if (!name || !message) return json({ error: 'নাম এবং মেসেজ লিখুন।' }, 400);
      const d = await openDB();
      await d.insert('messages', { name, email, phone, message, is_read: 0, created_at: new Date().toISOString() });
      return json({ ok: true });
    }
    if (path.startsWith('/api/admin/')) {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
    }
    if (path === '/api/admin/data' && method === 'GET') {
      const d = await openDB();
      const data = await loadAdminData(d);
      return json({ ...data, dialect: d.dialect, meta: { tables: TABLES, settingsFields: SETTINGS_FIELDS } });
    }
    if (path === '/api/admin/row' && method === 'POST') {
      const body = await readJson(request);
      const table = String(body.table || '');
      if (!TABLES[table] || table === 'messages') return json({ error: 'invalid table' }, 400);
      const d = await openDB();
      const values = sanitizeRow(table, body.values || body || {}, { partial: Boolean(body.id) });
      if (body.id) {
        const keys = Object.keys(values);
        if (!keys.length) return json({ error: 'nothing to update' }, 400);
        const sets = keys.map((k) => `"${k}" = ?`).join(', ');
        await d.run(`UPDATE "${table}" SET ${sets} WHERE "id" = ?`, [...keys.map((k) => values[k]), Number(body.id)]);
        return json({ ok: true, id: Number(body.id) });
      }
      const inserted = await d.insert(table, values);
      return json({ ok: true, id: inserted.id });
    }
    if (path === '/api/admin/delete' && method === 'POST') {
      const body = await readJson(request);
      const table = String(body.table || '');
      const id = Number(body.id);
      if (!TABLES[table] || !Number.isFinite(id)) return json({ error: 'invalid request' }, 400);
      const d = await openDB();
      await d.run(`DELETE FROM "${table}" WHERE "id" = ?`, [id]);
      return json({ ok: true });
    }
    if (path === '/api/admin/settings' && method === 'POST') {
      const body = await readJson(request);
      const values = sanitizeSettings(body);
      if (!Object.keys(values).length) return json({ error: 'nothing to save' }, 400);
      const d = await openDB();
      for (const [key, value] of Object.entries(values)) {
        await d.run('DELETE FROM "settings" WHERE "key" = ?', [key]);
        await d.run('INSERT INTO "settings" ("key", "value") VALUES (?, ?)', [key, value]);
      }
      return json({ ok: true, saved: Object.keys(values).length });
    }
    if (path === '/api/admin/message' && method === 'POST') {
      const body = await readJson(request);
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: 'invalid id' }, 400);
      const d = await openDB();
      if (body.action === 'delete') { await d.run('DELETE FROM "messages" WHERE "id" = ?', [id]); return json({ ok: true }); }
      const isRead = body.is_read ? 1 : 0;
      await d.run('UPDATE "messages" SET "is_read" = ? WHERE "id" = ?', [isRead, id]);
      return json({ ok: true });
    }
    if (path === '/api/admin/rows' && method === 'GET') {
      const table = url.searchParams.get('table') || '';
      if (!TABLES[table]) return json({ error: 'invalid table' }, 400);
      const d = await openDB();
      return json({ rows: await allRows(d, table) });
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('API error', path, err && err.stack);
    return json({ error: String((err && err.message) || err) }, 500);
  } finally {
    if (db && db.close) { try { await db.close(); } catch {} }
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/api/')) return handleApi(request, env, url);
    if (path === '/admin' || path === '/admin/' || path.startsWith('/admin/')) return serveAdmin(request, env, url);
    if (path === '/' || path === '/index.html') return serveSite(request, env);
    return asset(env, request, path);
  },
};