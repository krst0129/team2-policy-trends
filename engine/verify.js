// Link verifier: the gate that keeps fabricated or mismatched items out.
// A candidate is "verified" only if (1) the URL answers 2xx, (2) the page really
// contains the title, and (3) a date printed on the page (or the official index
// it came from) falls inside the requested period.
import { fetchText, stripTags, decodeEntities, normText, parseLooseDate, normDate, canonicalUrl, pool } from './util.js';

// Sources whose date comes from the publisher's own official index/API.
const OFFICIAL_INDEX = new Set(['koreakr', 'fedreg', 'govuk']);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function metaDates(html) {
  const out = [];
  const re = /<meta[^>]+(?:property|name|itemprop)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']([^"']+)["'][^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const key = (m[1] || m[4] || '').toLowerCase(), val = m[2] || m[3] || '';
    if (/(published|pubdate|publishdate|publish_date|release_date|dc\.date|dcterms\.(created|issued|date)|citation_(publication_)?date|^date$|article:modified)/.test(key)) {
      const d = parseLooseDate(val); if (d) out.push({ d, how: 'meta:' + key });
    }
  }
  for (const m of html.matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) { const d = parseLooseDate(m[1]); if (d) out.push({ d, how: 'jsonld' }); }
  for (const m of html.matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)) { const d = parseLooseDate(m[1]); if (d) out.push({ d, how: 'time' }); }
  return out;
}

function textHasDate(text, d) {
  const [Y, M, D] = d.split('-').map(Number);
  const pats = [
    `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`,
    new RegExp(`${Y}\\s*[./]\\s*0?${M}\\s*[./]\\s*0?${D}(?!\\d)`),
    new RegExp(`${Y}\\s*년\\s*0?${M}\\s*월\\s*0?${D}\\s*일`),
    new RegExp(`(?<!\\d)0?${D}\\s+(${Object.keys(MONTHS)[M - 1]})[a-z]*\\.?\\s+${Y}`, 'i'),
    new RegExp(`(${Object.keys(MONTHS)[M - 1]})[a-z]*\\.?\\s+0?${D},?\\s+${Y}`, 'i'),
    new RegExp(`${Y}年\\s*0?${M}月\\s*0?${D}日`),
  ];
  return pats.some((p) => (typeof p === 'string' ? text.includes(p) : p.test(text)));
}

function titleMatches(candTitle, html, bodyText) {
  const nt = normText(candTitle);
  if (nt.length < 4) return { ok: false, why: '제목이 너무 짧음' };
  const heads = [
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    ...[...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title|title)["'][^>]*content=["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].slice(0, 20).map((m) => m[1]),
  ].filter(Boolean).map((s) => stripTags(decodeEntities(s)));
  const hay = normText(heads.join(' ') + ' ' + bodyText.slice(0, 60000));
  const probe = nt.length > 30 ? nt.slice(0, 30) : nt;
  if (hay.includes(probe)) return { ok: true, pageTitle: heads[0] || '' };
  // token overlap against the page's own headings (handles minor punctuation/spacing differences)
  const tok = (s) => new Set(decodeEntities(s).toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((w) => w.length >= 2));
  const ct = tok(candTitle);
  let best = 0;
  for (const h of heads) {
    const ht = tok(h); let inter = 0; for (const w of ct) if (ht.has(w)) inter++;
    best = Math.max(best, ct.size ? inter / ct.size : 0);
  }
  return best >= 0.8 ? { ok: true, pageTitle: heads[0] || '', fuzzy: best } : { ok: false, why: `페이지에서 제목을 찾지 못함 (일치도 ${Math.round(best * 100)}%)` };
}

// 본문까지 키워드와 관련 있는 자료만 (3. 처리 기준). English terms match on word boundaries.
function keywordHit(text, kws) {
  const low = text.toLowerCase();
  for (const k of kws) {
    const kk = k.toLowerCase().trim(); if (!kk) continue;
    if (/^[\x00-\x7F]+$/.test(kk)) { if (new RegExp(`(^|[^a-z0-9])${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')}([^a-z0-9]|$)`, 'i').test(low)) return k; }
    else if (low.includes(kk) || low.replace(/\s+/g, '').includes(kk.replace(/\s+/g, ''))) return k;
  }
  return null;
}

