// PDF via headless Edge; chart PNGs via Edge screenshots; hwpx via Hangul (HWP) COM.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
export const exportCaps = () => ({ pdf: !!EDGE, hwpx: process.platform === 'win32' && fs.existsSync('C:\\Program Files (x86)\\Hnc') });

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const ch = spawn(bin, args, { windowsHide: true });
    let err = '';
    ch.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { ch.kill(); reject(new Error('시간 초과')); }, timeoutMs);
    ch.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
    ch.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
const edgeArgs = (profile) => ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`];

export async function toPdf(htmlPath, pdfPath, tmpDir) {
  if (!EDGE) throw new Error('Microsoft Edge 없음');
  await run(EDGE, [...edgeArgs(path.join(tmpDir, 'edge')), '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href]);
  if (!fs.existsSync(pdfPath)) throw new Error('PDF 생성 실패');
  return pdfPath;
}

/** svgs: {id: svgString}. Returns {id: {src, w}} for <img> use. */
export async function chartsToPng(svgs, dir, tmpDir) {
  if (!EDGE) throw new Error('Microsoft Edge 없음');
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [id, svg] of Object.entries(svgs)) {
    const w = +(svg.match(/width="(\d+)"/)?.[1] || 620), h = +(svg.match(/height="(\d+)"/)?.[1] || 300);
    const html = path.join(dir, `${id}.html`), png = path.join(dir, `${id}.png`);
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">${svg}</body>`, 'utf8');
    await run(EDGE, [...edgeArgs(path.join(tmpDir, 'edge')), '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${w},${h}`, `--screenshot=${png}`, pathToFileURL(html).href]);
    fs.rmSync(html, { force: true });
    if (fs.existsSync(png)) out[id] = { src: pathToFileURL(png).href, file: png, w, h };
  }
  return out;
}

export async function toHwpx(htmlPath, hwpxPath, tmpDir) {
  const ps1 = path.join(tmpDir, 'to_hwpx.ps1');
  fs.writeFileSync(ps1, '\ufeff' + `param([string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
$h = New-Object -ComObject HWPFrame.HwpObject
try {
  [void]$h.SetMessageBoxMode(0x00020021)
  if (-not $h.Open($In, 'HTML', 'code:utf8')) { throw 'open failed' }
  for ($k = 0; $k -lt 10; $k++) {
    [void]$h.HAction.Run('MoveDocBegin')
    $act = $h.HAction; $set = $h.HParameterSet.HFindReplace
    [void]$act.GetDefault('RepeatFind', $set.HSet)
    $set.FindString = '@@PB@@'; $set.Direction = 0; $set.IgnoreMessage = 1; $set.FindType = 1
    if (-not $act.Execute('RepeatFind', $set.HSet)) { break }
    [void]$h.HAction.Run('Delete'); [void]$h.HAction.Run('BreakPage')
  }
  if (-not $h.SaveAs($Out, 'HWPX', '')) { throw 'save failed' }
  "pages=$($h.PageCount)"
} finally { $h.Clear(1); $h.Quit() }
`, 'utf8');
  fs.rmSync(hwpxPath, { force: true });
  let r;
  try { r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-In', htmlPath, '-Out', hwpxPath], 150000); }
  catch (e) {
    // a hidden Hangul window stuck on a dialog: close windowless Hwp processes we started
    await run('powershell.exe', ['-NoProfile', '-Command', "Get-Process Hwp -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force"], 30000).catch(() => {});
    throw new Error('hwpx 변환 시간 초과(한글 프로그램 응답 없음)');
  }
  if (!fs.existsSync(hwpxPath)) throw new Error('hwpx 생성 실패: ' + r.err.slice(0, 200));
  return hwpxPath;
}
