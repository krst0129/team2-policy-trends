// Policy report in the v1 weekly-report format:
// 표지 → 이번 주 핵심 → Ⅰ. 요약(주요 동향·수집 현황·그림) → Ⅱ. 주제별 주요 동향 → Ⅲ. 시사점 → 붙임 → ※ 확인 필요
// Every sentence cites verified item numbers; sentences whose numbers or quotes are
// not found in the cited items are dropped (거짓 방지 규칙 5). 출처 lines are built
// from the cited items themselves, never from model text.
import { runClaude, extractJson } from './claude.js';
import { escHtml } from './util.js';
import { hbar, line, stack100, heatTable, topicCounts, monthly, weekly, SOURCE_KIND, LIGHT } from '../dashboard/charts.js';

const fmtD = (d) => { const [y, m, dd] = d.split('-'); return `${y}. ${+m}. ${+dd}.`; };
const shortD = (d) => `${d.slice(0, 4)}.${+d.slice(5, 7)}.${+d.slice(8)}`;
const ym = (d) => `${d.slice(0, 4)}.${+d.slice(5, 7)}`;

export function reportTitle(inputs, items, topics) {
  const top = topicCounts(items, topics).filter((t) => t.key !== 'etc' && t.value > 0).slice(0, 2).map((t) => t.label.split('·')[0]);
  const kw = inputs.keywords.slice(0, 3).join('·') + (inputs.keywords.length > 3 ? ' 외' : '');
  return `「${kw}」 정책동향 보고서${top.length ? `: ${top.join('·')} 중심` : ''} (${ym(inputs.start)}~${ym(inputs.end)})`;
}

// ---------- validation ----------
const digits = (s) => (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => x.replace(/,/g, ''));
function checkText(text, refs, byNo) {
  refs = (refs || []).map(Number).filter((n) => byNo.has(n));
  if (!text || !refs.length) return { ok: false, why: '근거 번호 없음' };
  const src = refs.map((n) => { const it = byNo.get(n); return `${it.title} ${it.snippet || ''} ${it.date} ${it.org}`; }).join(' ');
  const srcDigits = new Set(digits(src));
  const missing = digits(text).filter((d) => d.length >= 2 && !srcDigits.has(d) && !/^(19|20)\d\d$/.test(d));
  if (missing.length) return { ok: false, why: `근거에 없는 수치 ${missing.join(', ')}` };
  for (const q of text.match(/[“"「『]([^”"」』]{4,})[”"」』]/g) || []) {
    const inner = q.slice(1, -1).replace(/\s/g, '');
    if (!src.replace(/\s/g, '').includes(inner)) return { ok: false, why: `근거에 없는 인용 ${q}` };
  }
  return { ok: true, text, refs };
}

// ---------- charts (shared by HTML/PDF and hwpx PNGs) ----------
export function reportCharts(items, inputs, topics) {
  const kinds = ['정부·공공기관', '연구기관·보고서', '언론'].map((k) => ({ label: k, value: items.filter((i) => SOURCE_KIND(i.type) === k).length }));
  const regions = [{ label: '국내', value: items.filter((i) => i.region === 'domestic').length }, { label: '해외', value: items.filter((i) => i.region === 'overseas').length }];
  const orgMap = new Map(); for (const i of items) orgMap.set(i.org, (orgMap.get(i.org) || 0) + 1);
  const orgs = [...orgMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ key: k, label: k.length > 18 ? k.slice(0, 17) + '…' : k, value: v }));
  return {
    topics: hbar(topicCounts(items, topics).filter((c) => c.value), { theme: LIGHT, width: 600, labelW: 140 }),
    weekly: line(weekly(items, inputs.start, inputs.end), { theme: LIGHT, width: 600, height: 220 }),
    kinds: stack100(kinds, { theme: LIGHT, width: 600 }),
    regions: stack100(regions, { theme: LIGHT, width: 600 }),
    orgs: hbar(orgs, { theme: LIGHT, width: 600, labelW: 190, rowH: 26 }),
  };
}

