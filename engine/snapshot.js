// Builds a self-contained one-page web dashboard for a published run: same
// styles, charts and results view as the live dashboard, data inlined, no server.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, config, escHtml } from './util.js';

const read = (f) => fs.readFileSync(path.join(ROOT, 'dashboard', f), 'utf8');
const asScript = (src) => src.replace(/^import[^\n]*\n/gm, '').replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

export function buildSnapshot(runDir, id) {
  const st = readJson(path.join(runDir, '진행상태.json'));
  const data = readJson(path.join(runDir, 'items.json'));
  const report = readJson(path.join(runDir, 'report.json'));
  const reportHtml = fs.readFileSync(path.join(runDir, '정책조사보고서.html'), 'utf8');
  const topics = config('topics.json').topics;
  const i = st.inputs;
  const who = Object.values(st.regions).map((r) => r.byName).filter(Boolean);
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(report.title)}</title>
<style>${read('styles.css')}</style></head>
<body>
<header class="topbar"><div class="topbar-in">
  <div class="brand"><h1>과학기술정책 동향 조사 결과</h1><p>${escHtml(report.title)}</p></div>
  <div class="snapshot-note">키워드 ${escHtml(i.keywords.join(', '))} · ${i.start} ~ ${i.end} · 실행 ${escHtml(id)} · 조사 ${escHtml([...new Set(who)].join('·'))}<br>발간 ${escHtml((st.publishedAt || '').slice(0, 16).replace('T', ' '))} UTC 기준 결과를 담은 웹페이지입니다(서버 없이 열림)</div>
</div></header>
<main>
  <div class="kpis" id="kpis"></div>
  <div class="charts">
    <section class="card"><div class="card-h"><h2>주제별 개수</h2><button id="clearFilter" class="ghost" hidden>전체 보기</button></div><p class="hint">막대를 누르면 목록이 그 주제로 걸러집니다 · 회색은 기타</p><div id="topicChart" class="chart"></div></section>
    <section class="card"><div class="card-h"><h2>주별 추이</h2><select id="trendTopic" aria-label="주제 선택"></select></div><div id="trendChart" class="chart"></div><p class="hint">점에 마우스를 올리면 해당 주의 건수가 보입니다</p></section>
  </div>
  <div class="layout-list">
    <section class="card">
      <div class="card-h"><h2>정책 키워드 조사자료 목록 <small id="listCount"></small></h2>
        <div class="btn-row" style="margin:0"><input id="search" class="search" type="search" placeholder="제목·기관 검색"><select id="regionFilter" aria-label="국내외"><option value="">국내·해외</option><option value="domestic">국내</option><option value="overseas">해외</option></select><button id="csvBtn" class="cta">CSV 파일 내보내기</button></div></div>
      <div class="chips" id="topicChips"></div>
      <div class="table-wrap"><table id="itemTable"></table></div>
    </section>
    <section class="card"><div class="card-h"><h2>검증 보류 목록 <small id="pendCount"></small></h2></div><p class="hint">자동 검증을 못 한 자료입니다. 목록·그래프·보고서에는 넣지 않았습니다.</p><ul class="plist" id="pendingList"></ul></section>
  </div>
  <div class="layout-bottom">
    <section class="card"><div class="card-h"><h2>키워드 분석</h2></div><p class="hint">제목에 함께 자주 나온 단어 — 분류표 밖의 새 흐름을 찾는 참고용</p><div id="clusters" class="clusters" style="margin-top:8px"></div></section>
    <section class="card"><div class="card-h"><h2>정책조사 보고서</h2></div><p class="report-title">${escHtml(report.title)}</p><div class="report-preview"><iframe id="reportFrame" title="보고서" srcdoc="${escHtml(reportHtml)}"></iframe></div></section>
  </div>
</main>
<script>
const Charts = (() => {
${asScript(read('charts.js'))}
return { hbar, line, CSSVARS, topicCounts, weekly };
})();
const { mountResults, csvText } = (() => {
const { hbar, line, CSSVARS, topicCounts, weekly } = Charts;
${asScript(read('view.js'))}
return { mountResults, csvText };
})();
const DATA = ${safeJson(data)};
const TOPICS = ${safeJson(topics)};
const INPUTS = ${safeJson(i)};
mountResults({ data: DATA, topics: TOPICS, inputs: INPUTS, onCsv: () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csvText(DATA.items)], { type: 'text/csv;charset=utf-8' }));
  a.download = ${safeJson(id + '_조사자료목록.csv')}; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
} });
</script>
</body></html>`;
  const out = path.join(runDir, '조사결과_대시보드.html');
  fs.writeFileSync(out, html, 'utf8');
  return out;
}
