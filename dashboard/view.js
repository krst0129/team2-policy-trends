// Results view shared by the live dashboard and the exported one-page web report.
import { hbar, line, CSSVARS, topicCounts, weekly } from './charts.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n).toLocaleString('ko-KR');

let S = null; // { data, topics, inputs, onCsv }
const state = { topic: null, q: '', region: '' };

export function mountResults(opts) {
  S = opts; state.topic = null; state.q = ''; state.region = '';
  if ($('#search')) $('#search').value = '';
  if ($('#regionFilter')) $('#regionFilter').value = '';
  const sel = $('#trendTopic');
  if (sel) {
    sel.innerHTML = '<option value="">전체 보기</option>' + topicCounts(S.data.items, S.topics).filter((r) => r.value).map((r) => `<option value="${r.key}">${esc(r.label)}</option>`).join('');
    sel.onchange = renderTrend;
  }
  if ($('#search')) $('#search').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); renderList(); };
  if ($('#regionFilter')) $('#regionFilter').onchange = (e) => { state.region = e.target.value; renderList(); };
  if ($('#clearFilter')) $('#clearFilter').onclick = () => setTopic(null);
  if ($('#csvBtn')) $('#csvBtn').onclick = () => S.onCsv?.();
  renderKpis(); renderTopics(); renderTrend(); renderList(); renderPending(); renderClusters();
}

export function clearResults() {
  S = null;
  for (const id of ['#kpis', '#topicChips', '#pendingList', '#clusters']) if ($(id)) $(id).innerHTML = '';
  if ($('#topicChart')) $('#topicChart').innerHTML = '<p class="empty">조사를 실행하면 표시됩니다</p>';
  if ($('#trendChart')) $('#trendChart').innerHTML = '<p class="empty">조사를 실행하면 표시됩니다</p>';
  if ($('#itemTable')) $('#itemTable').innerHTML = '<tr><td class="empty">조사를 실행하면 표시됩니다</td></tr>';
  for (const id of ['#listCount', '#pendCount']) if ($(id)) $(id).textContent = '';
}

function setTopic(k) { state.topic = state.topic === k ? null : k; renderTopics(); renderList(); }

function renderKpis() {
  const it = S.data.items, v = S.data.verifyStats;
  const dom = it.filter((i) => i.region === 'domestic').length;
  const tiles = [['검증 통과', it.length, '건'], ['국내', dom, ''], ['해외', it.length - dom, ''], ['검증 보류', v.pending, ''], ['제외', v.rejected, '']];
  $('#kpis').innerHTML = tiles.map(([l, n, u]) => `<div class="kpi"><span>${l}</span><b>${fmt(n)}</b>${u ? `<em>${u}</em>` : ''}</div>`).join('');
}

function renderTopics() {
  const rows = topicCounts(S.data.items, S.topics).filter((r) => r.value);
  const el = $('#topicChart');
  el.innerHTML = rows.length ? hbar(rows, { theme: CSSVARS, width: 520, labelW: 128, rowH: 30, selected: state.topic, interactive: true }) : '<p class="empty">자료가 없습니다</p>';
  el.querySelectorAll('[data-key]').forEach((g) => {
    g.addEventListener('click', () => setTopic(g.dataset.key));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTopic(g.dataset.key); } });
  });
  if ($('#clearFilter')) $('#clearFilter').hidden = !state.topic;
  const all = S.data.items.length;
  $('#topicChips').innerHTML = `<button class="fchip ${state.topic ? '' : 'on'}" data-k="">전체<b>${fmt(all)}</b></button>` + rows.map((r) => `<button class="fchip ${state.topic === r.key ? 'on' : ''}" data-k="${r.key}">${esc(r.label)}<b>${fmt(r.value)}</b></button>`).join('');
  $('#topicChips').querySelectorAll('.fchip').forEach((b) => (b.onclick = () => { state.topic = b.dataset.k || null; renderTopics(); renderList(); }));
}

function renderTrend() {
  const k = $('#trendTopic')?.value || '';
  const items = S.data.items.filter((i) => !k || i.topicId === k);
  const pts = weekly(items, S.inputs.start, S.inputs.end);
  $('#trendChart').innerHTML = pts.length ? line(pts, { theme: CSSVARS, width: 520, height: 230 }) : '<p class="empty">자료가 없습니다</p>';
}

function renderList() {
  const items = S.data.items.filter((i) => (!state.topic || i.topicId === state.topic) && (!state.region || i.region === state.region) && (!state.q || (i.title + ' ' + i.org).toLowerCase().includes(state.q)));
  $('#listCount').textContent = `${fmt(items.length)}건${items.length !== S.data.items.length ? ` / 전체 ${fmt(S.data.items.length)}건` : ''}`;
  $('#itemTable').innerHTML = `<tr><th>날짜</th><th>주제</th><th>자료제목</th><th>출처기관</th><th>구분</th></tr>` + (items.length ? items.map((i) => `<tr><td class="nw">${i.date}</td><td><span class="pill">${esc(i.topic)}</span></td><td><a href="${esc(i.url)}" target="_blank" rel="noopener" title="원문 열기">${esc(i.title)}</a></td><td>${esc(i.org)}</td><td><span class="pill ${i.region === 'domestic' ? 'dom' : ''}">${i.region === 'domestic' ? '국내' : '해외'}</span></td></tr>`).join('') : '<tr><td colspan="5" class="empty">조건에 맞는 자료가 없습니다</td></tr>');
}

function renderPending() {
  const p = S.data.pending;
  $('#pendCount').textContent = `${fmt(p.length)}건`;
  $('#pendingList').innerHTML = p.length ? p.map((i) => `<li><span class="d">${esc(i.date || '-')}</span><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a><span class="why">${i.region === 'domestic' ? '국내' : '해외'} · ${esc(i.reason)}</span></li>`).join('') : '<li class="empty">검증 보류 자료가 없습니다</li>';
}

function renderClusters() {
  $('#clusters').innerHTML = (S.data.clusters || []).map((c) => `<span class="cluster"><b>${esc(c.term)}</b> ${c.count} <span>${c.related.map((r) => esc(r.term)).join(' · ')}</span></span>`).join('') || '<span class="hint">함께 자주 나온 단어가 없습니다</span>';
}

export function csvText(items) {
  const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['번호', '날짜', '주제', '자료제목', '링크', '출처기관', '자료유형', '국내/해외', '검증상태', '조사한 사람', '수집일시'];
  return '﻿' + [head, ...items.map((it) => [it.no, it.date, it.topic, it.title, it.url, it.org, it.type, it.region === 'domestic' ? '국내' : '해외', '검증 통과', it.collectedBy, it.collectedAt])].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
