import worker from '../worker/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const relative = pathname.replace(/^\/+/, '');
    if (!relative || relative.includes('..') || relative.includes('\\')) return new Response('Not found', { status: 404 });
    const full = path.resolve(root, 'public', relative);
    if (!full.startsWith(path.resolve(root, 'public') + path.sep)) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.readFile(full);
      const headers = new Headers({ 'Content-Type': mime[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      if (request.method === 'HEAD') return new Response(null, { headers });
      return new Response(data, { headers });
    } catch { return new Response('Not found', { status: 404 }); }
  }
};

export default async function handler(req, res) {
  try {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers.host || 'localhost';
    const incoming = new URL(req.url || '/', `${proto}://${host}`);
    const routedPath = incoming.searchParams.get('__path');
    if (routedPath !== null) {
      incoming.pathname = '/' + decodeURIComponent(routedPath);
      incoming.searchParams.delete('__path');
    }
    const url = incoming.toString();
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
      else if (value !== undefined) headers.set(key, String(value));
    }
    let body;
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (chunks.length) body = Buffer.concat(chunks);
    }
    const request = new Request(url, { method: req.method || 'GET', headers, body, ...(body ? { duplex: 'half' } : {}) });
    const env = {
      ASSETS: assets,
      DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
      SESSION_SECRET: process.env.SESSION_SECRET || '',
    };
    const response = await worker.fetch(request, env);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const output = Buffer.from(await response.arrayBuffer());
    res.end(output);
  } catch (error) {
    console.error('Vercel handler error:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}