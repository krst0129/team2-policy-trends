// Run lifecycle: create → collect per region (self or handed over) → verify →
// merge both regions → classify → report. State lives in runs/<id>/진행상태.json
// so a partner can resume a handed-over region on another PC after `git pull`.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, readJson, writeJson, config, now, tallyReasons as tally } from './util.js';
import { claudeStatus } from './claude.js';
import { collectRegion, translateKeywords } from './collectors.js';
import { verifyAll, dedupeByTitle } from './verify.js';
import { classify, keywordClusters } from './classify.js';
import { buildReportData, renderReportHtml, reportCharts } from './report.js';
import { toPdf, toHwpx, chartsToPng, exportCaps } from './export.js';
import { buildSnapshot } from './snapshot.js';

export const REGIONS = ['domestic', 'overseas'];
const busy = new Set();
let claudeCache = { t: 0, v: null };
export function claudeInfo(force = false) {
  if (force || !claudeCache.v || Date.now() - claudeCache.t > 60000) claudeCache = { t: Date.now(), v: claudeStatus() };
  return claudeCache.v;
}

const dir = (id) => path.join(RUNS, id);
const statusPath = (id) => path.join(dir(id), '진행상태.json');
export const getStatus = (id) => readJson(statusPath(id));
// ---- progress (0–100%) ----
// Each active region = collect (0–45) + verify (45–100); regions together are 80% of
// the run, publishing (merge · classify · write · render) is the last 20%.
const STEPS = [['collect', '자료 수집'], ['verify', '링크 검증'], ['classify', '주제 분류'], ['write', '보고서 작성'], ['publish', '발간']];
function computeProgress(st) {
  const active = REGIONS.filter((r) => st.regions[r]?.state !== 'skipped');
  const rp = (r) => { const x = st.regions[r]; return x.state === 'done' ? 100 : x.pct || 0; };
  const regionAvg = active.length ? active.reduce((a, r) => a + rp(r), 0) / active.length : 100;
  const pub = st.stage === 'published' ? 100 : st.publishPct || 0;
  const overall = st.stage === 'published' ? 100 : Math.min(99, Math.round(regionAvg * 0.8 + pub * 0.2));
  const phaseOf = (x) => (x.state === 'done' ? 2 : x.phase === 'verify' ? 1 : x.state === 'running' ? 0 : -1);
  const minReg = active.length ? Math.min(...active.map((r) => phaseOf(st.regions[r]))) : 2;
  const pubStep = st.stage === 'published' ? 5 : ({ merge: 2, classify: 2, write: 3, render: 4 }[st.publishPhase] ?? (minReg >= 2 ? 2 : -1));
  const cur = st.stage === 'published' ? 5 : minReg < 2 ? Math.max(0, minReg) : pubStep;
  st.progress = {
    overall,
    label: st.stage === 'published' ? '발간 완료' : st.stage === 'waiting' ? '상대 영역 넘김 · 대기 중' : st.stage === 'error' ? '오류' : st.phaseText || '진행 중',
    steps: STEPS.map(([id, label], i) => ({ id, label, state: i < cur ? 'done' : i === cur ? (st.stage === 'waiting' && i < 2 ? 'wait' : 'now') : 'todo' })),
  };
}
function saveStatus(st) { st.updatedAt = now(); computeProgress(st); writeJson(statusPath(st.id), st); }
const lastSave = new Map();
function setProgress(id, mut, force = false) {
  const st = getStatus(id); if (!st) return;
  mut(st);
  if (!force && Date.now() - (lastSave.get(id) || 0) < 400) { computeProgress(st); return; }
  lastSave.set(id, Date.now());
  saveStatus(st);
}
function logTo(st, region, msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${region ? (region === 'domestic' ? '국내' : '해외') + ' · ' : ''}${msg}`;
  st.log = [...(st.log || []), line].slice(-300);
  saveStatus(st);
}

export function listRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter((d) => fs.existsSync(statusPath(d))).map((d) => getStatus(d)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ log, ...s }) => s);
}

function memberName(id) { return config('team.json').members.find((m) => m.id === id)?.name || id; }
function homeRegion(id) { return config('team.json').members.find((m) => m.id === id)?.region; }

export function createRun(body) {
  const team = config('team.json'), src = config('sources.json');
  const keywords = [...new Set((body.keywords || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 20);
  const keywordsEn = [...new Set((body.keywordsEn || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 12);
  const { start, end, runner, handoff = 'self' } = body;
  if (!keywords.length) throw new Error('키워드를 하나 이상 넣어 주세요');
  if (!/^\d{4}-\d\d-\d\d$/.test(start || '') || !/^\d{4}-\d\d-\d\d$/.test(end || '') || start > end) throw new Error('조사기간이 올바르지 않습니다');
  if ((new Date(end) - new Date(start)) / 864e5 > 366) throw new Error('조사기간은 최대 1년입니다');
  if (!team.members.some((m) => m.id === runner)) throw new Error('실행자를 선택해 주세요');
  const groups = (body.groups || src.groups.map((g) => g.id)).filter((g) => src.groups.some((x) => x.id === g));
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  let id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  for (let k = 2; fs.existsSync(dir(id)); k++) id = id.replace(/(_\d{4})(-\d+)?$/, `$1-${k}`);
  const inputs = { keywords, keywordsEn, start, end, groups, runner, runnerName: memberName(runner), handoff, createdAt: now() };
  writeJson(path.join(dir(id), '입력값.json'), inputs);
  const mine = homeRegion(runner);
  const regionHasGroups = (r) => src.groups.some((g) => g.region === r && groups.includes(g.id));
  const regions = {};
  for (const r of REGIONS) {
    if (!regionHasGroups(r)) regions[r] = { state: 'skipped', note: '선택한 출처 없음' };
    else if (handoff === 'handoff' && r !== mine) regions[r] = { state: 'handed', to: team.members.find((m) => m.region === r)?.id, handedAt: now() };
    else regions[r] = { state: 'queued', by: runner };
  }
  const st = { id, createdAt: now(), inputs, regions, stage: 'collecting', log: [] };
  saveStatus(st);
  logTo(st, null, `실행 생성 — 실행자 ${inputs.runnerName}, ${handoff === 'handoff' ? '상대 영역 넘김' : '직접 조사'}`);
  for (const r of REGIONS) if (regions[r].state === 'queued') runRegion(id, r, runner);
  return getStatus(id);
}

export function resumeRegion(id, region, runner) {
  const st = getStatus(id); if (!st) throw new Error('실행을 찾을 수 없음');
  if (!['handed', 'error'].includes(st.regions[region]?.state)) throw new Error('이어받을 수 있는 영역이 아닙니다');
  st.regions[region] = { ...st.regions[region], state: 'queued', by: runner, resumed: true };
  saveStatus(st);
  logTo(st, region, `${memberName(runner)} 이어받기`);
  runRegion(id, region, runner);
  return getStatus(id);
}

export function cancelHandoff(id, runner) {
  const st = getStatus(id); if (!st) throw new Error('실행을 찾을 수 없음');
  const r = REGIONS.find((x) => st.regions[x].state === 'handed');
  if (!r) throw new Error('넘긴 영역이 없습니다');
  st.regions[r] = { state: 'queued', by: runner, note: '넘기기 취소 → 직접 조사' };
  saveStatus(st);
  logTo(st, r, '넘기기 취소 → 직접 조사');
  runRegion(id, r, runner);
  return getStatus(id);
}

async function runRegion(id, region, runner) {
  const key = id + ':' + region; if (busy.has(key)) return; busy.add(key);
  const st = getStatus(id);
  const log = (m) => { const s = getStatus(id); logTo(s, region, m); };
  try {
    st.regions[region] = { ...st.regions[region], state: 'running', by: runner, byName: memberName(runner), startedAt: now() };
    saveStatus(st);
    const src = config('sources.json');
    const cl = claudeInfo();
    const claudeOk = cl.loggedIn;
    if (!claudeOk) log('Claude Code 사용 불가: ' + cl.reason);
    const inputs = { ...st.inputs };
    const workDir = path.join(dir(id), '원자료', 'claude_' + region);
    if (region === 'overseas' && !inputs.keywordsEn.length) {
      inputs.keywordsEn = claudeOk ? await translateKeywords(inputs.keywords, workDir, log) : inputs.keywords.filter((k) => /^[\x00-\x7F]+$/.test(k));
    }
    const prog = (phase, lo, hi) => (f, text) => setProgress(id, (s) => { s.regions[region].phase = phase; s.regions[region].pct = Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, f))); s.regions[region].phaseText = text; s.phaseText = `${region === 'domestic' ? '국내' : '해외'} · ${text}`; });
    const { candidates, skipped } = await collectRegion(region, inputs, src.sources, src.groups, { workDir, log, claudeOk, onProgress: prog('collect', 0, 45) });
    writeJson(path.join(dir(id), '원자료', `후보_${region}.json`), candidates);
    const ver = await verifyAll(candidates, inputs.start, inputs.end, [...inputs.keywords, ...inputs.keywordsEn], log, prog('verify', 45, 100));
    const stamp = (x) => ({ ...x, collectedBy: memberName(runner), collectedAt: now() });
    writeJson(path.join(dir(id), `영역결과_${region}.json`), { region, by: memberName(runner), finishedAt: now(), keywordsEn: inputs.keywordsEn, skipped, verified: ver.verified.map(stamp), pending: ver.pending.map(stamp), rejected: ver.rejected.map(stamp) });
    const s2 = getStatus(id);
    // why items were left out, grouped ("조사기간 밖 (원문 날짜 …)" → "조사기간 밖")
    s2.regions[region] = { ...s2.regions[region], state: 'done', pct: 100, phase: 'done', phaseText: '완료', finishedAt: now(), counts: { candidates: candidates.length, verified: ver.verified.length, pending: ver.pending.length, rejected: ver.rejected.length }, reasons: { rejected: tally(ver.rejected), pending: tally(ver.pending) }, skipped };
    saveStatus(s2);
    log(`영역 완료 — 통과 ${ver.verified.length}건`);
  } catch (e) {
    const s2 = getStatus(id); s2.regions[region] = { ...s2.regions[region], state: 'error', error: e.message }; saveStatus(s2);
    log('오류: ' + e.message);
  } finally { busy.delete(key); }
  maybePublish(id);
}

export async function maybePublish(id, force = false) {
  const st = getStatus(id);
  const states = REGIONS.map((r) => st.regions[r].state);
  if (!force && !states.every((s) => s === 'done' || s === 'skipped')) {
    if (states.includes('handed')) { st.stage = 'waiting'; saveStatus(st); }
    return;
  }
  if (busy.has(id + ':publish')) return; busy.add(id + ':publish');
  try { await publish(id); } catch (e) { const s = getStatus(id); s.stage = 'error'; s.error = e.message; saveStatus(s); logTo(s, null, '발간 오류: ' + e.message); }
  finally { busy.delete(id + ':publish'); }
}

function csvEscape(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
export function itemsCsv(items) {
  const head = ['번호', '날짜', '주제', '자료제목', '링크', '출처기관', '자료유형', '국내/해외', '검증상태', '조사한 사람', '수집일시'];
  const rows = items.map((it) => [it.no, it.date, it.topic, it.title, it.url, it.org, it.type, it.region === 'domestic' ? '국내' : '해외', '검증 통과', it.collectedBy, it.collectedAt]);
  return '﻿' + [head, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

async function publish(id) {
  let st = getStatus(id);
  st.stage = 'publishing'; st.publishPct = 0; st.publishPhase = 'merge'; st.phaseText = '두 영역 결과 합치는 중'; saveStatus(st);
  const log = (m) => logTo(getStatus(id), null, m);
  const pp = (phase, pct, text) => setProgress(id, (s) => { s.publishPhase = phase; s.publishPct = pct; s.phaseText = text; }, true);
  // Claude steps give no intermediate signal: advance by elapsed time toward the step's end
  const timed = async (phase, lo, hi, text, estMs, fn) => {
    const t0 = Date.now(); pp(phase, lo, text);
    const tick = setInterval(() => pp(phase, Math.round(lo + (hi - lo) * Math.min(0.92, (Date.now() - t0) / estMs)), text), 2000);
    try { return await fn(); } finally { clearInterval(tick); pp(phase, hi, text); }
  };
  const topics = config('topics.json').topics;
  const parts = REGIONS.map((r) => readJson(path.join(dir(id), `영역결과_${r}.json`))).filter(Boolean);
  const verified = dedupeByTitle(parts.flatMap((p) => p.verified)).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  verified.forEach((it, i) => { it.no = i + 1; });
  const pending = parts.flatMap((p) => p.pending), rejected = parts.flatMap((p) => p.rejected);
  log(`발간 시작 — 합친 자료 ${verified.length}건 (중복 제거 후)`);
  const cl = claudeInfo();
  const workDir = path.join(dir(id), '원자료', 'claude_report');
  await timed('classify', 10, 35, '주제 분류 중', cl.loggedIn ? 60000 : 2000, () => classify(verified, topics, { claudeOk: cl.loggedIn, workDir, log }));
  const clusters = keywordClusters(verified);
  const inputs = st.inputs;
  const verifyStats = { verified: verified.length, pending: pending.length, rejected: rejected.length };
  const data = await timed('write', 35, 85, '보고서 문안 작성 중', cl.loggedIn ? 120000 : 2000, () => buildReportData(inputs, verified, topics, { claudeOk: cl.loggedIn, workDir, log }));
  pp('render', 90, '보고서 만드는 중');
  writeJson(path.join(dir(id), 'items.json'), { items: verified, pending, clusters, verifyStats });
  writeJson(path.join(dir(id), '검증기록.json'), { checkedAt: now(), stats: verifyStats, rules: '정상 응답(2xx) + 페이지 내 제목 일치 + 원문 게시일이 조사기간 안', verified: verified.map(({ no, title, url, date, dateSource, httpStatus, pageTitle }) => ({ no, title, url, date, dateSource, httpStatus, pageTitle })), pending: pending.map(({ title, url, reason }) => ({ title, url, reason })), rejected: rejected.map(({ title, url, reason }) => ({ title, url, reason })), reportDropped: data.dropped, skippedSources: parts.flatMap((p) => p.skipped || []) });
  fs.writeFileSync(path.join(dir(id), '조사자료목록.csv'), itemsCsv(verified), 'utf8');
  writeJson(path.join(dir(id), 'report.json'), data);
  // drop stale exports from an earlier publish of this run
  for (const f of Object.values(OUT)) fs.rmSync(path.join(dir(id), f), { force: true });
  const html = renderReportHtml({ inputs, items: verified, topics, data, verifyStats, runId: id });
  fs.writeFileSync(path.join(dir(id), '정책조사보고서.html'), html, 'utf8');
  // make every export now, so the serverless result page can carry them (A안)
  const sub = (lo, hi, label) => (pct, text) => pp('render', Math.round(lo + (hi - lo) * pct / 100), `${label} · ${text}`);
  for (const [fmt, lo, hi, label] of [['pdf', 86, 89, 'PDF 만드는 중'], ['hwpx', 89, 97, '한글(hwpx) 만드는 중'], ['web', 97, 99, '결과 웹페이지 만드는 중']]) {
    if (fmt === 'hwpx' && !exportCaps().hwpx) { log('한글 프로그램이 없어 hwpx는 건너뜀'); continue; }
    try { await exportReport(id, fmt, sub(lo, hi, label), { reuse: false }); }
    catch (e) { log(`${label.replace(' 만드는 중', '')} 생성 실패: ${e.message} — 대시보드에서 다시 내보내기 가능`); }
  }
  st = getStatus(id);
  st.stage = 'published'; st.publishPct = 100; st.publishPhase = 'done'; st.phaseText = '발간 완료'; st.publishedAt = now(); st.title = data.title; st.counts = verifyStats; delete st.error;
  saveStatus(st);
  log(`발간 완료 — ${data.title}`);
}

// ---- exports run as background jobs so the dashboard can show 0–100% ----
const jobs = new Map(); // `${id}:${fmt}` -> { pct, text, done, file, error, startedAt }
export const exportStatus = (id, fmt) => jobs.get(`${id}:${fmt}`) || null;
export function startExport(id, fmt) {
  const key = `${id}:${fmt}`;
  const cur = jobs.get(key);
  if (cur && !cur.done) return cur;
  const job = { fmt, pct: 0, text: '준비 중', done: false, startedAt: now() };
  jobs.set(key, job);
  const set = (pct, text) => { job.pct = Math.max(job.pct, Math.round(pct)); job.text = text; };
  exportReport(id, fmt, set)
    .then((f) => { set(100, '완료'); job.file = path.basename(f); job.done = true; })
    .catch((e) => { job.error = e.message; job.text = '실패: ' + e.message; job.done = true; });
  return job;
}
// a step with no progress signal: creep toward `hi` over `estMs`
async function creep(set, lo, hi, text, estMs, fn) {
  const t0 = Date.now(); set(lo, text);
  const tick = setInterval(() => set(lo + (hi - lo) * Math.min(0.95, (Date.now() - t0) / estMs), text), 500);
  try { return await fn(); } finally { clearInterval(tick); set(hi, text); }
}

const OUT = { pdf: '정책조사보고서.pdf', hwpx: '정책조사보고서.hwpx', web: '조사결과_대시보드.html' };
export async function exportReport(id, fmt, set = () => {}, { reuse = true } = {}) {
  const d = dir(id), html = path.join(d, '정책조사보고서.html');
  if (!fs.existsSync(html)) throw new Error('아직 발간되지 않았습니다');
  // made at publish time already and still current → hand it over at once
  const out = OUT[fmt] && path.join(d, OUT[fmt]);
  if (reuse && fmt !== 'web' && out && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(html).mtimeMs) { set(100, '발간 때 만든 파일'); return out; }
  const tmp = path.join(d, '원자료', 'export'); fs.mkdirSync(tmp, { recursive: true });
  if (fmt === 'pdf') return creep(set, 10, 95, 'PDF로 인쇄 중', 6000, () => toPdf(html, path.join(d, '정책조사보고서.pdf'), tmp));
  if (fmt === 'web') { set(30, '웹페이지 만드는 중'); return buildSnapshot(d, id); }
  if (fmt === 'hwpx') {
    set(5, '자료 불러오는 중');
    const { items, verifyStats } = readJson(path.join(d, 'items.json'));
    const data = readJson(path.join(d, 'report.json'));
    const topics = config('topics.json').topics;
    const st = getStatus(id);
    const svgs = reportCharts(items, st.inputs, topics);
    const ids = Object.keys(svgs), imgs = {};
    for (let k = 0; k < ids.length; k++) {
      set(10 + (k / ids.length) * 40, `그래프 이미지 만드는 중 (${k + 1}/${ids.length})`);
      Object.assign(imgs, await chartsToPng({ [ids[k]]: svgs[ids[k]] }, path.join(d, '그림'), tmp));
    }
    set(52, '한글 문서용 본문 만드는 중');
    const hwpHtml = path.join(tmp, 'report_hwp.html');
    fs.writeFileSync(hwpHtml, renderReportHtml({ inputs: st.inputs, items, topics, data, verifyStats, runId: id }, { chartImg: imgs, hwp: true }), 'utf8');
    return creep(set, 55, 97, '한글 프로그램으로 변환 중', 25000, () => toHwpx(hwpHtml, path.join(d, '정책조사보고서.hwpx'), tmp));
  }
  throw new Error('지원하지 않는 형식');
}

export function handoffIssueDraft(id) {
  const st = getStatus(id); const team = config('team.json');
  const r = REGIONS.find((x) => st.regions[x].state === 'handed'); if (!r) return null;
  const to = team.members.find((m) => m.id === st.regions[r].to);
  const i = st.inputs;
  return {
    title: `[넘김 요청] ${id} ${team.regions[r]} 자료 조사`,
    body: `@${to?.github} ${i.runnerName}이(가) ${team.regions[r]} 영역 조사를 넘겼어요.\n\n- 실행 폴더: \`runs/${id}\`\n- 키워드: ${i.keywords.join(', ')}${i.keywordsEn.length ? `\n- 해외 검색어: ${i.keywordsEn.join(', ')}` : ''}\n- 조사기간: ${i.start} ~ ${i.end}\n- 넘긴 영역: ${team.regions[r]}\n\n\`git pull\` 후 대시보드에서 **이어받기**를 눌러 주세요. 끝나면 이 Issue에 결과를 댓글로 남기고 닫아 주세요.`,
    assignee: to?.github,
  };
}
