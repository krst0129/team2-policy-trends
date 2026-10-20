import { mountResults, clearResults } from './view.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (path, opts = {}) => {
  const r = await fetch('/api/' + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const fileUrl = (id, name, dl) => `/api/runs/${id}/file?name=${encodeURIComponent(name)}${dl ? '&download' : ''}`;

let CFG, current = null, pollTimer = null, shownPublished = null;

// ---------- tag inputs ----------
function tagInput(box, input, key) {
  let vals = store.get(key, []);
  const render = () => {
    box.querySelectorAll('.tag').forEach((t) => t.remove());
    vals.forEach((v, i) => {
      const t = document.createElement('span'); t.className = 'tag'; t.innerHTML = `${esc(v)}<button type="button" aria-label="${esc(v)} 삭제">×</button>`;
      t.querySelector('button').onclick = (e) => { e.stopPropagation(); vals.splice(i, 1); store.set(key, vals); render(); };
      box.insertBefore(t, input);
    });
  };
  const add = () => { input.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).forEach((s) => { if (!vals.includes(s)) vals.push(s); }); input.value = ''; store.set(key, vals); render(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !input.value && vals.length) { vals.pop(); store.set(key, vals); render(); } });
  input.addEventListener('blur', add);
  box.addEventListener('click', () => input.focus());
  render();
  return () => { add(); return vals.slice(); };
}
const getKw = tagInput($('#kwBox'), $('#kwInput'), 'kw');
const getKwEn = tagInput($('#kwEnBox'), $('#kwEnInput'), 'kwEn');

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function setPreset(months) { const e = new Date(), s = new Date(); s.setMonth(s.getMonth() - months); $('#start').value = iso(s); $('#end').value = iso(e); }
document.querySelectorAll('[data-months]').forEach((b) => (b.onclick = () => setPreset(+b.dataset.months)));
setPreset(3);

// ---------- config ----------
async function loadConfig(refresh = false) {
  CFG = await api('config' + (refresh ? '?refresh' : ''));
  const sel = $('#runner'); const saved = store.get('runner', CFG.team.members[0].id);
  sel.innerHTML = CFG.team.members.map((m) => `<option value="${m.id}" ${m.id === saved ? 'selected' : ''}>${esc(m.name)} (${CFG.team.regions[m.region]})</option>`).join('');
  sel.onchange = () => { store.set('runner', sel.value); updateOtherHint(); renderInbox(); };
  updateOtherHint();
  const b = $('#claudeBadge');
  b.className = 'badge ' + (CFG.claude.loggedIn ? 'ok' : 'bad');
  b.textContent = CFG.claude.loggedIn ? 'Claude Code 연결됨' : 'Claude Code 로그인 필요';
  b.title = CFG.claude.reason || CFG.claude.bin || '';
  const groups = CFG.sources.groups, srcs = CFG.sources.sources;
  const savedGroups = store.get('groups', groups.map((g) => g.id));
  const noteFor = (g) => srcs.filter((s) => s.group === g.id).map((s) => {
    if (s.method === 'naver' && !CFG.keys.naver) return '네이버 API 키 없음';
    if (s.method === 'google' && !CFG.keys.google) return 'Google API 키 없음';
    if (s.method === 'claude' && !CFG.claude.loggedIn) return 'Claude Code 필요';
    return null;
  }).filter(Boolean).join(' · ');
  $('#groups').innerHTML = Object.entries(CFG.team.regions).map(([r, rn]) => `<fieldset><legend>${rn}</legend>${groups.filter((g) => g.region === r).map((g) => {
    const note = noteFor(g);
    return `<label><input type="checkbox" value="${g.id}" ${savedGroups.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>${note ? `<span class="note">${esc(note)}</span>` : ''}`;
  }).join('')}</fieldset>`).join('');
  const count = () => { const n = document.querySelectorAll('#groups input:checked').length; $('#srcCount').textContent = `${n}/${groups.length}개 켜짐`; };
  $('#groups').onchange = () => { store.set('groups', [...document.querySelectorAll('#groups input:checked')].map((i) => i.value)); count(); };
  count();
}
const runner = () => $('#runner').value;
const member = (id) => CFG.team.members.find((m) => m.id === id);
function updateOtherHint() { const me = member(runner()); const other = Object.keys(CFG.team.regions).find((r) => r !== me.region); $('#otherRegionHint').textContent = `내 담당 ${CFG.team.regions[me.region]} · 상대 ${CFG.team.regions[other]}`; }

// ---------- runs ----------
let runs = [];
const stageName = (s) => ({ collecting: '조사 중', waiting: '넘김 대기', publishing: '발간 중', published: '발간 완료', error: '오류' }[s] || s);
const stateName = (s) => ({ queued: '대기', running: '조사 중', done: '완료', handed: '넘김 · 대기 중', error: '오류', skipped: '선택 안 함' }[s] || s);

async function loadRuns(selectId) {
  runs = await api('runs');
  const sel = $('#runSelect');
  sel.innerHTML = runs.length ? runs.map((r) => `<option value="${r.id}">${r.id} · ${esc(r.inputs.keywords.slice(0, 3).join(', '))} · ${stageName(r.stage)}</option>`).join('') : '<option value="">(없음)</option>';
  const id = selectId || current?.id || runs[0]?.id;
  if (id) { sel.value = id; await openRun(id); }
  renderInbox();
}
$('#runSelect').onchange = (e) => openRun(e.target.value);

function renderInbox() {
  const me = runner();
  const mine = runs.filter((r) => Object.values(r.regions).some((x) => x.state === 'handed' && x.to === me));
  const box = $('#handoffInbox');
  box.hidden = !mine.length;
  box.innerHTML = mine.length ? `<div class="card-h"><h2>넘겨받은 조사 <small>${mine.length}건</small></h2></div>` + mine.map((r) => {
    const region = Object.entries(r.regions).find(([, x]) => x.state === 'handed' && x.to === me)[0];
    return `<div class="card-h"><span><b>${r.id}</b> · ${esc(r.inputs.runnerName)}이(가) 넘긴 <b>${CFG.team.regions[region]}</b> 영역 · ${esc(r.inputs.keywords.join(', '))} · ${r.inputs.start}~${r.inputs.end}</span><button class="primary" data-resume="${r.id}" data-region="${region}">이어받기</button></div>`;
  }).join('') : '';
  box.querySelectorAll('[data-resume]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await api(`runs/${b.dataset.resume}/resume`, { method: 'POST', body: { region: b.dataset.region, runner: me } }); await loadRuns(b.dataset.resume); } catch (e) { alert(e.message); b.disabled = false; }
  }));
}

