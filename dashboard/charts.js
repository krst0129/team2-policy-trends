// Shared SVG charts — used by the dashboard (browser) and the report (Node).
// Colors are role tokens; `theme` supplies concrete hex for the report, while the
// dashboard passes CSS variables so light/dark follow the page.
// Palette: validated default (dataviz reference) — slots 1-3, sequential blue.

export const LIGHT = {
  surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a',
  seq: ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'],
  font: "system-ui, -apple-system, 'Segoe UI', 'Malgun Gothic', sans-serif",
};
export const CSSVARS = {
  surface: 'var(--surface-1)', ink: 'var(--text-primary)', ink2: 'var(--text-secondary)', muted: 'var(--text-muted)', grid: 'var(--grid)', axis: 'var(--axis)',
  s1: 'var(--series-1)', s2: 'var(--series-2)', s3: 'var(--series-3)', seq: LIGHT.seq, font: 'inherit',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nice = (v) => { if (v <= 5) return 5; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
// 4px rounded data-end, square at the baseline (horizontal bar growing right)
const hbarPath = (x, y, w, h, r = 4) => { r = Math.min(r, w, h / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; };
const vbarPath = (x, y, w, h, r = 4) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

/** Horizontal bar chart (single series, magnitude per category). rows: [{key,label,value}] */
export function hbar(rows, { theme = LIGHT, width = 640, rowH = 30, labelW = 150, selected = null, unit = '건', interactive = false, otherKey = 'etc' } = {}) {
  const max = nice(Math.max(1, ...rows.map((r) => r.value)));
  const plotW = width - labelW - 56, top = 8, h = top + rows.length * rowH + 26;
  const ticks = [0, max / 2, max];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" font-family="${theme.font}" font-size="13" style="max-width:100%;height:auto">`;
  for (const t of ticks) { const x = labelW + (t / max) * plotW; s += `<line x1="${x}" y1="${top}" x2="${x}" y2="${h - 22}" stroke="${theme.grid}" stroke-width="1"/><text x="${x}" y="${h - 6}" fill="${theme.muted}" font-size="11" text-anchor="middle">${Math.round(t)}</text>`; }
  rows.forEach((r, i) => {
    const y = top + i * rowH, bh = rowH - 10, w = Math.max(r.value ? 2 : 0, (r.value / max) * plotW);
    const dim = selected && selected !== r.key;
    s += `<g ${interactive ? `data-key="${esc(r.key)}" class="hit" tabindex="0"` : ''} style="${interactive ? 'cursor:pointer' : ''}">`;
    s += `<title>${esc(r.label)}: ${r.value}${unit}</title>`;
    s += `<rect x="0" y="${y}" width="${width}" height="${rowH}" fill="transparent"/>`;
    s += `<text x="${labelW - 10}" y="${y + bh / 2 + 9}" fill="${theme.ink2}" text-anchor="end">${esc(r.label)}</text>`;
    if (w) s += `<path d="${hbarPath(labelW, y + 5, w, bh)}" fill="${r.key === otherKey ? theme.axis : theme.s1}" opacity="${dim ? 0.3 : 1}"/>`;
    s += `<text x="${labelW + w + 6}" y="${y + bh / 2 + 9}" fill="${theme.ink}" font-weight="600">${r.value}</text></g>`;
  });
  s += `<line x1="${labelW}" y1="${top}" x2="${labelW}" y2="${h - 22}" stroke="${theme.axis}" stroke-width="1"/></svg>`;
  return s;
}

/** Line chart over time (single series): 2px line, 8px markers with surface ring, peak labelled. */
export function line(points, { theme = LIGHT, width = 520, height = 230, unit = '건' } = {}) {
  const max = nice(Math.max(1, ...points.map((p) => p.value)));
  const left = 36, right = 16, bottom = 30, top = 22, plotW = width - left - right, plotH = height - top - bottom;
  const x = (i) => left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => top + plotH - (v / max) * plotH;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family="${theme.font}" font-size="11" style="max-width:100%;height:auto">`;
  for (const t of [0, max / 2, max]) s += `<line x1="${left}" y1="${y(t)}" x2="${width - right}" y2="${y(t)}" stroke="${theme.grid}"/><text x="${left - 6}" y="${y(t) + 4}" fill="${theme.muted}" text-anchor="end">${Math.round(t)}</text>`;
  s += `<line x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}" stroke="${theme.axis}"/>`;
  s += `<polyline fill="none" stroke="${theme.s1}" stroke-width="2" stroke-linejoin="round" points="${points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')}"/>`;
  const peak = points.reduce((a, p, i) => (p.value > points[a].value ? i : a), 0);
  const every = Math.ceil(points.length / 8);
  points.forEach((p, i) => {
    s += `<g><title>${esc(p.title || p.label)}: ${p.value}${unit}</title><circle cx="${x(i)}" cy="${y(p.value)}" r="12" fill="transparent"/><circle cx="${x(i)}" cy="${y(p.value)}" r="4" fill="${theme.s1}" stroke="${theme.surface}" stroke-width="2"/></g>`;
    if (i % every === 0 || i === points.length - 1) s += `<text x="${x(i)}" y="${height - 10}" fill="${theme.muted}" text-anchor="middle">${esc(p.label)}</text>`;
  });
  if (points.length && points[peak].value) s += `<text x="${x(peak)}" y="${y(points[peak].value) - 10}" fill="${theme.ink}" font-weight="700" text-anchor="middle">${points[peak].value}</text>`;
  return s + '</svg>';
}

/** Column chart over time (single series). points: [{label, value}] */
export function columns(points, { theme = LIGHT, width = 640, height = 220, unit = '건' } = {}) {
  const max = nice(Math.max(1, ...points.map((p) => p.value)));
  const left = 36, bottom = 28, top = 14, plotW = width - left - 10, plotH = height - top - bottom;
  const bw = Math.min(46, plotW / Math.max(1, points.length) - 2);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family="${theme.font}" font-size="12" style="max-width:100%;height:auto">`;
  for (const t of [0, max / 2, max]) { const y = top + plotH - (t / max) * plotH; s += `<line x1="${left}" y1="${y}" x2="${width - 10}" y2="${y}" stroke="${theme.grid}"/><text x="${left - 6}" y="${y + 4}" fill="${theme.muted}" font-size="11" text-anchor="end">${Math.round(t)}</text>`; }
  points.forEach((p, i) => {
    const cx = left + (i + 0.5) * (plotW / points.length), bh = (p.value / max) * plotH, x = cx - bw / 2, y = top + plotH - bh;
    s += `<g><title>${esc(p.label)}: ${p.value}${unit}</title>`;
    if (bh > 0) s += `<path d="${vbarPath(x, y, bw, bh)}" fill="${theme.s1}"/>`;
    s += `<text x="${cx}" y="${y - 4}" fill="${theme.ink}" font-size="11" font-weight="600" text-anchor="middle">${p.value || ''}</text>`;
    s += `<text x="${cx}" y="${height - 8}" fill="${theme.muted}" font-size="11" text-anchor="middle">${esc(p.label)}</text></g>`;
  });
  s += `<line x1="${left}" y1="${top + plotH}" x2="${width - 10}" y2="${top + plotH}" stroke="${theme.axis}"/></svg>`;
  return s;
}

/** 100% stacked bar (≤3 parts, categorical slots 1-3) with legend + direct labels. */
export function stack100(parts, { theme = LIGHT, width = 640, unit = '건' } = {}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const cols = [theme.s1, theme.s2, theme.s3];
  const barY = 8, barH = 26, h = 82;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" font-family="${theme.font}" font-size="12" style="max-width:100%;height:auto">`;
  let x = 0;
  const shown = parts.filter((p) => p.value > 0);
  shown.forEach((p, i) => {
    const w = (p.value / total) * width, gap = i < shown.length - 1 ? 2 : 0;
    s += `<g><title>${esc(p.label)}: ${p.value}${unit} (${Math.round((p.value / total) * 100)}%)</title><rect x="${x}" y="${barY}" width="${Math.max(0, w - gap)}" height="${barH}" rx="${i === 0 || i === shown.length - 1 ? 4 : 0}" fill="${cols[parts.indexOf(p)]}"/>`;
    if (w > 70) s += `<text x="${x + 8}" y="${barY + 17}" fill="#ffffff" font-weight="600">${Math.round((p.value / total) * 100)}%</text>`;
    s += `</g>`;
    x += w;
  });
  let lx = 0;
  parts.forEach((p, i) => {
    s += `<rect x="${lx}" y="${barY + barH + 18}" width="10" height="10" rx="2" fill="${cols[i]}"/><text x="${lx + 16}" y="${barY + barH + 27}" fill="${theme.ink2}">${esc(p.label)} ${p.value}${unit} (${Math.round((p.value / total) * 100)}%)</text>`;
    lx += 16 + (p.label.length + String(p.value).length + 8) * 9;
  });
  return s + '</svg>';
}

/** Heat table (topic × month), sequential blue; returns HTML table. */
export function heatTable(rowLabels, colLabels, matrix, { theme = LIGHT } = {}) {
  const max = Math.max(1, ...matrix.flat());
  const cell = (v) => {
    if (!v) return `<td style="text-align:center;color:${theme.muted};border:1px solid ${theme.grid}">·</td>`;
    const idx = Math.min(theme.seq.length - 1, 2 + Math.round((v / max) * (theme.seq.length - 3)));
    const bg = theme.seq[idx], fg = idx >= 7 ? '#ffffff' : theme.ink;
    return `<td style="text-align:center;background:${bg};color:${fg};font-weight:600;border:1px solid ${theme.grid}">${v}</td>`;
  };
  let h = `<table style="border-collapse:collapse;font-size:12px;width:100%"><tr><th style="text-align:left;padding:4px 6px;border:1px solid ${theme.grid}">주제</th>${colLabels.map((c) => `<th style="padding:4px 6px;border:1px solid ${theme.grid};font-variant-numeric:tabular-nums">${esc(c)}</th>`).join('')}</tr>`;
  rowLabels.forEach((r, i) => { h += `<tr><td style="padding:4px 6px;border:1px solid ${theme.grid}">${esc(r)}</td>${matrix[i].map(cell).join('')}</tr>`; });
  return h + '</table>';
}

// ---- aggregations (shared) ----
export function topicCounts(items, topics) {
  // biggest first, but '기타' always last
  return topics.map((t) => ({ key: t.id, label: t.name, value: items.filter((i) => i.topicId === t.id).length })).filter((r) => r.value > 0 || r.key !== 'etc').sort((a, b) => (a.key === 'etc') - (b.key === 'etc') || b.value - a.value);
}
export function monthly(items, start, end) {
  const out = []; const s = new Date(start.slice(0, 7) + '-01'), e = new Date(end.slice(0, 7) + '-01');
  for (let d = new Date(s); d <= e; d.setMonth(d.getMonth() + 1)) {
    const k = d.toISOString().slice(0, 7);
    out.push({ key: k, label: `${+k.slice(5)}월`, value: items.filter((i) => i.date.startsWith(k)).length });
  }
  return out;
}
/** Weekly counts (weeks start Monday) between start and end. */
export function weekly(items, start, end) {
  const d0 = new Date(start + 'T00:00:00Z'); d0.setUTCDate(d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7));
  const out = [];
  for (let d = new Date(d0); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    const a = d.toISOString().slice(0, 10), e = new Date(d); e.setUTCDate(e.getUTCDate() + 6); const b = e.toISOString().slice(0, 10);
    out.push({ key: a, label: `${+a.slice(5, 7)}/${+a.slice(8)}`, title: `${a} ~ ${b} 주`, value: items.filter((i) => i.date >= a && i.date <= b).length });
  }
  return out;
}
export const SOURCE_KIND =(t) => (['보도자료', '법령', '사업공고/예산', '정책 동향'].includes(t) ? '정부·공공기관' : ['정책 보고서', '해외 정책자료'].includes(t) ? '연구기관·보고서' : '언론');
