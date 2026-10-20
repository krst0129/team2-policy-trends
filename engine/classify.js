// One topic per item (so topic counts add up to the total), plus a keyword
// co-occurrence view for spotting themes the fixed topic table does not cover.
import { runClaude, extractJson } from './claude.js';

function ruleTopic(it, topics) {
  const hay = (it.title + ' ' + (it.snippet || '')).toLowerCase();
  let best = null, bestScore = 0;
  for (const t of topics) {
    let s = 0;
    for (const k of t.keywords) {
      const kk = k.toLowerCase();
      if (/^[a-z0-9&\- ]+$/.test(kk) && kk.length <= 3) { if (new RegExp(`(^|[^a-z])${kk.replace(/[&]/g, '\\&')}([^a-z]|$)`).test(hay)) s += it.title.toLowerCase().includes(kk) ? 2 : 1; }
      else if (hay.includes(kk)) s += it.title.toLowerCase().includes(kk) ? 2 : 1;
    }
    if (s > bestScore) { best = t; bestScore = s; }
  }
  return best ? best.id : 'etc';
}

export async function classify(items, topics, { claudeOk, workDir, log }) {
  for (const it of items) { it.topicId = ruleTopic(it, topics); it.topicBy = 'rule'; }
  if (claudeOk && items.length) {
    const table = topics.map((t) => `${t.id}: ${t.name}`).join('\n');
    for (let i = 0; i < items.length; i += 80) {
      const batch = items.slice(i, i + 80);
      const lines = batch.map((it, k) => `${k}\t${it.title}\t${(it.snippet || '').slice(0, 120)}`).join('\n');
      try {
        const res = await runClaude(`정책 자료를 주제 분류표 중 가장 알맞은 주제 하나로 분류하세요. 맞는 주제가 없으면 etc.\n[주제 분류표]\n${table}\n\n[자료] (번호\t제목\t요약)\n${lines}\n\nJSON 객체로만 답하세요: {"번호":"주제id", ...}`, { maxTurns: 2, workDir, timeoutMs: 180000 });
        const map = extractJson(res.text);
        const valid = new Set(topics.map((t) => t.id));
        batch.forEach((it, k) => { const v = map[k] ?? map[String(k)]; if (valid.has(v)) { it.topicId = v; it.topicBy = 'claude'; } });
      } catch (e) { log('Claude 주제 분류 실패, 규칙 분류 사용: ' + e.message); }
    }
  }
  const name = Object.fromEntries(topics.map((t) => [t.id, t.name]));
  for (const it of items) it.topic = name[it.topicId] || '기타';
  return items;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'new', 'its', 'are', 'was', 'will', 'has', 'have', 'of', 'to', 'in', 'on', 'a', 'an', 'by', 'at', 'as', 'is', 'be', 'or', 'how', 'what', 'why', 'more', 'than', 'after', 'about', '위한', '관련', '통해', '대한', '개최', '추진', '지원', '발표', '정부', '올해', '내년', '최대', '본격', '확대', '강화', '사업', '계획']);
export function keywordClusters(items, top = 15) {
  const docs = items.map((it) => new Set(it.title.toLowerCase().replace(/[「」『』“”"'‘’()[\]<>.,·:;!?…\-–—/]/g, ' ').split(/\s+/).map((w) => w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만)$/, '')).filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w))));
  const freq = new Map();
  for (const d of docs) for (const w of d) freq.set(w, (freq.get(w) || 0) + 1);
  const terms = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, top);
  return terms.map(([w, n]) => {
    const co = new Map();
    for (const d of docs) if (d.has(w)) for (const x of d) if (x !== w && freq.get(x) >= 2) co.set(x, (co.get(x) || 0) + 1);
    return { term: w, count: n, related: [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([x, c]) => ({ term: x, count: c })) };
  });
}