async function openRun(id) {
  if (!id) return;
  const j = await api('runs/' + id);
  current = j.status;
  renderStatus(current);
  const done = current.stage === 'published' && j.data;
  if (done && shownPublished !== id + current.publishedAt) {
    shownPublished = id + current.publishedAt;
    mountResults({ data: j.data, topics: CFG.topics, inputs: current.inputs, onCsv: () => { location.href = fileUrl(id, '조사자료목록.csv', true); } });
    $('#reportTitle').textContent = j.report?.title || '';
    $('#reportFrame').src = fileUrl(id, '정책조사보고서.html');
  } else if (!done) { shownPublished = null; clearResults(); $('#reportTitle').textContent = ''; $('#reportFrame').removeAttribute('src'); }
  for (const [b, k] of [['#expHwpx', 'hwpx'], ['#expPdf', 'pdf'], ['#expWeb', 'web']]) $(b).disabled = !done || (k !== 'web' && !CFG.exportCaps[k]);
  $('#pushBtn').disabled = !done;
  clearTimeout(pollTimer);
  if (['collecting', 'publishing'].includes(current.stage) || Object.values(current.regions).some((r) => ['queued', 'running'].includes(r.state))) pollTimer = setTimeout(() => openRun(id), 2500);
}

function renderStatus(s) {
  const regionCard = (r) => {
    const x = s.regions[r]; const c = x.counts;
    const who = x.byName || (x.to ? `→ ${member(x.to)?.name}` : '');
    return `<div class="region"><div class="state state-${x.state}">${CFG.team.regions[r]} · ${stateName(x.state)}</div><div class="meta">${esc(who)}${c ? ` · 후보 ${c.candidates} → 통과 ${c.verified} · 보류 ${c.pending} · 제외 ${c.rejected}` : ''}${x.error ? ' · ' + esc(x.error) : ''}${x.note ? ' · ' + esc(x.note) : ''}</div>
      ${(x.skipped || []).length ? `<div class="meta">건너뜀: ${x.skipped.map((k) => esc(k.source + ' (' + k.reason + ')')).join(', ')}</div>` : ''}</div>`;
  };
  const handed = Object.values(s.regions).some((x) => x.state === 'handed');
  $('#statusActions').innerHTML = `${handed ? '<button id="issueBtn" class="ghost">넘김 요청 Issue 만들기</button><button id="cancelHandoff" class="ghost">넘기기 취소 → 직접 조사</button>' : ''}${s.stage === 'error' ? '<button id="republish" class="ghost">발간 다시 시도</button>' : ''}`;
  $('#statusBox').innerHTML = `<div class="hint"><b>${s.id}</b> · ${stageName(s.stage)} · 실행자 ${esc(s.inputs.runnerName)} · ${esc(s.inputs.keywords.join(', '))} · ${s.inputs.start} ~ ${s.inputs.end}</div>
    <div class="regions">${['domestic', 'overseas'].map(regionCard).join('')}</div>
    <details ${['collecting', 'publishing'].includes(s.stage) ? 'open' : ''}><summary class="hint">진행 기록</summary><div class="log">${esc((s.log || []).slice(-60).join('\n'))}</div></details>`;
  $('#issueBtn')?.addEventListener('click', openIssueDialog);
  $('#cancelHandoff')?.addEventListener('click', async () => { if (!confirm('넘긴 영역을 내가 직접 조사할까요?')) return; await api(`runs/${s.id}/cancel-handoff`, { method: 'POST', body: { runner: runner() } }); openRun(s.id); });
  $('#republish')?.addEventListener('click', async () => { await api(`runs/${s.id}/republish`, { method: 'POST' }); setTimeout(() => openRun(s.id), 800); });
}