// ---------- text ----------
async function writeWithClaude(inputs, items, topics, workDir) {
  const list = items.map((it) => `[${it.no}] (${it.date}, ${it.org}, ${it.region === 'domestic' ? '국내' : '해외'}, ${it.type}, 주제:${it.topicId}) ${it.title} — ${(it.snippet || '').slice(0, 160)}`).join('\n');
  const prompt = `아래는 링크 검증을 통과한 정책 자료 목록입니다. 이 목록만 근거로, 국책연구기관(STEPI·KISTEP) 정책동향 보고서 문체의 문안을 쓰세요.
[키워드] ${inputs.keywords.join(', ')}  [기간] ${inputs.start} ~ ${inputs.end}
[주제] ${topics.map((t) => `${t.id}=${t.name}`).join(', ')}

[규칙]
- 목록에 없는 사실·수치·기관·인용은 절대 쓰지 마세요. 수치는 목록에 적힌 숫자 그대로만.
- 모든 문장에 근거 자료 번호(refs)를 다세요. 출처 표기는 쓰지 마세요(자동으로 붙습니다).
- 개조식 공문서 문체(~함, ~임, ~추진), 한 문장 2줄 이내. 「」로 정책·문서명을 감싸세요.
- 문장 안에 큰따옴표(")를 절대 쓰지 마세요. 인용은 ‘ ’ 또는 「 」를 쓰세요. 출력은 반드시 올바른 JSON이어야 합니다.
- highlights: 이번 기간 가장 중요한 흐름 3개.
- summary: (분야) 꼬리표가 붙은 주요 동향 4~6개. label 예: 정부 전략, 법·제도, 예산·사업, 통계·분석, 산업·기술, 해외.
- topics: 자료가 있는 주제마다 headline(□ 한 줄 핵심 메시지)과 points 1~3개, 각 point에 subs(세부) 0~2개.
- implications: 3~4개, keyword(2~5자 꼬리표)와 title(한 줄)과 points 1~2개.

[자료 목록]
${list}

JSON으로만 답하세요:
{"highlights":[{"text":"","refs":[1]}],
 "summary":[{"label":"정부 전략","text":"","refs":[1,2]}],
 "topics":{"주제id":{"headline":"","refs":[1],"points":[{"text":"","refs":[1],"subs":[{"text":"","refs":[1]}]}]}},
 "implications":[{"keyword":"","title":"","refs":[1],"points":[{"text":"","refs":[1]}]}]}`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = attempt === 1 ? prompt : prompt + `\n\n[주의] 직전 답변이 JSON 형식 오류(${lastErr})로 읽히지 않았습니다. 문장 안 큰따옴표를 없애고, 올바른 JSON만 다시 출력하세요.`;
    const res = await runClaude(p, { maxTurns: 3, workDir, timeoutMs: 8 * 60 * 1000 });
    try { return extractJson(res.text); } catch (e) { lastErr = e.message; }
  }
  throw new Error('JSON 형식 오류: ' + lastErr);
}

