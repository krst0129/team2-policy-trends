// Runs Claude Code non-interactively (`claude -p`). Claude Code only proposes
// candidates, topics and report sentences; nothing it returns is trusted until
// the link verifier (verify.js) or the report validator (report.js) checks it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let cachedBin;
export function findClaude() {
  if (cachedBin !== undefined) return cachedBin;
  const cands = [];
  if (process.env.CLAUDE_BIN) cands.push(process.env.CLAUDE_BIN);
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (where.status === 0) cands.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  // Claude desktop app bundles the CLI under %LOCALAPPDATA%\Claude-Data\<pkg>\claude-code\<ver>\<hash>\claude.exe
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data');
  try {
    const found = [];
    for (const pkg of fs.readdirSync(base)) {
      const cc = path.join(base, pkg, 'claude-code');
      if (!fs.existsSync(cc)) continue;
      for (const ver of fs.readdirSync(cc)) for (const h of fs.readdirSync(path.join(cc, ver))) {
        const exe = path.join(cc, ver, h, 'claude.exe');
        if (fs.existsSync(exe)) found.push({ exe, t: fs.statSync(exe).mtimeMs });
      }
    }
    found.sort((a, b) => b.t - a.t).forEach((f) => cands.push(f.exe));
  } catch { /* no desktop app */ }
  cachedBin = cands.find((c) => fs.existsSync(c)) || null;
  return cachedBin;
}

export function claudeStatus() {
  const bin = findClaude();
  if (!bin) return { available: false, loggedIn: false, reason: 'Claude Code CLI를 찾지 못함 (.env의 CLAUDE_BIN에 경로를 지정하세요)' };
  const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 30000 });
  try {
    const j = JSON.parse(r.stdout);
    return { available: true, loggedIn: !!j.loggedIn, bin, reason: j.loggedIn ? '' : 'Claude Code 로그인 필요 (claude auth login)' };
  } catch { return { available: true, loggedIn: false, bin, reason: 'Claude Code 상태 확인 실패' }; }
}

export function runClaude(prompt, { tools = [], maxTurns = 30, timeoutMs = 15 * 60 * 1000, workDir, onLog } = {}) {
  const bin = findClaude();
  if (!bin) return Promise.reject(new Error('Claude Code CLI 없음'));
  const cwd = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'policy-claude-'));
  fs.mkdirSync(cwd, { recursive: true });
  const args = ['-p', '--output-format', 'json', '--max-turns', String(maxTurns)];
  // Only the listed tools are pre-approved; in -p mode anything else is denied.
  if (tools.length) args.push('--allowedTools', tools.join(','));
  args.push('--disallowedTools', 'Bash,Edit,Write,NotebookEdit,PowerShell');
  return new Promise((resolve, reject) => {
    const ch = spawn(bin, args, { cwd, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { ch.kill(); reject(new Error('Claude Code 시간 초과')); }, timeoutMs);
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; onLog?.(String(d).slice(0, 200)); });
    ch.on('error', (e) => { clearTimeout(timer); reject(e); });
    ch.on('close', () => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error('Claude Code 응답 해석 실패: ' + (err || out).slice(0, 300))); }
      if (j.is_error) return reject(new Error('Claude Code 오류: ' + String(j.result).slice(0, 300)));
      resolve({ text: j.result || '', costUsd: j.total_cost_usd, usage: j.usage });
    });
    ch.stdin.end(prompt, 'utf8');
  });
}

export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('JSON 없음');
  const open = body[start], close = open === '[' ? ']' : '}';
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}
