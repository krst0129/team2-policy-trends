// Collectors return *candidates* only. Every candidate still has to pass verify.js.
import { fetchText, stripTags, decodeEntities, parseLooseDate, sleep } from './util.js';
import { runClaude, extractJson } from './claude.js';

const inRange = (d, s, e) => d && d >= s && d <= e;
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isAscii = (s) => /^[\x00-\x7F]+$/.test(s);

// ---------- 국내 ----------
async function koreakr({ keywords, start, end }, src, log) {
  const out = [];
  for (const kw of keywords) {
    for (let page = 1; page <= 10; page++) {
      const url = `https://www.korea.kr/briefing/pressReleaseList.do?pageIndex=${page}&startDate=${start}&endDate=${end}&srchWord=${encodeURIComponent(kw)}`;
      const { text } = await fetchText(url);
      const items = [...text.matchAll(/<a href="(\/briefing\/pressReleaseView\.do\?newsId=(\d+)[^"]*)">([\s\S]*?)<\/a>/g)];
      let added = 0;
      for (const m of items) {
        const block = m[3];
        const title = stripTags(block.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] || '');
        // <span class="source"><span>2026-10-12</span><span>중소벤처기업부</span></span>
        const sm = block.match(/<span class="source">\s*<span>([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span>/);
        const src2 = sm ? [stripTags(sm[1]), stripTags(sm[2])] : [];
        const date = parseLooseDate(src2[0] || '');
        if (!title || !inRange(date, start, end)) continue;
        out.push({ title, url: `https://www.korea.kr/briefing/pressReleaseView.do?newsId=${m[2]}`, date, org: src2[1] || '정책브리핑', type: '보도자료', snippet: stripTags(block.match(/<span class="lead">([\s\S]*?)<\/span>\s*<span class="source">/)?.[1] || '').slice(0, 300), keyword: kw });
        added++;
      }
      if (added === 0 || items.length < 10) break;
      await sleep(300);
    }
  }
  log(`정책브리핑: 후보 ${out.length}건`);
  return out;
}

async function naver({ keywords, start, end }, src, log) {
  const id = process.env.NAVER_CLIENT_ID, sec = process.env.NAVER_CLIENT_SECRET;
  if (!id || !sec) { log('네이버 뉴스: API 키 없음(.env) — 건너뜀'); return { skipped: 'API 키 없음' }; }
  const out = [];
  for (const kw of keywords) {
    for (let s = 1; s <= 901; s += 100) {
      const { status, text } = await fetchText(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(kw)}&display=100&start=${s}&sort=date`, { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': sec } });
      if (status !== 200) { log(`네이버 뉴스 오류 ${status}`); break; }
      const j = JSON.parse(text);
      let older = false;
      for (const it of j.items || []) {
        const date = parseLooseDate(it.pubDate);
        if (date < start) { older = true; continue; }
        if (!inRange(date, start, end)) continue;
        const url = it.originallink || it.link;
        out.push({ title: stripTags(it.title), url, date, org: host(url), type: '뉴스 기사', snippet: stripTags(it.description).slice(0, 300), keyword: kw });
      }
      if (older || (j.items || []).length < 100) break;
      await sleep(200);
    }
  }
  log(`네이버 뉴스: 후보 ${out.length}건`);
  return out;
}

async function google({ keywords, start, end }, src, log) {
  const key = process.env.GOOGLE_API_KEY, cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) { log('Google 검색: API 키 없음(.env) — 건너뜀'); return { skipped: 'API 키 없음' }; }
  const out = [];
  const range = `date:r:${start.replace(/-/g, '')}:${end.replace(/-/g, '')}`;
  for (const kw of keywords) {
    for (let s = 1; s <= 31; s += 10) {
      const { status, text } = await fetchText(`https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=10&start=${s}&sort=${range}&q=${encodeURIComponent(kw)}`);
      if (status !== 200) { log(`Google 검색 오류 ${status}`); break; }
      const j = JSON.parse(text);
      for (const it of j.items || []) {
        const meta = it.pagemap?.metatags?.[0] || {};
        const date = parseLooseDate(meta['article:published_time'] || meta.pubdate || meta.date || '');
        out.push({ title: it.title, url: it.link, date, org: it.displayLink, type: '뉴스 기사', snippet: (it.snippet || '').slice(0, 300), keyword: kw });
      }
      if ((j.items || []).length < 10) break;
    }
  }
  log(`Google 검색: 후보 ${out.length}건`);
  return out;
}

// ---------- 해외 ----------
async function gdelt({ keywordsEn, start, end }, src, log) {
  if (!keywordsEn.length) { log('GDELT: 영문 검색어 없음 — 건너뜀'); return { skipped: '영문 검색어 없음' }; }
  // GDELT DOC API covers roughly the last 3 months.
  const minStart = new Date(Date.now() - 88 * 864e5).toISOString().slice(0, 10);
  const s = start < minStart ? minStart : start;
  if (s !== start) log(`GDELT: 최근 약 3개월만 지원 → ${s}부터 검색`);
  const q = '(' + keywordsEn.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ') + ')';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q + ' sourcelang:english')}&mode=ArtList&maxrecords=250&format=json&sort=DateDesc&startdatetime=${s.replace(/-/g, '')}000000&enddatetime=${end.replace(/-/g, '')}235959`;
  let status, text;
  for (let attempt = 1; attempt <= 4; attempt++) {
    // GDELT sometimes drops the connection ("fetch failed") as well as answering 429: retry both
    try { ({ status, text } = await fetchText(url, { timeout: 40000 })); }
    catch (e) { status = 0; text = e.message; }
    if (status !== 429 && status !== 0) break;
    if (attempt === 4) break;
    log(`GDELT ${status === 429 ? '요청 간격 제한' : '접속 실패'} — ${attempt * 6}초 뒤 다시 시도`);
    await sleep(attempt * 6000);
  }
  if (status !== 200 || !text.trim().startsWith('{')) { log(`GDELT 응답 오류 ${status}: ${text.slice(0, 120)}`); return []; }
  const out = [];
  for (const a of JSON.parse(text).articles || []) {
    if (a.sourcecountry === 'South Korea') continue; // 국내 매체 제외
    const date = parseLooseDate(a.seendate);
    if (!inRange(date, start, end)) continue;
    out.push({ title: decodeEntities(a.title).replace(/\s+([,.;:!?])/g, '$1'), url: a.url, date, org: a.domain, country: a.sourcecountry, type: '해외 언론', snippet: '', keyword: q });
  }
  log(`GDELT: 후보 ${out.length}건`);
  return out;
}

async function fedreg({ keywordsEn, start, end }, src, log) {
  if (!keywordsEn.length) return { skipped: '영문 검색어 없음' };
  const out = [];
  for (const kw of keywordsEn) {
    for (let page = 1; page <= 2; page++) {
      const url = `https://www.federalregister.gov/api/v1/documents.json?per_page=100&page=${page}&order=newest&conditions[term]=${encodeURIComponent(kw.includes(' ') ? `"${kw}"` : kw)}&conditions[publication_date][gte]=${start}&conditions[publication_date][lte]=${end}&fields[]=title&fields[]=html_url&fields[]=publication_date&fields[]=agencies&fields[]=abstract&fields[]=type`;
      const { status, text } = await fetchText(url);
      if (status !== 200) break;
      const j = JSON.parse(text);
      for (const d of j.results || []) out.push({ title: d.title, url: d.html_url, date: d.publication_date, org: (d.agencies || []).map((a) => a.name).filter(Boolean).join(', ') || 'Federal Register', country: 'United States', type: '보도자료', snippet: (d.abstract || '').slice(0, 300), keyword: kw });
      if (!j.next_page_url) break;
    }
  }
  log(`Federal Register: 후보 ${out.length}건`);
  return out;
}

async function govuk({ keywordsEn, start, end }, src, log) {
  if (!keywordsEn.length) return { skipped: '영문 검색어 없음' };
  const out = [];
  for (const kw of keywordsEn) {
    const url = `https://www.gov.uk/api/search.json?count=100&order=-public_timestamp&q=${encodeURIComponent(kw.includes(' ') ? `"${kw}"` : kw)}&filter_public_timestamp=from:${start},to:${end}&fields=title,link,public_timestamp,organisations,description,content_store_document_type`;
    const { status, text } = await fetchText(url);
    if (status !== 200) continue;
    for (const d of JSON.parse(text).results || []) {
      if (!d.link?.startsWith('/')) continue;
      out.push({ title: d.title, url: 'https://www.gov.uk' + d.link, date: parseLooseDate(d.public_timestamp), org: (d.organisations || []).map((o) => o.title).join(', ') || 'GOV.UK', country: 'United Kingdom', type: '보도자료', snippet: (d.description || '').slice(0, 300), keyword: kw });
    }
  }
  log(`GOV.UK: 후보 ${out.length}건`);
  return out;
}

// Official RSS/Atom feeds (NSF, NIST, DOE, EU Commission …). Feeds only carry the latest
// items, so this catches recent releases; a candidate needs an English keyword in its title or summary.
const tagText = (block, tag) => stripTags(block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'))?.[1] || '');
function feedItems(xml) {
  return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map(([b]) => ({
    title: tagText(b, 'title'),
    url: (tagText(b, 'link') || b.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || '').trim(),
    date: parseLooseDate(tagText(b, 'pubDate') || tagText(b, 'dc:date') || tagText(b, 'published') || tagText(b, 'updated')),
    snippet: (tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content')).slice(0, 300),
  }));
}
async function rss({ keywordsEn, start, end }, src, log) {
  if (!keywordsEn.length) return { skipped: '영문 검색어 없음' };
  const hit = (t) => keywordsEn.some((k) => new RegExp(`(^|[^a-z0-9])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')}([^a-z0-9]|$)`, 'i').test(t));
  const out = [];
  for (const feed of src.feeds) {
    try {
      const { status, text } = await fetchText(feed.url);
      if (status !== 200) { log(`${feed.org} RSS 응답 ${status} — 건너뜀`); continue; }
      for (const it of feedItems(text)) {
        if (!it.title || !it.url.startsWith('http') || !inRange(it.date, start, end)) continue;
        if (!hit(`${it.title} ${it.snippet}`)) continue;
        out.push({ ...it, org: feed.org, country: feed.country, type: src.type, keyword: keywordsEn.join(', ') });
      }
    } catch (e) { log(`${feed.org} RSS 오류: ${e.message}`); }
  }
  log(`${src.name}: 후보 ${out.length}건`);
  return out;
}

// ---------- Claude Code 조사 (API가 없는 출처) ----------
async function claudeResearch(inputs, srcs, region, workDir, log) {
  const list = srcs.map((s) => `- ${s.name} [자료 유형: ${s.type}] 도메인: ${s.domains.join(', ')}`).join('\n');
  const kws = region === 'domestic' ? inputs.keywords : [...inputs.keywordsEn, ...inputs.keywords];
  const prompt = `당신은 정책 동향 조사원입니다. 아래 출처에서 키워드 관련 자료를 찾아 JSON으로만 답하세요.

[키워드] ${kws.join(', ')}  (하나라도 관련되면 포함)
[기간] ${inputs.start} ~ ${inputs.end} (게시일 기준)
[출처]
${list}

[반드시 지킬 규칙]
1. WebSearch로 찾고(예: site:도메인 키워드), 후보마다 WebFetch로 페이지를 직접 열어 확인한 자료만 넣으세요.
2. title은 열어 본 페이지에 적힌 제목을 글자 그대로 옮기세요. 바꾸거나 요약하지 마세요.
3. url은 열어 본 페이지의 실제 주소입니다. 주소를 추측하거나 만들지 마세요.
4. date는 페이지에 적힌 게시일(YYYY-MM-DD)입니다. 페이지에서 확인 못 하면 그 자료는 빼세요.
5. 기간 밖의 자료, 확인하지 못한 자료는 넣지 마세요. 찾지 못했으면 빈 배열 []을 주세요.
6. 출처마다 최대 6건, 전체 최대 30건.

[출력 형식] 설명 없이 JSON 배열만:
[{"title":"...","url":"https://...","date":"YYYY-MM-DD","org":"발행 기관","type":"보도자료|정책 보고서|정책 동향|사업공고/예산|법령|해외 정책자료","snippet":"페이지 내용 1~2문장"}]`;
  log(`Claude Code 조사 시작 (${srcs.length}개 출처)`);
  const res = await runClaude(prompt, { tools: ['WebSearch', 'WebFetch'], maxTurns: 60, workDir, onLog: () => {} });
  let arr = [];
  try { arr = extractJson(res.text); } catch (e) { log('Claude Code 결과 해석 실패: ' + e.message); }
  const out = (Array.isArray(arr) ? arr : []).filter((x) => x && x.url && x.title).map((x) => ({ ...x, date: parseLooseDate(x.date || ''), via: 'claude' }));
  log(`Claude Code 조사: 후보 ${out.length}건`);
  return out;
}

export async function translateKeywords(keywords, workDir, log) {
  const ascii = keywords.filter(isAscii);
  if (ascii.length === keywords.length) return ascii;
  try {
    const res = await runClaude(`다음 한국어 정책 키워드를 해외 정책·언론 검색에 쓸 영어 검색어로 바꿔 JSON 문자열 배열로만 답하세요. 키워드마다 1~2개, 짧은 명사구로.\n${JSON.stringify(keywords)}`, { maxTurns: 2, workDir, timeoutMs: 120000 });
    const arr = extractJson(res.text).filter((s) => typeof s === 'string' && isAscii(s));
    log(`영문 검색어: ${arr.join(', ')}`);
    return [...new Set([...ascii, ...arr])].slice(0, 12);
  } catch (e) {
    log('영문 검색어 자동 변환 실패: ' + e.message);
    return ascii;
  }
}

const DIRECT = { koreakr, naver, google, gdelt, fedreg, govuk, rss };

export async function collectRegion(region, inputs, sources, groups, { workDir, log, claudeOk, onProgress = () => {} }) {
  const enabled = new Set(inputs.groups);
  const groupRegion = Object.fromEntries(groups.map((g) => [g.id, g.region]));
  const srcs = sources.filter((s) => groupRegion[s.group] === region && enabled.has(s.group));
  const results = [], skipped = [];
  const direct = srcs.filter((x) => x.method !== 'claude');
  const viaClaude = srcs.filter((x) => x.method === 'claude');
  // progress units: each direct source = 1, Claude research = 4 (it takes longest)
  const total = direct.length + (viaClaude.length && claudeOk ? 4 : 0) || 1;
  let done = 0;
  for (const s of direct) {
    onProgress(done / total, `${s.name} 수집 중`);
    try {
      const r = await DIRECT[s.method](inputs, s, log);
      if (r && r.skipped) { skipped.push({ source: s.name, reason: r.skipped }); continue; }
      results.push(...r.map((c) => ({ ...c, sourceId: s.id, via: c.via || s.method })));
    } catch (e) { log(`${s.name} 수집 오류: ${e.message}`); skipped.push({ source: s.name, reason: '수집 오류: ' + e.message }); }
    finally { done++; }
  }
  if (viaClaude.length) {
    if (!claudeOk) { skipped.push(...viaClaude.map((s) => ({ source: s.name, reason: 'Claude Code 사용 불가(로그인 필요)' }))); log('Claude Code 사용 불가 — 해당 출처 건너뜀'); }
    else {
      // Claude research has no intermediate signal: estimate from elapsed time (≈6 min), capped below its share
      const t0 = Date.now();
      const tick = setInterval(() => onProgress((done + 4 * Math.min(0.92, (Date.now() - t0) / 360000)) / total, 'Claude Code가 국책연구기관·정부 누리집 조사 중'), 2000);
      try {
        const r = await claudeResearch(inputs, viaClaude, region, workDir, log).finally(() => clearInterval(tick));
        const byDomain = (u) => viaClaude.find((s) => s.domains.some((d) => host(u).endsWith(d)))?.id || viaClaude[0].id;
        results.push(...r.map((c) => ({ ...c, sourceId: byDomain(c.url) })));
      } catch (e) { log('Claude Code 조사 오류: ' + e.message); skipped.push({ source: 'Claude Code 조사', reason: e.message }); }
    }
  }
  onProgress(1, '수집 완료');
  return { candidates: results.map((c) => ({ ...c, region })), skipped };
}