export async function buildReportData(inputs, items, topics, { claudeOk, workDir, log }) {
  const byNo = new Map(items.map((it) => [it.no, it]));
  const counts = topicCounts(items, topics);
  const dropped = [];
  // bullets (□ ○ ◇ - ·) are added by the renderer; strip any the model already wrote
  const clean = (t) => (t == null ? t : String(t).replace(/^[\s□■○●◇◆\-–·*※]+/, '').trim());
  const ok = (t, refs) => { t = clean(t); const v = checkText(t, refs, byNo); if (!v.ok && t) dropped.push({ text: t, why: v.why }); return v.ok ? v : null; };
  let raw = null;
  if (claudeOk && items.length) {
    try { raw = await writeWithClaude(inputs, items, topics, workDir); } catch (e) { log('보고서 문안 작성 실패, 기본 문안 사용: ' + e.message); }
  }
  const byTopic = Object.fromEntries(topics.map((t) => [t.id, items.filter((i) => i.topicId === t.id).sort((a, b) => b.date.localeCompare(a.date))]));
  const itemLine = (it) => ({ text: `${it.org}(${shortD(it.date)}) ${it.title}`, refs: [it.no], subs: [] });

  const highlights = (raw?.highlights || []).map((h) => ok(h.text, h.refs)).filter(Boolean);
  // the model sometimes repeats a "(분야)" tag at the start of the text — keep only the label field
  const stripTag = (t = '') => String(t).replace(/^(\s*\([^)]{1,14}\)\s*)+/, '');
  const summary = (raw?.summary || []).map((s) => { const v = ok(stripTag(s.text), s.refs); return v && { ...v, label: String(s.label || '').replace(/[()]/g, '').slice(0, 10) }; }).filter(Boolean);
  const topicText = {};
  for (const c of counts.filter((x) => x.value)) {
    const r = raw?.topics?.[c.key];
    const points = (r?.points || []).map((p) => { const v = ok(p.text, p.refs); if (!v) return null; return { ...v, subs: (p.subs || []).map((s) => ok(s.text, s.refs)).filter(Boolean) }; }).filter(Boolean);
    const allRefs = [...new Set([...(r?.refs || []), ...points.flatMap((p) => [...p.refs, ...p.subs.flatMap((s) => s.refs)])])];
    const head = r?.headline ? ok(r.headline, allRefs) : null;
    topicText[c.key] = {
      headline: head?.text || `${c.label} 관련 자료 ${c.value}건이 수집됨`,
      points: points.length ? points : byTopic[c.key].slice(0, 4).map(itemLine),
      generated: !!points.length,
    };
  }
  const implications = (raw?.implications || []).map((m) => {
    const points = (m.points || []).map((p) => ok(p.text, p.refs)).filter(Boolean);
    if (!points.length) return null;
    const t = ok(m.title, [...new Set([...(m.refs || []), ...points.flatMap((p) => p.refs)])]);
    return t && { keyword: String(m.keyword || '').slice(0, 8), title: t.text, points };
  }).filter(Boolean);

  // fallbacks built only from our own counts and item titles
  if (!highlights.length) {
    const top = counts.filter((c) => c.value && c.key !== 'etc').slice(0, 3).map((c) => `${c.label} ${c.value}건`).join(', ');
    highlights.push({ text: `조사기간 중 링크 검증을 통과한 자료는 총 ${items.length}건이며, 주제별로는 ${top || '기타'} 순으로 많음`, refs: [] });
  }
  if (!summary.length) {
    for (const c of counts.filter((x) => x.value && x.key !== 'etc').slice(0, 5)) {
      const it = byTopic[c.key][0];
      summary.push({ label: c.label.split('·')[0], text: `${c.value}건 수집. 최근 자료는 ${it.org}(${shortD(it.date)}) 「${it.title}」`, refs: [it.no] });
    }
  }
  if (dropped.length) log(`보고서 문장 ${dropped.length}개를 근거 불일치로 뺐음`);
  return { title: reportTitle(inputs, items, topics), counts, highlights, summary, topicText, implications, dropped, generatedBy: raw ? 'claude' : 'template' };
}

