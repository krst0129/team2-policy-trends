import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = path.join(ROOT, 'runs');
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
export const config = (name) => readJson(path.join(ROOT, 'config', name));

// .env (KEY=VALUE per line). Never committed.
export function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export async function fetchText(url, { timeout = 20000, headers = {}, method = 'GET' } = {}) {
  const r = await fetch(url, { method, headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  const buf = Buffer.from(await r.arrayBuffer());
  let text = buf.toString('utf8');
  const cs = (r.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || text.slice(0, 2000).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  if (cs && !/utf-?8/i.test(cs)) { try { text = new TextDecoder(cs).decode(buf); } catch { /* keep utf8 */ } }
  return { status: r.status, url: r.url, text, contentType: r.headers.get('content-type') || '' };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
export function decodeEntities(s = '') {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export const stripTags = (s = '') => decodeEntities(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
export const escHtml = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// "2026-10-20" helpers
export const ymd = (d) => d.toISOString().slice(0, 10);
export function normDate(y, m, d) {
  const Y = +y, M = +m, D = +d;
  if (Y < 2000 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}
export function parseLooseDate(s = '') {
  const m = String(s).match(/(20\d\d)\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (m) return normDate(m[1], m[2], m[3]);
  const c = String(s).match(/(20\d\d)(\d\d)(\d\d)/);
  if (c) return normDate(c[1], c[2], c[3]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? ymd(new Date(t)) : null;
}

export function canonicalUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|pageIndex|repCode|repCodeType|startDate|endDate|srchWord|period|call_from)/i.test(k)) x.searchParams.delete(k);
    let s = x.toString();
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return u; }
}

export const normText = (s = '') => decodeEntities(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');

export function now() { return new Date().toISOString(); }