async function checkOne(c, start, end, kws) {
  const rec = { ...c, checkedAt: new Date().toISOString() };
  let res;
  try { res = await fetchText(c.url, { timeout: 25000 }); }
  catch (e) { return { ...rec, state: 'pending', reason: '접속 실패: ' + (e.name === 'TimeoutError' ? '시간 초과' : e.message) }; }
  rec.httpStatus = res.status; rec.finalUrl = res.url;
  if (res.status === 404 || res.status === 410) return { ...rec, state: 'rejected', reason: `존재하지 않는 페이지 (HTTP ${res.status})` };
  if (res.status >= 400) return { ...rec, state: 'pending', reason: `접속 차단 또는 오류 (HTTP ${res.status})` };
  if (/pdf/i.test(res.contentType)) return { ...rec, state: 'pending', reason: 'PDF 원문이라 자동 대조 불가 — 직접 확인 필요' };

  const html = res.text;
  const body = stripTags(html);
  if (body.length < 200) return { ...rec, state: 'pending', reason: '본문이 비어 있음(스크립트로 그리는 페이지) — 직접 확인 필요' };

  const tm = titleMatches(c.title, html, body);
  if (!tm.ok) return { ...rec, state: c.via === 'claude' ? 'rejected' : 'pending', reason: '제목 불일치: ' + tm.why };
  rec.pageTitle = tm.pageTitle;
  // 정책브리핑처럼 본문이 첨부파일에만 있는 공식 색인은 그 색인의 검색 요약도 근거로 인정
  const hit = keywordHit(`${c.title} ${OFFICIAL_INDEX.has(c.sourceId) ? c.snippet || '' : ''} ${body}`, kws);
  if (!hit) return { ...rec, state: 'rejected', reason: '키워드 관련성 없음 (원문에 키워드가 없음)' };
  rec.matchedKeyword = hit;

  // date: page metadata > candidate date printed on page > official index date
  const metas = metaDates(html).filter((x) => !/modified/.test(x.how));
  let date = null, dateSource = null;
  if (metas.length) { date = metas[0].d; dateSource = metas[0].how; }
  else if (c.date && textHasDate(body, c.date)) { date = c.date; dateSource = 'page-text'; }
  else if (c.date && OFFICIAL_INDEX.has(c.sourceId)) { date = c.date; dateSource = 'official-index'; }
  if (!date) return { ...rec, state: 'pending', reason: '원문에서 게시일을 확인하지 못함' };
  if (date < start || date > end) return { ...rec, state: 'rejected', reason: `조사기간 밖 (원문 날짜 ${date})`, date, dateSource };
  return { ...rec, state: 'verified', date, dateSource };
}

export async function verifyAll(cands, start, end, kws, log) {
  // de-duplicate by canonical URL before fetching
  const seen = new Map();
  for (const c of cands) {
    const k = canonicalUrl(c.url);
    if (!seen.has(k)) seen.set(k, { ...c, url: k });
  }
  const list = [...seen.values()];
  log(`링크 검증 시작: ${list.length}건 (중복 ${cands.length - list.length}건 제거)`);
  let done = 0;
  const results = await pool(list, 6, async (c) => {
    const r = await checkOne(c, start, end, kws);
    if (++done % 20 === 0) log(`링크 검증 ${done}/${list.length}`);
    return r;
  });
  const by = (s) => results.filter((r) => r.state === s);
  log(`링크 검증 끝: 통과 ${by('verified').length}, 보류 ${by('pending').length}, 제외 ${by('rejected').length}`);
  return { verified: by('verified'), pending: by('pending'), rejected: by('rejected') };
}

// Same story reported by many outlets: keep one, prefer official originals.
const PRIORITY = { '보도자료': 0, '정책 보고서': 1, '법령': 1, '사업공고/예산': 1, '정책 동향': 2, '해외 정책자료': 1, '뉴스 기사': 3, '해외 언론': 3 };
export function dedupeByTitle(items) {
  const best = new Map();
  for (const it of items) {
    const k = normText(it.title).slice(0, 40);
    const cur = best.get(k);
    if (!cur || (PRIORITY[it.type] ?? 9) < (PRIORITY[cur.type] ?? 9) || ((PRIORITY[it.type] ?? 9) === (PRIORITY[cur.type] ?? 9) && it.date > cur.date)) best.set(k, it);
  }
  return [...best.values()];
}