// ---------- render (inline styles so the same HTML works in Edge PDF and Hangul) ----------
const S = {
  t1: "font-family:'맑은 고딕'; font-size:20pt; font-weight:bold; text-align:center; color:#1F3864; margin:0 0 6pt 0; line-height:140%;",
  t2: "font-family:'맑은 고딕'; font-size:12pt; text-align:center; margin:0 0 4pt 0;",
  meta: "font-family:'맑은 고딕'; font-size:9pt; text-align:center; color:#555555; margin:0 0 2pt 0;",
  boxh: "font-family:'맑은 고딕'; font-size:11pt; font-weight:bold; color:#1F3864; margin:2pt 0 4pt 0;",
  h1: "font-family:'맑은 고딕'; font-size:15pt; font-weight:bold; color:#1F3864; margin:16pt 0 6pt 0; border-bottom:2px solid #1F3864;",
  h2: "font-family:'맑은 고딕'; font-size:13pt; font-weight:bold; color:#1F3864; margin:12pt 0 4pt 0;",
  h3: "font-family:'맑은 고딕'; font-size:11pt; font-weight:bold; margin:8pt 0 3pt 0;",
  b1: "font-family:'함초롬바탕','Batang',serif; font-size:10.5pt; line-height:160%; margin:2pt 0 2pt 12pt;",
  b2: "font-family:'함초롬바탕','Batang',serif; font-size:10pt; line-height:150%; margin:1pt 0 1pt 26pt;",
  src: "font-family:'맑은 고딕'; font-size:8.5pt; color:#666666; margin:1pt 0 4pt 26pt;",
  cap: "font-family:'맑은 고딕'; font-size:9pt; color:#444444; margin:2pt 0 8pt 0; text-align:left;",
  ref: "color:#2a78d6; font-size:8.5pt;",
};
const P = (cls, html) => `<p style="${S[cls]}">${html}</p>`;
const TBL = 'width:150mm; border-collapse:collapse; margin:4pt 0 6pt 0;';
const TH = "border:1px solid #8EA9DB; background:#D9E2F3; font-family:'맑은 고딕'; font-size:9.5pt; font-weight:bold; padding:3pt; text-align:center;";
const TD = "border:1px solid #8EA9DB; font-family:'맑은 고딕'; font-size:9pt; padding:3pt;";
const table = (head, rows, widths = []) => `<table style="${TBL}" width="600" cellpadding="3"><tr>${head.map((h, i) => `<th style="${TH}${widths[i] ? ` width:${widths[i]}mm;` : ''}">${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('')}</table>`;

export function renderReportHtml({ inputs, items, topics, data, verifyStats, runId, team }, { chartImg = null, hwp = false } = {}) {
  const byNo = new Map(items.map((it) => [it.no, it]));
  const ref = (refs) => (refs?.length ? ` <span style="${S.ref}">[${refs.join(', ')}]</span>` : '');
  const srcLine = (refs) => {
    const seen = new Set(), parts = [];
    for (const n of refs || []) { const it = byNo.get(n); if (!it) continue; const k = it.org + it.date; if (seen.has(k)) continue; seen.add(k); parts.push(`${escHtml(it.org)}(${shortD(it.date)})`); }
    return parts.length ? P('src', `* 출처: ${parts.slice(0, 4).join(', ')}${parts.length > 4 ? ` 외 ${parts.length - 4}건` : ''}`) : '';
  };
  const PB = hwp ? '<p style="margin:0">@@PB@@</p>' : '<div style="page-break-before:always"></div>';
  const charts = reportCharts(items, inputs, topics);
  const fig = (id, caption) => `<div style="margin:4pt 0 0 0">${chartImg?.[id] ? `<img src="${chartImg[id].file}" width="${chartImg[id].w}" alt="${escHtml(caption)}">` : charts[id]}</div>${P('cap', escHtml(caption))}`;
  const who = [...new Set(items.map((i) => i.collectedBy).filter(Boolean))].join('·') || (team || []).join('·');
  const dom = items.filter((i) => i.region === 'domestic').length;

  let h = '';
  // cover
  h += P('t1', escHtml(data.title));
  h += P('t2', `과학기술정책 동향 조사 보고서 (작성일 ${fmtD(new Date().toISOString().slice(0, 10))})`);
  h += P('meta', `조사기간: ${fmtD(inputs.start)} ~ ${fmtD(inputs.end)} │ 키워드: ${escHtml(inputs.keywords.join(', '))} │ 수집 자료: ${items.length}건(국내 ${dom} · 해외 ${items.length - dom})`);
  h += P('meta', `작성: 신흥기술영향평가 2인1조 (${escHtml(who)}) │ 실행 ${escHtml(runId)}`);
  // highlights box
  h += `<table style="width:150mm; border:1px solid #1F3864; background:#EEF3FA; border-collapse:collapse; margin:10pt 0 4pt 0;" width="600" cellpadding="8"><tr><td style="border:1px solid #1F3864; background:#EEF3FA; padding:6pt;">${P('boxh', '이번 기간 핵심')}${data.highlights.map((s) => P('b1', `◇ ${escHtml(s.text)}${ref(s.refs)}`)).join('')}</td></tr></table>`;

  // Ⅰ. 요약
  h += P('h1', 'Ⅰ. 요약');
  h += P('h3', '□ 주요 동향');
  h += data.summary.map((s) => P('b1', `○ ${s.label ? `(${escHtml(s.label)}) ` : ''}${escHtml(s.text)}${ref(s.refs)}`)).join('');
  h += P('h3', '□ 수집 현황');
  const tc = data.counts.filter((c) => c.value);
  h += table(['구분', '주제', '국내', '해외', '계'], [...tc.map((c, i) => { const xs = items.filter((x) => x.topicId === c.key); const d = xs.filter((x) => x.region === 'domestic').length; return [i + 1, escHtml(c.label), d, xs.length - d, `<b>${xs.length}</b>`]; }), ['', '<b>합계</b>', dom, items.length - dom, `<b>${items.length}</b>`]], [14, 70, 22, 22, 22]);
  h += fig('topics', '[그림 1] 주제별 자료 수');
  h += fig('weekly', '[그림 2] 주별 자료 수 추이');
  h += fig('kinds', '[그림 3] 출처 유형별 비중');
  h += fig('regions', '[그림 4] 국내·해외 비중');
  const months = monthly(items, inputs.start, inputs.end);
  h += `<div>${heatTable(tc.map((r) => r.label), months.map((m) => m.label), tc.map((r) => months.map((m) => items.filter((i) => i.topicId === r.key && i.date.startsWith(m.key)).length)), { theme: LIGHT }).replace('width:100%', 'width:150mm')}</div>${P('cap', '[표 1] 주제 × 월별 자료 수')}`;

  // Ⅱ. 주제별 주요 동향
  h += PB + P('h1', 'Ⅱ. 주제별 주요 동향');
  let n = 1;
  for (const c of tc) {
    const t = data.topicText[c.key];
    h += P('h2', `${n++}. ${escHtml(c.label)} <span style="font-size:10pt; font-weight:normal; color:#555555">(${c.value}건)</span>`);
    h += P('h3', `□ ${escHtml(t.headline)}`);
    for (const p of t.points) {
      h += P('b1', `○ ${escHtml(p.text)}${ref(p.refs)}`);
      for (const s of p.subs || []) h += P('b2', `- ${escHtml(s.text)}${ref(s.refs)}`);
      h += srcLine([...p.refs, ...(p.subs || []).flatMap((s) => s.refs)]);
    }
    const rest = c.value - t.points.length;
    if (!t.generated && rest > 0) h += P('src', `※ 외 ${rest}건은 붙임 목록 참조`);
  }

  // Ⅲ. 시사점
  h += PB + P('h1', 'Ⅲ. 시사점');
  if (data.implications.length) {
    for (const m of data.implications) {
      h += P('h3', `□ ${m.keyword ? `(${escHtml(m.keyword)}) ` : ''}${escHtml(m.title)}`);
      for (const p of m.points) h += P('b1', `○ ${escHtml(p.text)}${ref(p.refs)}`);
    }
  } else h += P('b1', '○ 자동 작성된 시사점이 없음 — 조사 자료를 바탕으로 직접 작성 필요');
  h += fig('orgs', '[그림 5] 자료가 많은 기관 상위 10곳');

  // 붙임
  h += PB + P('h1', `붙임. 수집 자료 목록 (${items.length}건)`);
  h += P('src', `※ 전체 요약과 원문 링크는 「조사자료목록.csv」 참조${hwp ? '' : ' · 제목을 누르면 원문이 열림'}`);
  h += table(['No.', '주제', '날짜', '기관', '제목'], items.map((it) => [it.no, escHtml(it.topic), it.date, escHtml(it.org), hwp ? escHtml(it.title) : `<a href="${escHtml(it.url)}" style="color:#111111; text-decoration:none">${escHtml(it.title)}</a>`]), [10, 24, 20, 32, 64]);
  const checks = [
    `모든 자료는 링크 검증기(정상 응답·제목 일치·원문 키워드·원문 게시일)를 통과한 것만 실었음 — 통과 ${verifyStats.verified}건, 보류 ${verifyStats.pending}건, 제외 ${verifyStats.rejected}건`,
    verifyStats.pending ? `검증 보류 ${verifyStats.pending}건(접속 차단·날짜 미확인 등)은 본문에 넣지 않았으므로 필요하면 직접 확인` : null,
    data.dropped.length ? `근거와 맞지 않아 뺀 자동 작성 문장 ${data.dropped.length}개` : null,
    data.generatedBy === 'template' ? '자동 작성 문안을 쓰지 못해 요약·동향은 자료 제목 위주로 정리됨' : null,
    '예산·계획 수치는 원문 발표 시점 기준이며, 이후 확정·변경 여부는 확인 필요',
  ].filter(Boolean);
  h += P('src', '※ 확인 필요: ' + checks.map((c, i) => `${'①②③④⑤⑥'[i]}${c}`).join(' '));

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escHtml(data.title)}</title>${hwp ? '' : '<style>@page { size: A4; margin: 18mm 18mm; } body { margin: 0; background: #fff; color: #111; } .page { max-width: 172mm; margin: 0 auto; } svg { max-width: 100%; height: auto; }</style>'}</head><body><div class="page">${h}</div></body></html>`;
}
