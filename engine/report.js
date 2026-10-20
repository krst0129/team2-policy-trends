// Report builder. Every sentence must cite verified item numbers; sentences whose
// numbers or quotes are not found in the cited items are dropped (거짓 방지 규칙 5).
import { runClaude, extractJson } from './claude.js';
import { escHtml } from './util.js';
import { hbar, columns, stack100, heatTable, topicCounts, monthly, SOURCE_KIND, LIGHT } from '../dashboard/charts.js';

const fmtD = (d) => { const [y, m, dd] = d.split('-'); return `${y}. ${+m}. ${+dd}.`; };
const ym = (d) => `${d.slice(0, 4)}.${+d.slice(5, 7)}`;

export function reportTitle(inputs, items, topics) {
  const top = topicCounts(items, topics).filter((t) => t.key !== 'etc' && t.value > 0).slice(0, 2).map((t) => t.label.split('·')[0]);
  const kw = inputs.keywords.slice(0, 3).join('·') + (inputs.keywords.length > 3 ? ' 외' : '');
  return `「${kw}」 정책동향 보고서${top.length ? `: ${top.join('·')} 중심` : ''} (${ym(inputs.start)}~${ym(inputs.end)})`;
}

const digits = (s) => (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => x.replace(/,/g, ''));
function validateSentence(sent, byNo) {
  const refs = (sent.refs || []).map(Number).filter((n) => byNo.has(n));
  if (!sent.text || !refs.length) return { ok: false, why: '근거 번호 없음' };
  const src = refs.map((n) => { const it = byNo.get(n); return `${it.title} ${it.snippet || ''} ${it.date} ${it.org}`; }).join(' ');
  const srcDigits = new Set(digits(src));
  const missing = digits(sent.text).filter((d) => d.length >= 2 && !srcDigits.has(d) && !/^(19|20)\d\d$/.test(d));
  if (missing.length) return { ok: false, why: `근거에 없는 수치 ${missing.join(', ')}` };
  for (const q of sent.text.match(/[“"「『]([^”"」』]{4,})[”"」』]/g) || []) {
    const inner = q.slice(1, -1).replace(/\s/g, '');
    if (!src.replace(/\s/g, '').includes(inner)) return { ok: false, why: `근거에 없는 인용 ${q}` };
  }
  return { ok: true, text: sent.text, refs };
}

async function writeWithClaude(inputs, items, topics, workDir, log) {
  const list = items.map((it) => `[${it.no}] (${it.date}, ${it.org}, ${it.region === 'domestic' ? '국내' : '해외'}, 주제:${it.topicId}) ${it.title} — ${(it.snippet || '').slice(0, 160)}`).join('\n');
  const prompt = `아래는 링크 검증을 통과한 정책 자료 목록입니다. 이 목록만 근거로 정책동향 보고서 문안을 쓰세요.
[키워드] ${inputs.keywords.join(', ')}  [기간] ${inputs.start} ~ ${inputs.end}
[주제] ${topics.map((t) => `${t.id}=${t.name}`).join(', ')}

[규칙]
- 목록에 없는 사실, 수치, 기관, 인용은 절대 쓰지 마세요. 수치는 목록에 적힌 숫자 그대로만 쓰세요.
- 모든 문장에 근거 자료 번호(refs)를 다세요.
- 개조식 공문서 문체(~함, ~임)로, 한 문장은 2줄 이내.
- 문장 수: summary 3~5, 주제마다 1~3(자료가 있는 주제만), implications 3~4.

[자료 목록]
${list}

JSON으로만 답하세요:
{"summary":[{"text":"...","refs":[1,2]}],"topics":{"주제id":[{"text":"...","refs":[3]}]},"implications":[{"text":"...","refs":[4,5]}]}`;
  const res = await runClaude(prompt, { maxTurns: 3, workDir, timeoutMs: 6 * 60 * 1000 });
  return extractJson(res.text);
}

export async function buildReportData(inputs, items, topics, { claudeOk, workDir, log }) {
  const byNo = new Map(items.map((it) => [it.no, it]));
  const counts = topicCounts(items, topics);
  const dropped = [];
  let text = null;
  if (claudeOk && items.length) {
    try { text = await writeWithClaude(inputs, items, topics, workDir, log); } catch (e) { log('보고서 문안 작성 실패, 기본 문안 사용: ' + e.message); }
  }
  const check = (arr = []) => arr.map((s) => { const v = validateSentence(s, byNo); if (!v.ok) dropped.push({ text: s.text, why: v.why }); return v; }).filter((v) => v.ok);
  const summary = text ? check(text.summary) : [];
  const implications = text ? check(text.implications) : [];
  const topicText = {};
  for (const t of topics) topicText[t.id] = text ? check(text.topics?.[t.id]) : [];
  if (dropped.length) log(`보고서 문장 ${dropped.length}개를 근거 불일치로 뺐음`);
  // fallback summary from our own counts (no external claims)
  if (!summary.length) {
    const top = counts.filter((c) => c.value).slice(0, 3).map((c) => `${c.label} ${c.value}건`).join(', ');
    summary.push({ text: `조사기간 중 검증을 통과한 자료는 총 ${items.length}건이며, 주제별로는 ${top} 순으로 많음`, refs: [], own: true });
  }
  return { title: reportTitle(inputs, items, topics), counts, summary, implications, topicText, dropped, generatedBy: text ? 'claude' : 'template' };
}

/** Render the report as HTML. `chartImg` (optional) maps chart id → image path for hwpx (no inline SVG there). */
// Hangul's HTML import ignores flex/@page and hangs on external hyperlinks, so the
// hwpx variant uses plain block styles and no <a> links (links stay in CSV/PDF).
const HWP_CSS = `body, p, td, th, h1, h2, h3 { font-family: '맑은 고딕'; } body { font-size: 10pt; line-height: 160%; } .cap { font-size: 9pt; color: #52514e; text-align: left; }
.cover { text-align: center; } .kicker { color: #52514e; font-size: 10pt; } h1 { font-size: 18pt; color: #1F3864; } .meta { font-size: 9pt; color: #52514e; }
h2 { font-size: 14pt; color: #1F3864; } h3 { font-size: 11.5pt; } .cnt { color: #52514e; font-size: 10pt; }
.b1 { margin-left: 8pt; } .b2 { margin-left: 22pt; font-size: 9.5pt; } .lbl { margin-left: 8pt; font-weight: bold; font-size: 9.5pt; color: #52514e; }
.ref { color: #2a78d6; font-size: 8.5pt; } .muted { color: #898781; } figcaption { font-size: 9pt; color: #52514e; }
table { border-collapse: collapse; } td, th { border: 1px solid #c3c2b7; padding: 3pt; font-size: 9pt; } th { background: #EEF3FA; } .note { font-size: 8.5pt; color: #52514e; }`;

export function renderReportHtml({ inputs, items, topics, data, verifyStats, runId }, { chartImg = null, hwp = false } = {}) {
  const T = LIGHT;
  const byTopic = Object.fromEntries(topics.map((t) => [t.id, items.filter((i) => i.topicId === t.id)]));
  const kinds = ['정부·공공기관', '연구기관·보고서', '언론'].map((k) => ({ label: k, value: items.filter((i) => SOURCE_KIND(i.type) === k).length }));
  const regions = [{ label: '국내', value: items.filter((i) => i.region === 'domestic').length }, { label: '해외', value: items.filter((i) => i.region === 'overseas').length }];
  const orgMap = new Map(); for (const i of items) orgMap.set(i.org, (orgMap.get(i.org) || 0) + 1);
  const orgs = [...orgMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ key: k, label: k.length > 16 ? k.slice(0, 15) + '…' : k, value: v }));
  const months = monthly(items, inputs.start, inputs.end);
  const tRows = data.counts.filter((c) => c.value);
  const heat = heatTable(tRows.map((r) => r.label), months.map((m) => m.label), tRows.map((r) => months.map((m) => items.filter((i) => i.topicId === r.key && i.date.startsWith(m.key)).length)), { theme: T });

  const fig = (id, svg, caption) => `<figure class="fig">${chartImg?.[id] ? `<img src="${chartImg[id].file}" width="${chartImg[id].w}" alt="${escHtml(caption)}">` : svg}<figcaption>${escHtml(caption)}</figcaption></figure>`;
  const charts = {
    topics: hbar(data.counts.filter((c) => c.value), { theme: T, width: 620 }),
    months: columns(months, { theme: T, width: 620, height: 200 }),
    kinds: stack100(kinds, { theme: T, width: 620 }),
    regions: stack100(regions, { theme: T, width: 620 }),
    orgs: hbar(orgs, { theme: T, width: 620, labelW: 170, rowH: 26 }),
  };
  const ref = (refs) => (refs?.length ? ` <span class="ref">[${refs.join(', ')}]</span>` : '');
  const bullets = (arr) => arr.map((s) => `<p class="b1">○ ${escHtml(s.text)}${ref(s.refs)}</p>`).join('');

  let topicSecs = '';
  let n = 1;
  for (const c of data.counts.filter((x) => x.value)) {
    const list = byTopic[c.key].slice().sort((a, b) => b.date.localeCompare(a.date));
    topicSecs += `<h3>${n++}. ${escHtml(c.label)} <span class="cnt">(${c.value}건)</span></h3>`;
    topicSecs += bullets(data.topicText[c.key] || []);
    topicSecs += `<p class="lbl">주요 자료</p>` + list.slice(0, 6).map((it) => `<p class="b2">- ${escHtml(it.org)}(${fmtD(it.date)}) ${escHtml(it.title)} <span class="ref">[${it.no}]</span></p>`).join('');
    if (list.length > 6) topicSecs += `<p class="b2 muted">외 ${list.length - 6}건은 붙임 목록 참조</p>`;
  }

  const listRows = items.map((it) => `<tr><td class="c">${it.no}</td><td class="c nw">${it.date}</td><td>${escHtml(it.topic)}</td><td>${hwp ? escHtml(it.title) : `<a href="${escHtml(it.url)}">${escHtml(it.title)}</a>`}</td><td>${escHtml(it.org)}</td><td class="c">${it.region === 'domestic' ? '국내' : '해외'}</td></tr>`).join('');
  const kpiCells = [[items.length, '검증 통과 자료'], [`${regions[0].value} / ${regions[1].value}`, '국내 / 해외'], [tRows.length, '주제 수'], [verifyStats.pending, '검증 보류(목록 제외)']];
  const kpis = `<table class="kpis" style="width:100%"><tr>${kpiCells.map(([v, l]) => `<td class="kpi" style="text-align:center"><b style="font-size:16pt;color:#1F3864">${v}</b><br><span>${l}</span></td>`).join('')}</tr></table>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escHtml(data.title)}</title><style>
@page { size: A4; margin: 18mm 17mm 18mm 17mm; }
body { font-family: 'Malgun Gothic', system-ui, sans-serif; color: ${T.ink}; font-size: 10.5pt; line-height: 1.6; margin: 0; background: #fff; }
.page { max-width: 176mm; margin: 0 auto; }
.cover { text-align: center; padding: 18mm 0 8mm; border-bottom: 3px solid #1F3864; margin-bottom: 8mm; }
.cover .kicker { color: ${T.ink2}; font-size: 10pt; letter-spacing: .1em; }
.cover h1 { font-size: 20pt; color: #1F3864; margin: 6mm 0 4mm; line-height: 1.35; }
.cover .meta { color: ${T.ink2}; font-size: 9.5pt; }
.kpis { border-collapse: separate; border-spacing: 3mm 0; margin: 6mm -3mm; }
.kpi { border: 1px solid ${T.grid}; border-radius: 6px; padding: 3mm 4mm; }
.kpi span { color: ${T.ink2}; font-size: 9pt; }
.box { border: 1px solid #1F3864; background: #EEF3FA; padding: 4mm 5mm; border-radius: 4px; }
.box h2 { margin: 0 0 2mm; font-size: 11.5pt; color: #1F3864; border: 0; }
h2 { font-size: 14pt; color: #1F3864; border-bottom: 2px solid #1F3864; padding-bottom: 1mm; margin: 9mm 0 3mm; }
h3 { font-size: 11.5pt; margin: 6mm 0 2mm; } .cnt { color: ${T.ink2}; font-weight: 400; font-size: 10pt; }
.b1 { margin: 1mm 0 1mm 3mm; } .b2 { margin: .5mm 0 .5mm 8mm; font-size: 9.5pt; } .lbl { margin: 2mm 0 0 3mm; font-weight: 700; font-size: 9.5pt; color: ${T.ink2}; }
.ref { color: #2a78d6; font-size: 8.5pt; } .muted { color: ${T.muted}; }
.fig { margin: 4mm 0; page-break-inside: avoid; } .fig figcaption { font-size: 9pt; color: ${T.ink2}; margin-top: 1mm; }
.two { display: flex; gap: 6mm; } .two > * { flex: 1; }
table.list { border-collapse: collapse; width: 100%; font-size: 8.5pt; } table.list th, table.list td { border: 1px solid ${T.grid}; padding: 1.2mm 1.5mm; vertical-align: top; }
table.list th { background: #EEF3FA; } .c { text-align: center; } .nw { white-space: nowrap; } a { color: inherit; text-decoration: none; }
.pb { page-break-before: always; } .note { font-size: 8.5pt; color: ${T.ink2}; }
</style></head><body><div class="page">
<div class="cover"><div class="kicker">과학기술정책 동향 조사 보고서</div><h1>${escHtml(data.title)}</h1>
<div class="meta">조사기간 ${fmtD(inputs.start)} ~ ${fmtD(inputs.end)} │ 키워드: ${escHtml(inputs.keywords.join(', '))}<br>발간일 ${fmtD(new Date().toISOString().slice(0, 10))} │ 신흥기술영향평가 2인1조 (실행 ${escHtml(runId)})</div></div>
${kpis}
<div class="box"><h2>핵심 요약</h2>${data.summary.map((s) => `<p class="b1">◇ ${escHtml(s.text)}${ref(s.refs)}</p>`).join('')}</div>
<h2>Ⅰ. 조사 개요</h2>
${fig('topics', charts.topics, '[그림 1] 주제별 자료 수')}
${fig('months', charts.months, '[그림 2] 월별 자료 수')}
${fig('kinds', charts.kinds, '[그림 3] 출처 유형별 비중')}
${fig('regions', charts.regions, '[그림 4] 국내·해외 비중')}
<div class="pb"></div>
${fig('orgs', charts.orgs, '[그림 5] 자료가 많은 기관 상위 10곳')}
<figure class="fig">${heat}<figcaption>[표 1] 주제 × 월별 자료 수</figcaption></figure>
<h2>Ⅱ. 주제별 주요 동향</h2>${topicSecs}
<h2>Ⅲ. 시사점</h2>${data.implications.length ? bullets(data.implications) : '<p class="b1 muted">○ (자동 작성된 시사점 없음 — 대시보드에서 직접 작성)</p>'}
<h2 class="pb">붙임. 조사자료 목록 (${items.length}건)</h2>
<table class="list"><tr><th>No.</th><th>날짜</th><th>주제</th><th>자료제목</th><th>출처기관</th><th>구분</th></tr>${listRows}</table>
<p class="note">※ 모든 자료는 링크 검증기(정상 응답·제목 일치·원문 게시일)를 통과한 것만 실었음. 검증 통과 ${verifyStats.verified}건, 보류 ${verifyStats.pending}건, 제외 ${verifyStats.rejected}건. 본문의 [번호]는 붙임 목록 번호임.${data.dropped.length ? ` 근거와 맞지 않아 뺀 자동 작성 문장 ${data.dropped.length}개.` : ''}${hwp ? ' 원문 링크는 함께 내보낸 CSV·PDF에 있음.' : ''}</p>
</div></body></html>`;
  if (!hwp) return html;
  return html.replace(/<style>[\s\S]*?<\/style>/, `<style>${HWP_CSS}</style>`)
    .replace(/<div class="pb"><\/div>/g, '<p class="pb">@@PB@@</p>').replace(/<h2 class="pb">/g, '<p class="pb">@@PB@@</p><h2>')
    .replace(/<figcaption>/g, '<p class="cap" style="text-align:left">').replace(/<\/figcaption>/g, '</p>').replace(/<figure class="fig">/g, '<div>').replace(/<\/figure>/g, '</div>')
    .replace(/<div class="cover"><div class="kicker">([\s\S]*?)<\/div><h1>([\s\S]*?)<\/h1>\s*<div class="meta">([\s\S]*?)<\/div><\/div>/, '<p style="text-align:center;font-size:10pt;color:#52514e">$1</p><h1 style="text-align:center">$2</h1><p style="text-align:center;font-size:9pt;color:#52514e">$3</p>')
    .replace(/<table class="kpis" style="width:100%">/, '<table class="kpis" width="600" style="width:150mm">').replace(/<td class="kpi" style="text-align:center">/g, '<td class="kpi" width="150" style="text-align:center">')
    .replace(/<h([123])([^>]*)>/g, (m, n, a) => `<h${n}${a.includes('style=') ? a.replace('style="', 'style="font-family:\'맑은 고딕\';') : `${a} style="font-family:'맑은 고딕'"`}>`)
    .replace(/style="width:100%"/g, 'style="width:150mm"').replace('<table class="list">', '<table class="list" style="width:150mm">').replace(/border-collapse:collapse;font-size:12px;width:100%/, 'border-collapse:collapse;font-size:12px;width:150mm');
}

export const CHART_SIZES = { topics: 620, months: 620, kinds: 620, regions: 620, orgs: 620 };
