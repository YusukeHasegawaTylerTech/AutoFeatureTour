// Slide scenes: a scene with "slide" instead of steps is a still (or a short build of stills, "reveal"), drawn by a
// headless browser with no app, login or network, and narrated like any other scene. A tour can be all slides (an
// explainer: findings, a design review, release notes) or mix slides with recorded app scenes.
//
// A slide is designed in the tour file, by hand: kicker, heading, subtitle, then content blocks drawn in the order
// they are written (body, bullets, code, table, columns, stats, flow, callout, image), and a footer note. Tones (ok,
// warn, bad, info) colour bullets, rows, columns, stats and callouts; a leading ✓ / △ / ✗ / ℹ on a bullet or cell
// sets it too.
//
// Also: serving a tour's own static "pages" folder, and the outline of a markdown document as slide scenes
// (`aft generate --from doc.md`, `aft scratch --from`), with the narration written in the document ("Say:" lines).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort } from './util.mjs';

export const SLIDE_SIZE = { width: 1920, height: 1080 };
/** Content blocks, drawn in the order the slide lists them. */
export const BLOCKS = ['body', 'bullets', 'code', 'table', 'columns', 'stats', 'flow', 'callout', 'image'];
export const TONES = ['ok', 'warn', 'bad', 'info'];

/** Scenes that are slides (have "slide"); the rest are recorded in the browser (or off camera). */
export const isSlide = s => !!s?.slide;
/** True when the tour needs the browser and an app: some scene has steps, a url, or is off camera. */
export const needsBrowser = scenes => (scenes ?? []).some(s => !isSlide(s));

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A little inline markdown: **bold**, *italic*, `code`. Everything else is text. */
export const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');

const GLYPH = { '✓': 'ok', '✔': 'ok', '△': 'warn', '⚠': 'warn', '!': 'warn', '✗': 'bad', '✘': 'bad', '×': 'bad', 'ℹ': 'info' };
/** A bullet or cell: a string (a leading ✓ △ ✗ ℹ sets its tone) or { text, tone }. Returns { text, tone }. */
export function toned(x) {
  if (x && typeof x === 'object') return { text: String(x.text ?? ''), tone: x.tone };
  const s = String(x ?? '');
  const m = s.match(/^\s*([✓✔△⚠✗✘×ℹ])\s*/u) ?? s.match(/\s([✓✔△⚠✗✘×ℹ])\s*$/u);
  return m ? { text: s, tone: GLYPH[m[1]] } : { text: s };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** The slide's image file, made absolute (relative to the tour's folder). Throws when it isn't there. */
export function slideImage(image, dir) {
  const abs = path.resolve(dir, image);
  if (!fs.existsSync(abs)) throw new Error(`slide image "${image}" not found (looked in ${dir})`);
  if (!MIME[path.extname(abs).toLowerCase()]) throw new Error(`slide image "${image}": expected ${Object.keys(MIME).join(', ')}`);
  return abs;
}

const THEMES = {
  dark: { bg: '#1b2a41', fg: '#f4f6fa', dim: '#a9b6c8', panel: '#24364f', line: '#3a4f6e', accent: '#5fb3f9', ok: '#4cc38a', warn: '#f2b84b', bad: '#f06c6c', info: '#5fb3f9' },
  light: { bg: '#f7f8fb', fg: '#1b2a41', dim: '#5a6b82', panel: '#e8ecf3', line: '#c9d2e0', accent: '#1f6fd1', ok: '#1f8a52', warn: '#b7791f', bad: '#c53030', info: '#1f6fd1' },
};

/** Which item of a revealed slide each element is: data-i on everything that builds in. */
let item = 0;
const it = () => ` data-i="${item++}"`;