// ---------- export ----------
async function exportAs(fmt) {
  const btn = { pdf: '#expPdf', hwpx: '#expHwpx', web: '#expWeb' }[fmt]; $(btn).disabled = true;
  $('#expMsg').textContent = `${{ pdf: 'PDF', hwpx: 'hwpx', web: '웹페이지' }[fmt]} 만드는 중…`;
  try {
    const r = await api(`runs/${current.id}/export`, { method: 'POST', body: { format: fmt } });
    $('#expMsg').textContent = `완료: ${r.file}`;
    location.href = fileUrl(current.id, r.file, true);
  } catch (e) { $('#expMsg').textContent = '실패: ' + e.message; } finally { $(btn).disabled = false; }
}
$('#expHwpx').onclick = () => exportAs('hwpx');
$('#expPdf').onclick = () => exportAs('pdf');
$('#expWeb').onclick = () => exportAs('web');
$('#pushBtn').onclick = async () => {
  if (!confirm('이 실행의 입력값·목록·검증기록·보고서를 GitHub에 올릴까요? (원자료와 그림 폴더는 올리지 않습니다)')) return;
  $('#expMsg').textContent = 'GitHub에 올리는 중…';
  try { const r = await api(`runs/${current.id}/push`, { method: 'POST', body: { confirm: true } }); $('#expMsg').textContent = `올림 완료 (${r.files.length}개 파일)`; } catch (e) { $('#expMsg').textContent = '실패: ' + e.message; }
};

// ---------- handoff issue ----------
async function openIssueDialog() {
  const d = await api(`runs/${current.id}/issue-draft`);
  $('#issueTitle').value = d.title; $('#issueBody').value = d.body; $('#issueDlg').dataset.assignee = d.assignee || '';
  $('#issueDlg').showModal();
}
$('#issuePost').onclick = async (e) => {
  e.preventDefault();
  if (!confirm('진행상태를 먼저 GitHub에 올린 뒤 Issue를 만듭니다. 계속할까요?')) return;
  try {
    await api(`runs/${current.id}/push`, { method: 'POST', body: { confirm: true } });
    const r = await api(`runs/${current.id}/issue`, { method: 'POST', body: { confirm: true, title: $('#issueTitle').value, body: $('#issueBody').value, assignee: $('#issueDlg').dataset.assignee } });
    $('#issueDlg').close(); alert('Issue를 올렸습니다: ' + r.url);
  } catch (err) { alert('실패: ' + err.message); }
};

// ---------- run ----------
$('#runBtn').onclick = async () => {
  const keywords = getKw(), keywordsEn = getKwEn();
  const groups = [...document.querySelectorAll('#groups input:checked')].map((i) => i.value);
  const handoff = document.querySelector('input[name=handoff]:checked').value;
  $('#runBtn').disabled = true; $('#runMsg').textContent = '시작하는 중…';
  try {
    const st = await api('runs', { method: 'POST', body: { keywords, keywordsEn, start: $('#start').value, end: $('#end').value, groups, runner: runner(), handoff } });
    $('#runMsg').textContent = handoff === 'handoff' ? '내 영역 조사를 시작했습니다. 진행 상태에서 넘김 요청 Issue를 만들 수 있습니다.' : '조사를 시작했습니다. 수 분이 걸릴 수 있습니다.';
    await loadRuns(st.id);
  } catch (e) { $('#runMsg').textContent = e.message; } finally { $('#runBtn').disabled = false; }
};
$('#gitPull').onclick = async () => { $('#gitPull').disabled = true; try { await api('git/pull', { method: 'POST' }); await loadRuns(); } catch (e) { alert('동기화 실패: ' + e.message); } finally { $('#gitPull').disabled = false; } };
$('#claudeBadge').onclick = () => loadConfig(true);

await loadConfig();
await loadRuns();
