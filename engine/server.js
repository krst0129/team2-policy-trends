import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, RUNS, readJson, config, loadEnv } from './util.js';
import { createRun, resumeRegion, cancelHandoff, getStatus, listRuns, startExport, exportStatus, handoffIssueDraft, claudeInfo, maybePublish } from './pipeline.js';
import { exportCaps } from './export.js';

loadEnv();
const PORT = +(process.env.PORT || 3000);
const DASH = path.join(ROOT, 'dashboard');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.hwpx': 'application/hwp+zip' };
const GH = ['C:\\Program Files\\GitHub CLI\\gh.exe'].find((p) => fs.existsSync(p)) || 'gh';

const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const safeId = (id) => /^[\w-]+$/.test(id) ? id : null;
const runFile = (id, name) => path.join(RUNS, id, name);
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const UPLOAD_FILES = ['입력값.json', '진행상태.json', '영역결과_domestic.json', '영역결과_overseas.json', 'items.json', 'report.json', '조사자료목록.csv', '검증기록.json', '정책조사보고서.html', '정책조사보고서.pdf', '정책조사보고서.hwpx', '조사결과_대시보드.html'];

async function api(req, res, url) {
  const p = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;
  if (p[1] === 'config' && m === 'GET') {
    const env = (k) => !!process.env[k];
    return send(res, 200, { team: config('team.json'), sources: config('sources.json'), topics: config('topics.json').topics, claude: claudeInfo(url.searchParams.has('refresh')), keys: { naver: env('NAVER_CLIENT_ID') && env('NAVER_CLIENT_SECRET'), google: env('GOOGLE_API_KEY') && env('GOOGLE_CSE_ID') }, exportCaps: exportCaps() });
  }
  if (p[1] === 'runs' && !p[2]) {
    if (m === 'GET') return send(res, 200, listRuns());
    if (m === 'POST') { try { return send(res, 200, createRun(await readBody(req))); } catch (e) { return send(res, 400, { error: e.message }); } }
  }
  if (p[1] === 'runs' && p[2]) {
    const id = safeId(p[2]); if (!id || !fs.existsSync(path.join(RUNS, id))) return send(res, 404, { error: '없는 실행' });
    const sub = p[3];
    try {
      if (!sub && m === 'GET') return send(res, 200, { status: getStatus(id), data: readJson(runFile(id, 'items.json')), report: readJson(runFile(id, 'report.json')), regions: { domestic: readJson(runFile(id, '영역결과_domestic.json')), overseas: readJson(runFile(id, '영역결과_overseas.json')) } });
      if (sub === 'resume' && m === 'POST') { const b = await readBody(req); return send(res, 200, resumeRegion(id, b.region, b.runner)); }
      if (sub === 'cancel-handoff' && m === 'POST') { const b = await readBody(req); return send(res, 200, cancelHandoff(id, b.runner)); }
      if (sub === 'republish' && m === 'POST') { maybePublish(id, true); return send(res, 200, { ok: true }); }
      if (sub === 'export' && m === 'POST') { const b = await readBody(req); if (!['pdf', 'hwpx', 'web'].includes(b.format)) return send(res, 400, { error: '지원하지 않는 형식' }); return send(res, 200, startExport(id, b.format)); }
      if (sub === 'export' && m === 'GET') return send(res, 200, exportStatus(id, url.searchParams.get('format')) || { pct: 0, done: false, idle: true });
      if (sub === 'file' && m === 'GET') {
        const name = url.searchParams.get('name');
        if (!UPLOAD_FILES.includes(name) && !/^그림\/[\w-]+\.png$/.test(name)) return send(res, 403, { error: '허용되지 않은 파일' });
        const f = runFile(id, name); if (!fs.existsSync(f)) return send(res, 404, { error: '파일 없음' });
        const ext = path.extname(f);
        const dl = url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(id + '_' + path.basename(f))}` } : {};
        return send(res, 200, fs.readFileSync(f), MIME[ext] || 'application/octet-stream', dl);
      }
      if (sub === 'issue-draft' && m === 'GET') return send(res, 200, handoffIssueDraft(id) || { error: '넘긴 영역 없음' });
      if (sub === 'issue' && m === 'POST') {
        // Only on the user's explicit click; body is the draft the user reviewed.
        const b = await readBody(req);
        if (!b.confirm || !b.title || !b.body) return send(res, 400, { error: '확인이 필요합니다' });
        const args = ['issue', 'create', '--repo', config('team.json').repo, '--title', b.title, '--body', b.body];
        if (b.assignee) args.push('--assignee', b.assignee);
        const r = spawnSync(GH, args, { encoding: 'utf8' });
        return r.status === 0 ? send(res, 200, { url: r.stdout.trim() }) : send(res, 500, { error: (r.stderr || 'gh 실패').slice(0, 300) });
      }
      if (sub === 'push' && m === 'POST') {
        const b = await readBody(req); if (!b.confirm) return send(res, 400, { error: '확인이 필요합니다' });
        const files = UPLOAD_FILES.map((f) => `runs/${id}/${f}`).filter((f) => fs.existsSync(path.join(ROOT, f)));
        git('pull', '--ff-only', '-q');
        git('add', '--', ...files);
        const c = git('commit', '-q', '-m', `Add run ${id}${getStatus(id).title ? ': ' + getStatus(id).title : ''}`);
        const ps = git('push', '-q');
        return ps.status === 0 ? send(res, 200, { ok: true, committed: c.status === 0, files }) : send(res, 500, { error: (ps.stderr || c.stderr).slice(0, 300) });
      }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p[1] === 'git' && p[2] === 'pull' && m === 'POST') { const r = git('pull', '--ff-only'); return send(res, r.status === 0 ? 200 : 500, { out: (r.stdout + r.stderr).slice(0, 500) }); }
  return send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch((e) => send(res, 500, { error: e.message }));
  let f = path.normalize(path.join(DASH, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!f.startsWith(DASH) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'not found', 'text/plain');
  send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => console.log(`정책 동향 대시보드: http://localhost:${PORT}`));