function block(kind, v, { dir, reveal }) {
  const r = reveal ? it : () => '';
  switch (kind) {
    case 'body': return `<div class="body">${String(v).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p${r()}>${inline(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    case 'bullets': return `<ul>${v.map(toned).map(b => `<li class="${b.tone ?? ''}"${r()}>${inline(b.text)}</li>`).join('')}</ul>`;
    case 'code': return `<pre${r()}>${esc(v)}</pre>`;
    case 'table': {
      const rows = (v.rows ?? []).map(row => (Array.isArray(row) ? { cells: row } : row));
      const cell = (c, tag) => { const t = toned(c); return `<${tag} class="${t.tone ?? ''}">${inline(t.text)}</${tag}>`; };
      return `<table>${v.head?.length ? `<thead><tr>${v.head.map(h => cell(h, 'th')).join('')}</tr></thead>` : ''}<tbody>${rows.map(row =>
        `<tr class="${row.tone ?? ''}"${r()}>${row.cells.map(c => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'columns': return `<div class="columns">${v.map(c => `<div class="col ${c.tone ?? ''}"${r()}>${c.heading ? `<h3>${inline(c.heading)}</h3>` : ''}${c.body ? `<p>${inline(c.body)}</p>` : ''}${c.bullets?.length ? `<ul>${c.bullets.map(toned).map(b => `<li class="${b.tone ?? ''}">${inline(b.text)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div>`;
    case 'stats': return `<div class="stats">${v.map(s => `<div class="stat ${s.tone ?? ''}"${r()}><div class="value">${inline(s.value)}</div><div class="label">${inline(s.label ?? '')}</div></div>`).join('')}</div>`;
    case 'flow': return `<div class="flow">${v.map((f, i) => `${i ? '<div class="arrow">→</div>' : ''}<div class="step ${toned(f).tone ?? ''}"${r()}>${inline(toned(f).text)}</div>`).join('')}</div>`;
    case 'callout': { const c = typeof v === 'string' ? { text: v } : v; return `<div class="callout ${c.tone ?? 'info'}"${r()}>${inline(c.text)}</div>`; }
    case 'image': { const f = slideImage(v, dir); return `<div class="img"${r()}><img src="data:${MIME[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(f).toString('base64')}"></div>`; }
    default: return '';
  }
}

/** The HTML of one slide (1920×1080). scene: { number, title, slide }; style: the tour's (and platform's) "slides". */
export function slideHtml({ number, title, slide }, { dir = '.', style = {}, total } = {}) {
  const s = slide === true ? {} : slide;
  const theme = { ...THEMES[(s.theme ?? style.theme) === 'light' ? 'light' : 'dark'] };
  const accent = s.accent ?? style.accent;
  if (accent) theme.accent = accent;
  item = 0;
  // Blocks in the order they are written in the slide; an image beside text when it comes last and there is text.
  const kinds = Object.keys(s).filter(k => BLOCKS.includes(k) && s[k] != null && !(Array.isArray(s[k]) && !s[k].length));
  const side = kinds.at(-1) === 'image' && kinds.length > 1 && s.imageSide !== false;
  const html = kinds.filter(k => !(side && k === 'image')).map(k => block(k, s[k], { dir, reveal: !!s.reveal })).join('');
  const titleOnly = !kinds.length;
  const content = side ? `<div class="split"><div class="text">${html}</div>${block('image', s.image, { dir, reveal: !!s.reveal })}</div>` : `<div class="text">${html}</div>`;
  const t = theme;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${SLIDE_SIZE.width}px; height: ${SLIDE_SIZE.height}px; overflow: hidden; }
  body { background: ${t.bg}; color: ${t.fg}; font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
         padding: 96px 140px 72px; display: flex; flex-direction: column; }
  .bar { width: 120px; height: 10px; background: ${t.accent}; border-radius: 5px; margin-bottom: 32px; }
  .kicker { font-size: 30px; letter-spacing: 0.08em; text-transform: uppercase; color: ${t.accent}; font-weight: 600; margin-bottom: 14px; }
  h1 { font-size: ${titleOnly ? 100 : 70}px; font-weight: 650; line-height: 1.12; letter-spacing: -0.01em; }
  .sub { font-size: 42px; color: ${t.dim}; margin-top: 24px; line-height: 1.3; }
  main { flex: 1; min-height: 0; margin-top: 48px; display: flex; overflow: hidden; }
  .text { flex: 1; min-width: 0; font-size: 40px; line-height: 1.36; display: flex; flex-direction: column; gap: 30px; }
  .body p + p { margin-top: 22px; }
  ul { padding-left: 1.1em; } li + li { margin-top: 18px; } li::marker { color: ${t.accent}; }
  li.ok::marker { color: ${t.ok}; } li.warn::marker { color: ${t.warn}; } li.bad::marker { color: ${t.bad}; }
  code { font-family: Consolas, "Cascadia Mono", Menlo, monospace; background: ${t.panel}; padding: 0 0.25em; border-radius: 6px; font-size: 0.88em; }
  pre { font-family: Consolas, "Cascadia Mono", Menlo, monospace; font-size: 28px; line-height: 1.4; background: ${t.panel};
        padding: 28px 36px; border-radius: 16px; white-space: pre-wrap; }
  b { color: ${t.accent}; font-weight: 650; }
  table { border-collapse: collapse; font-size: 34px; width: 100%; }
  th { text-align: left; color: ${t.dim}; font-weight: 600; font-size: 28px; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 24px 14px 0; border-bottom: 2px solid ${t.line}; }
  td { padding: 16px 24px 16px 0; border-bottom: 1px solid ${t.line}; vertical-align: top; }
  tr.ok td:first-child, td.ok { color: ${t.ok}; } tr.warn td:first-child, td.warn { color: ${t.warn}; } tr.bad td:first-child, td.bad { color: ${t.bad}; } td.info { color: ${t.info}; }
  .columns { display: flex; gap: 40px; } .col { flex: 1; min-width: 0; background: ${t.panel}; border-radius: 18px; padding: 32px 36px; border-top: 8px solid ${t.line}; font-size: 34px; }
  .col h3 { font-size: 38px; margin-bottom: 18px; } .col p { margin-bottom: 14px; }
  .col.ok { border-top-color: ${t.ok}; } .col.warn { border-top-color: ${t.warn}; } .col.bad { border-top-color: ${t.bad}; } .col.info { border-top-color: ${t.info}; }
  .stats { display: flex; gap: 40px; } .stat { flex: 1; min-width: 0; background: ${t.panel}; border-radius: 18px; padding: 36px; }
  .stat .value { font-size: 84px; font-weight: 700; color: ${t.accent}; line-height: 1.05; } .stat .label { font-size: 32px; color: ${t.dim}; margin-top: 14px; }
  .stat.ok .value { color: ${t.ok}; } .stat.warn .value { color: ${t.warn}; } .stat.bad .value { color: ${t.bad}; }
  .flow { display: flex; align-items: stretch; gap: 20px; } .flow .step { flex: 1; min-width: 0; background: ${t.panel}; border-radius: 16px; padding: 28px; font-size: 32px; display: flex; align-items: center; justify-content: center; text-align: center; }
  .flow .arrow { display: flex; align-items: center; font-size: 56px; color: ${t.accent}; }
  .flow .step.ok { outline: 4px solid ${t.ok}; } .flow .step.warn { outline: 4px solid ${t.warn}; } .flow .step.bad { outline: 4px solid ${t.bad}; }
  .callout { border-left: 12px solid ${t.info}; background: ${t.panel}; border-radius: 12px; padding: 26px 34px; font-size: 38px; }
  .callout.ok { border-left-color: ${t.ok}; } .callout.warn { border-left-color: ${t.warn}; } .callout.bad { border-left-color: ${t.bad}; }
  .split { display: flex; gap: 64px; width: 100%; } .split > .img { flex: 0 0 44%; }
  .img { display: flex; align-items: center; justify-content: center; min-height: 0; flex: 1; }
  .img img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; }
  footer { display: flex; gap: 40px; justify-content: space-between; align-items: flex-end; color: ${t.dim}; font-size: 24px; margin-top: 20px; }
  footer .note { flex: 1; min-width: 0; } footer .page { white-space: nowrap; }
  body.title { justify-content: center; } body.title main { display: none; }
</style></head><body class="${titleOnly ? 'title' : ''}">
<div class="bar"></div>${s.kicker ? `<div class="kicker">${inline(s.kicker)}</div>` : ''}<h1>${inline(s.heading ?? title)}</h1>${s.subtitle ? `<div class="sub">${inline(s.subtitle)}</div>` : ''}
<main>${titleOnly ? '' : content}</main>
<footer><span class="note">${[style.footer, s.note].filter(Boolean).map(inline).join(' · ')}</span><span class="page">${number}${total ? ` / ${total}` : ''}</span></footer>
</body></html>`;
}

/**
 * When each item of a revealed slide appears, as fractions of the narration: "reveal": true spreads them over the
 * narration's sentences (item k with sentence k, the last ones together), a list gives them ([0, 0.3, 0.6]).
 */
export function revealTimes(reveal, count, narration = '') {
  if (!count) return [];
  if (Array.isArray(reveal)) return Array.from({ length: count }, (_, k) => Math.min(1, Math.max(0, Number(reveal[Math.min(k, reveal.length - 1)] ?? 0))));
  const sentences = narration.split(/(?<=[.!?])\s+/).filter(x => x.trim());
  const total = sentences.reduce((a, x) => a + x.length, 0) || 1;
  const starts = [];
  let at = 0;
  for (const x of sentences) { starts.push(at / total); at += x.length; }
  // The first item is there from the start; with more items than sentences, the rest share the last sentence.
  return Array.from({ length: count }, (_, k) => (k === 0 ? 0 : starts[Math.min(k, starts.length - 1)] ?? 0));
}

/**
 * Draws each slide scene to <outDir>/slides/<id>.png with a headless Chromium (no app, no network); a revealed slide
 * also gets <id>-NN.png, one per step of its build. scenes: [{ id, number, title, narration, slide }]. Returns
 * { files: { <id>: png }, frames: { <id>: [{ file, at }] }, warnings }. Text that doesn't fit is a warning.
 */
export async function renderSlides(scenes, { outDir, dir, style, log = () => {}, total } = {}) {
  const todo = scenes.filter(isSlide);
  if (!todo.length) return { files: {}, frames: {}, warnings: [] };
  const { chromium } = await import('playwright');
  const slidesDir = path.join(outDir, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const files = {}, frames = {}, warnings = [];
  try {
    const page = await browser.newPage({ viewport: SLIDE_SIZE });
    // Slides never load anything: images are inlined, and the network is off.
    await page.route('**/*', r => r.abort());
    for (const s of todo) {
      await page.setContent(slideHtml(s, { dir, style, total: total ?? scenes.length }), { waitUntil: 'load' });
      const fit = await page.evaluate(() => {
        const m = document.querySelector('main'), f = document.querySelector('footer .note');
        const over = el => !!el && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2);
        return { main: over(m) || [...(m?.querySelectorAll('*') ?? [])].some(e => e.getBoundingClientRect().bottom > m.getBoundingClientRect().bottom + 2),
          footer: !!f && f.getBoundingClientRect().height > 40 };
      });
      if (fit.main) warnings.push(`${s.id}: the slide's content doesn't fit (shorten it, or split the scene)`);
      if (fit.footer) warnings.push(`${s.id}: the footer note wraps; "note" is small print (a source, a date): use "callout" for a takeaway`);
      const file = path.join(slidesDir, `${s.id}.png`);
      await page.screenshot({ path: file });
      files[s.id] = file;
      if (s.slide.reveal) {
        const count = await page.evaluate(() => document.querySelectorAll('[data-i]').length);
        const at = revealTimes(s.slide.reveal, count, s.narration);
        frames[s.id] = [];
        for (let k = 0; k < count; k++) {
          await page.evaluate(n => { for (const e of document.querySelectorAll('[data-i]')) e.style.visibility = Number(e.dataset.i) <= n ? '' : 'hidden'; }, k);
          const f = path.join(slidesDir, `${s.id}-${String(k + 1).padStart(2, '0')}.png`);
          await page.screenshot({ path: f });
          frames[s.id].push({ file: f, at: at[k] });
        }
      }
    }
  } finally { await browser.close(); }
  log(`slides: ${todo.length} drawn${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  return { files, frames, warnings };
}

/** A contact sheet of the drawn slides (slides/index.html), for a quick look at the whole deck. */
export function contactSheet(outDir, scenes, files) {
  const rows = scenes.filter(s => files[s.id]).map(s => `<figure><img src="${path.basename(files[s.id])}"><figcaption>${esc(`${s.number}. ${s.title}`)}</figcaption><p>${esc(s.narration)}</p></figure>`).join('\n');
  const file = path.join(outDir, 'slides', 'index.html');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Slides</title><style>body{font:16px system-ui;margin:24px;background:#eef1f6}
figure{display:inline-block;vertical-align:top;width:480px;margin:0 16px 24px 0}img{width:480px;border-radius:6px;box-shadow:0 1px 4px #0003}
figcaption{font-weight:600;margin-top:6px}p{color:#456;margin:4px 0 0;font-size:14px}</style>\n${rows}\n`);
  return file;
}

// ---- Narration that a voice reads well ---------------------------------------------------------------------------

/** Things a speech voice tends to misread, with a suggestion: "13K", "→", "a/b", ticket ids, unexplained symbols. */
export function narrationWarnings(text, pronounce = {}) {
  let t = String(text ?? '');
  for (const k of Object.keys(pronounce)) t = t.split(k).join(' ');
  const out = [];
  const add = (re, why) => { const m = t.match(re); if (m) out.push(`"${m[0].trim()}" ${why}`); };
  add(/\b\d+(?:\.\d+)?\s?[KkMB]\b(?!\w)/, 'may be read as a letter: say "thousand" / "million" / "megabytes"');
  add(/\b[A-Z][A-Z0-9]+-\d+\b/, 'is read character by character: write it as it should be said, or add it to "pronounce"');
  add(/[→←⇒+=<>~≈|]/u, 'is a symbol the voice may skip or misread: use words');
  add(/\b\w+\/\w+\b/, 'reads as "slash": use "or" / "and", or add it to "pronounce"');
  add(/\([^)]{1,40}\)/, 'parentheses are read flat: make it its own sentence or leave it on the slide');
  add(/\b(e\.g\.|i\.e\.|etc\.|vs\.?)\s/i, 'abbreviation: write it out');
  return out;
}

// ---- A tour's own static pages ------------------------------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };

/** Serves a folder on 127.0.0.1 (a free port): "/" is index.html, nothing outside the folder. Returns { url, close() }. */
export async function servePages(dir) {
  const root = path.resolve(dir);
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    let file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(() => r())) };
}

// ---- A document's outline as slides -------------------------------------------------------------------------------

const plain = s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
const sentencesOf = p => plain(p).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter(x => x.length > 3);
/** A short scene title from a heading: the part before ":" or " — " (reports and captions use it). */
const shortTitle = h => { const p = plain(h).split(/\s*(?::|\s[—–-]\s)\s*/)[0]; return p.length >= 3 ? p : plain(h); };
const SAY = /^\s*(?:say|narration)\s*:\s*/i;

/**
 * A markdown document (findings, a design note, release notes) as slide scenes, with no AI:
 * - a title slide from the document's first heading (and its first paragraph as the subtitle), then one slide per
 *   section (the heading level that splits it into several); sub-headings become points;
 * - the slide: list items → bullets, a table → table, a blockquote → callout, a code block → code, an image → image,
 *   prose → body (in the order they come);
 * - the narration: "Say: …" lines (or <!-- say: … --> comments) under the heading, never shown; without them, the
 *   section's prose and points, read as written (validate warns about what a voice misreads).
 * Returns { title, scenes, said } (said: whether the document wrote its narration).
 */
export function outline(markdown, { dir = '.', maxScenes = 12 } = {}) {
  const lines = markdown.replace(/\r\n?/g, '\n')
    // <!-- say: … --> comments, possibly over several lines, become Say: lines.
    .replace(/<!--\s*(?:say|narration)\s*:\s*([\s\S]*?)-->/gi, (_, t) => `Say: ${t.replace(/\s+/g, ' ').trim()}`)
    .split('\n');
  const blocks = [];
  let fence = null;
  for (const l of lines) {
    if (fence) { if (/^\s*(```|~~~)/.test(l)) { blocks.push({ code: fence.join('\n') }); fence = null; } else fence.push(l); continue; }
    if (/^\s*(```|~~~)/.test(l)) { fence = []; continue; }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    blocks.push(h ? { level: h[1].length, heading: h[2] } : { line: l });
  }
  if (fence) blocks.push({ code: fence.join('\n') });
  const levels = [...new Set(blocks.filter(b => b.level).map(b => b.level))].sort();
  const level = levels.find(lv => blocks.filter(b => b.level === lv).length > 1) ?? levels[0];
  const titleBlock = blocks.find(b => b.level && b.level < (level ?? 7)) ?? (blocks.filter(b => b.level === level).length === 1 ? blocks.find(b => b.level === level) : null);
  const sections = [];
  let cur = { heading: null, body: [] };
  for (const b of blocks) {
    if (b === titleBlock) { sections.push(cur); cur = { heading: b.heading, title: true, body: [] }; continue; }
    if (b.level === level) { sections.push(cur); cur = { heading: b.heading, body: [] }; continue; }
    cur.body.push(b);
  }
  sections.push(cur);

  const parse = body => {
    const parts = []; // [{ kind, value }] in document order
    const say = [];
    let para = [], quote = [], table = [], saying = false;
    const last = kind => (parts.at(-1)?.kind === kind ? parts.at(-1) : null);
    const flush = () => {
      if (para.length) parts.push({ kind: 'body', value: para.join(' ') });
      if (quote.length) parts.push({ kind: 'callout', value: quote.join(' ') });
      if (table.length) {
        const rows = table.map(r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
        const sep = rows.findIndex(r => r.every(c => /^:?-{2,}:?$/.test(c)));
        const head = sep === 1 ? rows[0] : null;
        parts.push({ kind: 'table', value: { ...(head ? { head } : {}), rows: rows.filter((r, i) => i !== sep && !(head && i === 0)) } });
      }
      para = []; quote = []; table = [];
    };
    for (const b of body) {
      if (b.code !== undefined) { flush(); parts.push({ kind: 'code', value: b.code }); continue; }
      if (b.heading) { flush(); (last('bullets') ?? parts[parts.push({ kind: 'bullets', value: [] }) - 1]).value.push(plain(b.heading)); continue; }
      const l = b.line;
      // "Say:" starts the narration; the lines right after it (up to a blank line) continue it.
      if (SAY.test(l)) { flush(); say.push(l.replace(SAY, '').trim()); saying = true; continue; }
      if (saying && l.trim() && !/^\s*([-*+]|\d+[.)]|>|\||!\[)/.test(l)) { say.push(l.trim()); continue; }
      saying = false;
      const img = l.match(/^\s*!\[[^\]]*\]\(([^)\s]+)[^)]*\)\s*$/);
      if (img) { flush(); if (!/^[a-z]+:/i.test(img[1])) parts.push({ kind: 'image', value: img[1] }); continue; }
      if (/^\s*\|/.test(l)) { if (para.length || quote.length) flush(); table.push(l); continue; }
      const item = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)/);
      if (item) { flush(); (last('bullets') ?? parts[parts.push({ kind: 'bullets', value: [] }) - 1]).value.push(item[1].trim()); continue; }
      const q = l.match(/^\s*>\s?(.*)/);
      if (q) { if (para.length || table.length) flush(); if (q[1].trim()) quote.push(q[1].trim()); continue; }
      if (!l.trim() || /^\s*([-*_]\s*){3,}$/.test(l)) { flush(); continue; }
      if (quote.length || table.length) flush();
      para.push(l.trim());
    }
    flush();
    return { parts, say };
  };

  const docTitle = plain(titleBlock?.heading ?? sections.find(s => s.heading)?.heading ?? 'Overview');
  const scenes = [];
  let said = false;
  for (const sec of sections) {
    const { parts, say } = parse(sec.body);
    if (!sec.heading && !parts.length && !say.length) continue;
    const heading = plain(sec.heading ?? docTitle);
    const slide = { heading };
    const bodies = parts.filter(p => p.kind === 'body');
    if (sec.title) {
      // The title slide: the first paragraph is its subtitle; the rest of it stays as content.
      if (bodies[0]) { slide.subtitle = plain(bodies[0].value); parts.splice(parts.indexOf(bodies[0]), 1); }
    }
    for (const p of parts) {
      let v = p.value;
      if (p.kind === 'image') { if (!fs.existsSync(path.resolve(dir, v))) continue; v = path.resolve(dir, v); }
      if (p.kind === 'code') v = v.split('\n').slice(0, 14).join('\n');
      if (p.kind === 'bullets') v = v.slice(0, 8);
      if (p.kind === 'body' && slide.body) { slide.body += `\n\n${v}`; continue; }
      if (p.kind in slide && p.kind !== 'body') continue; // one block of a kind per slide; the rest stays in the document
      slide[p.kind] = v;
    }
    // Spoken: the Say lines, else the prose and points as written.
    let narration;
    if (say.length) { narration = say.join(' '); said = true; }
    else narration = [slide.subtitle, ...parts.filter(p => p.kind === 'body' || p.kind === 'callout').map(p => plain(p.value)),
      ...(slide.bullets ?? []).map(b => plain(b).replace(/[.;:]?$/, '.'))].filter(Boolean).join(' ') || heading;
    scenes.push({ title: sec.title ? shortTitle(heading) : shortTitle(heading), narration, slide });
  }
  if (scenes.length > maxScenes) {
    scenes.length = maxScenes;
    scenes[maxScenes - 1].slide.note = 'continued in the document';
  }
  return { title: docTitle, scenes, said };
}

/** The JSON schema of a Claude answer for `generate --from --llm claude`: slide scenes only. */
export const OUTLINE_SCHEMA = {
  type: 'object', required: ['title', 'scenes'], additionalProperties: false,
  properties: {
    title: { type: 'string' },
    scenes: { type: 'array', minItems: 1, items: { type: 'object', required: ['title', 'narration', 'slide'], additionalProperties: false, properties: {
      title: { type: 'string' }, narration: { type: 'string' },
      slide: { type: 'object', additionalProperties: false, properties: {
        kicker: { type: 'string' }, heading: { type: 'string' }, subtitle: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        body: { type: 'string' }, code: { type: 'string' }, callout: { type: 'string' },
        stats: { type: 'array', maxItems: 4, items: { type: 'object', required: ['value', 'label'], additionalProperties: false, properties: { value: { type: 'string' }, label: { type: 'string' } } } },
        table: { type: 'object', required: ['rows'], additionalProperties: false, properties: { head: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } } } } } },
  },
};

export const OUTLINE_SYSTEM = `You turn a document (findings, a design note, release notes, a spike write-up) into a short narrated slide video.
Return a title and scenes. Each scene is one slide: an optional kicker, a heading, and one or two content blocks
(at most 5 short bullets, a short body, a table, up to 4 stats {value, label}, a callout for the key takeaway, or a
short code excerpt), and the narration a presenter would say over it: 2 to 5 sentences of plain spoken English, with
numbers and units written as they are said ("thirteen thousand tokens", "sixty to eighty kilobytes"), no symbols, no
markdown, no parentheses, no ticket ids. Scene titles are short (2 to 4 words). Start with a title slide (heading and
subtitle only), end with a summary or next-steps slide. Keep what the document says: never add facts, numbers or
conclusions it doesn't contain. Aim for 5 to 12 scenes.`;
