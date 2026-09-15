/**
 * テスト専用: PostgREST 互換のごく小さなモック + 静的配信。
 * 本番の Supabase には一切アクセスしません（ブラウザテストを
 * ネットワークから切り離して動かすためのスタブです）。
 *
 *   node tests/mock-supabase.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = {
  kc_events: [
    { id: 1, event_date: '2026-09-19', title: null, venue: null, target_min: 2, target_max: 3, note: null, created_at: new Date().toISOString() },
    { id: 2, event_date: '2026-09-27', title: null, venue: null, target_min: 2, target_max: 3, note: null, created_at: new Date().toISOString() },
    { id: 3, event_date: '2026-10-03', title: null, venue: null, target_min: 2, target_max: 3, note: null, created_at: new Date().toISOString() },
    { id: 4, event_date: '2026-10-18', title: null, venue: null, target_min: 4, target_max: 5, note: null, created_at: new Date().toISOString() },
    { id: 5, event_date: '2026-10-24', title: null, venue: null, target_min: 4, target_max: 5, note: null, created_at: new Date().toISOString() },
    { id: 6, event_date: '2026-11-07', title: null, venue: null, target_min: 2, target_max: 3, note: null, created_at: new Date().toISOString() },
    { id: 7, event_date: '2026-11-21', title: null, venue: null, target_min: 2, target_max: 3, note: null, created_at: new Date().toISOString() },
  ],
  kc_entries: [
    { id: randomUUID(), event_id: 1, vendor_name: 'つむKITCHEN', genre: 'クレープ', contact: '山田 090-1111-2222', status: 'confirmed', note: null, position: 1, created_by: '前任', updated_by: '前任', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: randomUUID(), event_id: 1, vendor_name: 'FoodieGent', genre: 'ケバブ', contact: null, status: 'pending', note: '9/10までに返答予定', position: 2, created_by: '前任', updated_by: '前任', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: randomUUID(), event_id: 3, vendor_name: 'プヨ', genre: 'タコス', contact: null, status: 'declined', note: '別現場と重複', position: 1, created_by: '前任', updated_by: '前任', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
};
let seq = 8;
const PORT = Number(process.argv[2] || 8100);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.sql': 'text/plain' };

function body(req) {
  return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(d)); });
}
function eqFilter(url, rows) {
  let out = rows;
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'apikey'].includes(k)) continue;
    if (String(v).startsWith('eq.')) {
      const want = String(v).slice(3);
      out = out.filter((r) => String(r[k]) === want);
    }
  }
  return out;
}
function send(req, res, rows, code = 200) {
  const single = (req.headers.accept || '').includes('pgrst.object');
  const payload = single ? rows[0] ?? null : rows;
  const data = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(data);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': '*',
      'access-control-allow-headers': '*',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.replace('/rest/v1/', '');
    const rows = db[table];
    if (!rows) return send(req, res, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }, 404);

    if (req.method === 'GET') {
      let out = eqFilter(url, rows);
      const order = url.searchParams.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (dir === 'desc' ? -1 : 1));
      }
      return send(req, res, out);
    }
    if (req.method === 'POST') {
      const row = JSON.parse(await body(req));
      const now = new Date().toISOString();
      const made = table === 'kc_events'
        ? { id: seq++, title: null, venue: null, note: null, created_at: now, ...row }
        : { id: randomUUID(), created_at: now, updated_at: now, ...row };
      rows.push(made);
      return send(req, res, [made], 201);
    }
    if (req.method === 'PATCH') {
      const patch = JSON.parse(await body(req));
      const hits = eqFilter(url, rows);
      hits.forEach((r) => Object.assign(r, patch, { updated_at: new Date().toISOString() }));
      return send(req, res, hits);
    }
    if (req.method === 'DELETE') {
      const hits = eqFilter(url, rows);
      db[table] = rows.filter((r) => !hits.includes(r));
      if (table === 'kc_events') {
        const ids = hits.map((r) => String(r.id));
        db.kc_entries = db.kc_entries.filter((e) => !ids.includes(String(e.event_id)));
      }
      return send(req, res, hits);
    }
    return send(req, res, { message: 'unsupported' }, 400);
  }

  // 静的配信
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log('mock on ' + PORT));
