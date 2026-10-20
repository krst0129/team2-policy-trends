// Run lifecycle: create → collect per region (self or handed over) → verify →
// merge both regions → classify → report. State lives in runs/<id>/진행상태.json
// so a partner can resume a handed-over region on another PC after `git pull`.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, readJson, writeJson, config, now } from './util.js';
import { claudeStatus } from './claude.js';
import { collectRegion, translateKeywords } from './collectors.js';
import { verifyAll, dedupeByTitle } from './verify.js';
import { classify, keywordClusters } from './classify.js';
import { buildReportData, renderReportHtml } from './report.js';
import { toPdf, toHwpx, chartsToPng } from './export.js';
import { buildSnapshot } from './snapshot.js';
import { hbar, columns, stack100, topicCounts, monthly, SOURCE_KIND, LIGHT } from '../dashboard/charts.js';

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
function saveStatus(st) { st.updatedAt = now(); writeJson(statusPath(st.id), st); }
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
    const { candidates, skipped } = await collectRegion(region, inputs, src.sources, src.groups, { workDir, log, claudeOk });
    writeJson(path.join(dir(id), '원자료', `후보_${region}.json`), candidates);
    const ver = await verifyAll(candidates, inputs.start, inputs.end, [...inputs.keywords, ...inputs.keywordsEn], log);
    const stamp = (x) => ({ ...x, collectedBy: memberName(runner), collectedAt: now() });
    writeJson(path.join(dir(id), `영역결과_${region}.json`), { region, by: memberName(runner), finishedAt: now(), keywordsEn: inputs.keywordsEn, skipped, verified: ver.verified.map(stamp), pending: ver.pending.map(stamp), rejected: ver.rejected.map(stamp) });
    const s2 = getStatus(id);
    s2.regions[region] = { ...s2.regions[region], state: 'done', finishedAt: now(), counts: { candidates: candidates.length, verified: ver.verified.length, pending: ver.pending.length, rejected: ver.rejected.length }, skipped };
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
  st.stage = 'publishing'; saveStatus(st);
  const log = (m) => logTo(getStatus(id), null, m);
  const topics = config('topics.json').topics;
  const parts = REGIONS.map((r) => readJson(path.join(dir(id), `영역결과_${r}.json`))).filter(Boolean);
  const verified = dedupeByTitle(parts.flatMap((p) => p.verified)).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  verified.forEach((it, i) => { it.no = i + 1; });
  const pending = parts.flatMap((p) => p.pending), rejected = parts.flatMap((p) => p.rejected);
  log(`발간 시작 — 합친 자료 ${verified.length}건 (중복 제거 후)`);
  const cl = claudeInfo();
  const workDir = path.join(dir(id), '원자료', 'claude_report');
  await classify(verified, topics, { claudeOk: cl.loggedIn, workDir, log });
  const clusters = keywordClusters(verified);
  const inputs = st.inputs;
  const verifyStats = { verified: verified.length, pending: pending.length, rejected: rejected.length };
  const data = await buildReportData(inputs, verified, topics, { claudeOk: cl.loggedIn, workDir, log });
  writeJson(path.join(dir(id), 'items.json'), { items: verified, pending, clusters, verifyStats });
  writeJson(path.join(dir(id), '검증기록.json'), { checkedAt: now(), stats: verifyStats, rules: '정상 응답(2xx) + 페이지 내 제목 일치 + 원문 게시일이 조사기간 안', verified: verified.map(({ no, title, url, date, dateSource, httpStatus, pageTitle }) => ({ no, title, url, date, dateSource, httpStatus, pageTitle })), pending: pending.map(({ title, url, reason }) => ({ title, url, reason })), rejected: rejected.map(({ title, url, reason }) => ({ title, url, reason })), reportDropped: data.dropped, skippedSources: parts.flatMap((p) => p.skipped || []) });
  fs.writeFileSync(path.join(dir(id), '조사자료목록.csv'), itemsCsv(verified), 'utf8');
  writeJson(path.join(dir(id), 'report.json'), data);
  const html = renderReportHtml({ inputs, items: verified, topics, data, verifyStats, runId: id });
  fs.writeFileSync(path.join(dir(id), '정책조사보고서.html'), html, 'utf8');
  st = getStatus(id);
  st.stage = 'published'; st.publishedAt = now(); st.title = data.title; st.counts = verifyStats; delete st.error;
  saveStatus(st);
  log(`발간 완료 — ${data.title}`);
}

export async function exportReport(id, fmt) {
  const d = dir(id), html = path.join(d, '정책조사보고서.html');
  if (!fs.existsSync(html)) throw new Error('아직 발간되지 않았습니다');
  const tmp = path.join(d, '원자료', 'export'); fs.mkdirSync(tmp, { recursive: true });
  if (fmt === 'pdf') return toPdf(html, path.join(d, '정책조사보고서.pdf'), tmp);
  if (fmt === 'web') return buildSnapshot(d, id);
  if (fmt === 'hwpx') {
    const { items, verifyStats } = readJson(path.join(d, 'items.json'));
    const data = readJson(path.join(d, 'report.json'));
    const topics = config('topics.json').topics;
    const st = getStatus(id);
    const kinds = ['정부·공공기관', '연구기관·보고서', '언론'].map((k) => ({ label: k, value: items.filter((i) => SOURCE_KIND(i.type) === k).length }));
    const regions = [{ label: '국내', value: items.filter((i) => i.region === 'domestic').length }, { label: '해외', value: items.filter((i) => i.region === 'overseas').length }];
    const orgMap = new Map(); for (const i of items) orgMap.set(i.org, (orgMap.get(i.org) || 0) + 1);
    const orgs = [...orgMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ key: k, label: k.length > 16 ? k.slice(0, 15) + '…' : k, value: v }));
    const svgs = {
      topics: hbar(topicCounts(items, topics).filter((c) => c.value), { theme: LIGHT, width: 620 }),
      months: columns(monthly(items, st.inputs.start, st.inputs.end), { theme: LIGHT, width: 620, height: 200 }),
      kinds: stack100(kinds, { theme: LIGHT, width: 620 }),
      regions: stack100(regions, { theme: LIGHT, width: 620 }),
      orgs: hbar(orgs, { theme: LIGHT, width: 620, labelW: 170, rowH: 26 }),
    };
    const imgs = await chartsToPng(svgs, path.join(d, '그림'), tmp);
    const hwpHtml = path.join(tmp, 'report_hwp.html');
    fs.writeFileSync(hwpHtml, renderReportHtml({ inputs: st.inputs, items, topics, data, verifyStats, runId: id }, { chartImg: imgs, hwp: true }), 'utf8');
    return toHwpx(hwpHtml, path.join(d, '정책조사보고서.hwpx'), tmp);
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
