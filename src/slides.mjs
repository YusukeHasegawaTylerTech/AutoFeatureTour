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
export const BLOCKS = ['body', 'bullets', 'code', 'table', 'columns', 'stats', 'flow', 'chart', 'callout', 'image'];
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
  // The glyph gives the tone and comes off the text: the colour says it.
  return m ? { text: (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim(), tone: GLYPH[m[1]] } : { text: s };
}

/** The tone a ✓ △ ✗ ℹ at the start or end of any of these texts gives, else undefined. */
const glyphTone = (...texts) => texts.map(t => (t == null ? undefined : toned(String(t)).tone)).find(Boolean);
/** Text without its tone glyph. */
const bare = t => (t == null ? t : toned(String(t)).text);
/** A table row's tone from a glyph in any of its cells (the whole row takes it). */
const rowTone = cells => glyphTone(...cells.map(c => (typeof c === 'object' ? c.text : c)));

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

const CONNECTORS = { '+': '+', '=': '=', '→': '→', '->': '→', '&': '&amp;', 'or': 'or', 'vs': 'vs' };

/** Which item of a revealed slide each element is: data-i on everything that builds in. */
let item = 0;
const it = () => ` data-i="${item++}"`;

function block(kind, v, { dir, reveal, caption }) {
  const r = reveal ? it : () => '';
  switch (kind) {
    case 'body': return `<div class="body">${String(v).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p${r()}>${inline(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    case 'bullets': return `<ul>${v.map(toned).map(b => `<li class="${b.tone ?? ''}"${r()}>${inline(b.text)}</li>`).join('')}</ul>`;
    // Comments (// … and # … to the end of a line) are dimmed.
    case 'code': return `<pre${r()}>${esc(v).split('\n').map(l => l.replace(/(^|\s)(\/\/.*|#(?![\w{]).*)$/, '$1<span class="cm">$2</span>')).join('\n')}</pre>`;
    case 'table': {
      const rows = (v.rows ?? []).map(row => (Array.isArray(row) ? { cells: row } : row));
      const cell = (c, tag) => { const t = toned(c); return `<${tag} class="${t.tone ?? ''}">${inline(t.text)}</${tag}>`; };
      return `<table>${v.head?.length ? `<thead><tr>${v.head.map(h => cell(h, 'th')).join('')}</tr></thead>` : ''}<tbody>${rows.map(row =>
        `<tr class="${row.tone ?? rowTone(row.cells) ?? ''}"${r()}>${row.cells.map(c => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
    }
    // A card builds in, then each of its bullets.
    case 'columns': return `<div class="columns">${v.map(c => `<div class="col ${c.tone ?? glyphTone(c.heading, c.body) ?? ''}"${r()}>${c.heading ? `<h3>${inline(bare(c.heading))}</h3>` : ''}${c.body ? `<p>${inline(bare(c.body))}</p>` : ''}${c.bullets?.length ? `<ul>${c.bullets.map(toned).map(b => `<li class="${b.tone ?? ''}"${r()}>${inline(b.text)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div>`;
    case 'stats': return `<div class="stats">${v.map(s => `<div class="stat ${s.tone ?? glyphTone(s.value, s.label) ?? ''}"${r()}><div class="value">${inline(bare(s.value))}</div><div class="label">${inline(bare(s.label ?? ''))}</div></div>`).join('')}</div>`;
    case 'flow': {
      // Boxes and connectors: "+", "=", "→" (or "->") between boxes as written; two boxes in a row get "→".
      const out = [];
      let prevBox = false;
      for (const f of v) {
        const c = typeof f === 'string' ? f.trim() : null;
        if (c && CONNECTORS[c]) { out.push(`<div class="arrow">${CONNECTORS[c]}</div>`); prevBox = false; continue; }
        if (prevBox) out.push('<div class="arrow">→</div>');
        const t = toned(f);
        out.push(`<div class="step ${t.tone ?? ''}"${r()}>${inline(t.text)}</div>`);
        prevBox = true;
      }
      return `<div class="flow">${out.join('')}</div>`;
    }
    case 'callout': { const c = typeof v === 'string' ? { text: v } : v; return `<div class="callout ${c.tone ?? glyphTone(c.text) ?? 'info'}"${r()}>${inline(bare(c.text))}</div>`; }
    case 'image': { const f = slideImage(v, dir); return `<figure class="img"${r()}><img src="data:${MIME[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(f).toString('base64')}">${caption ? `<figcaption>${inline(caption)}</figcaption>` : ''}</figure>`; }
    case 'chart': {
      // Horizontal bars, scaled to the largest value (or "max").
      const max = v.max ?? (Math.max(...v.bars.map(b => b.value), 0) || 1);
      // A currency unit goes before the number ($6.77), any other after it (80 ms).
      const fmt = n => { const x = Number.isInteger(n) ? n.toLocaleString('en-US') : String(n); return !v.unit ? x : CURRENCY.test(v.unit) ? `${v.unit}${x}` : `${x} ${v.unit}`; };
      return `<div class="chart">${v.bars.map(b => { const t = toned(b.label); return `<div class="cbar ${b.tone ?? t.tone ?? ''}"${r()}><div class="blabel">${inline(t.text)}</div><div class="track"><div class="fill" style="width:${Math.max(0.5, Math.min(100, (b.value / max) * 100)).toFixed(1)}%"></div></div><div class="bvalue">${esc(fmt(b.value))}</div></div>`; }).join('')}</div>`;
    }
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
  const html = kinds.filter(k => !(side && k === 'image')).map(k => block(k, s[k], { dir, reveal: !!s.reveal, caption: s.caption })).join('');
  const titleOnly = !kinds.length;
  const content = side ? `<div class="split"><div class="text">${html}</div>${block('image', s.image, { dir, reveal: !!s.reveal, caption: s.caption })}</div>` : `<div class="text">${html}</div>`;
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
  tr.ok td, td.ok { color: ${t.ok}; } tr.warn td, td.warn { color: ${t.warn}; } tr.bad td, td.bad { color: ${t.bad}; } tr.info td, td.info { color: ${t.info}; }
  .columns { display: flex; gap: 40px; } .col { flex: 1; min-width: 0; background: ${t.panel}; border-radius: 18px; padding: 32px 36px; border-top: 8px solid ${t.line}; font-size: 34px; }
  .col h3 { font-size: 38px; margin-bottom: 18px; } .col p { margin-bottom: 14px; }
  .col.ok { border-top-color: ${t.ok}; } .col.warn { border-top-color: ${t.warn}; } .col.bad { border-top-color: ${t.bad}; } .col.info { border-top-color: ${t.info}; }
  .stats { display: flex; gap: 40px; } .stat { flex: 1; min-width: 0; background: ${t.panel}; border-radius: 18px; padding: 36px; }
  .stat .value { font-size: 84px; font-weight: 700; color: ${t.accent}; line-height: 1.05; } .stat .label { font-size: 32px; color: ${t.dim}; margin-top: 14px; }
  .stat.ok .value { color: ${t.ok}; } .stat.warn .value { color: ${t.warn}; } .stat.bad .value { color: ${t.bad}; }
  .flow { display: flex; align-items: stretch; gap: 20px; } .flow .step { flex: 1; min-width: 0; background: ${t.panel}; border-radius: 16px; padding: 28px; font-size: 32px; display: flex; align-items: center; justify-content: center; text-align: center; }
  .flow .arrow { display: flex; align-items: center; font-size: 56px; color: ${t.accent}; }
  .flow .step.ok { box-shadow: inset 0 0 0 4px ${t.ok}; } .flow .step.warn { box-shadow: inset 0 0 0 4px ${t.warn}; } .flow .step.bad { box-shadow: inset 0 0 0 4px ${t.bad}; } .flow .step.info { box-shadow: inset 0 0 0 4px ${t.info}; }
  pre .cm { color: ${t.dim}; opacity: 0.8; }
  .stat .value { white-space: nowrap; }
  body.dim [data-i].past { opacity: 0.38; }
  .callout { border-left: 12px solid ${t.info}; background: ${t.panel}; border-radius: 12px; padding: 26px 34px; font-size: 38px; }
  .callout.ok { border-left-color: ${t.ok}; } .callout.warn { border-left-color: ${t.warn}; } .callout.bad { border-left-color: ${t.bad}; }
  .split { display: flex; gap: 64px; width: 100%; } .split > .img { flex: 0 0 44%; }
  .img { display: flex; align-items: center; justify-content: center; min-height: 0; flex: 1; }
  .img img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; min-height: 0; }
  figure.img { flex-direction: column; margin: 0; gap: 16px; } figcaption { font-size: 28px; color: ${t.dim}; text-align: center; }
  .chart { display: flex; flex-direction: column; gap: 22px; font-size: 32px; }
  .cbar { display: grid; grid-template-columns: 30% 1fr 300px; gap: 24px; align-items: center; }
  .track { height: 44px; background: ${t.panel}; border-radius: 10px; overflow: hidden; } .fill { height: 100%; background: ${t.accent}; border-radius: 10px; }
  .cbar.ok .fill { background: ${t.ok}; } .cbar.warn .fill { background: ${t.warn}; } .cbar.bad .fill { background: ${t.bad}; }
  .bvalue { font-weight: 650; white-space: nowrap; text-align: right; }
  footer { display: flex; gap: 40px; justify-content: space-between; align-items: flex-end; color: ${t.dim}; font-size: 24px; margin-top: 20px; }
  footer .note { flex: 1; min-width: 0; } footer .page { white-space: nowrap; }
  body.title { justify-content: center; } body.title main { display: none; }
  body.title footer { position: absolute; left: 140px; right: 140px; bottom: 72px; margin: 0; }
</style></head><body class="${[titleOnly && 'title', s.dim && 'dim'].filter(Boolean).join(' ')}">
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
        // Big numbers shrink to fit their tile (down to half size); a value still too wide is reported.
        const values = [...document.querySelectorAll('.stat .value')];
        const tooWide = [];
        for (const v of values) {
          let size = parseFloat(getComputedStyle(v).fontSize);
          const min = size / 2;
          while (v.scrollWidth > v.clientWidth + 1 && size > min) { size -= 2; v.style.fontSize = `${size}px`; }
          if (v.scrollWidth > v.clientWidth + 1) tooWide.push(v.textContent);
        }
        const lines = el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '1'));
        const m = document.querySelector('main'), f = document.querySelector('footer .note'), h = document.querySelector('h1');
        const over = el => !!el && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2);
        return { main: over(m) || [...(m?.querySelectorAll('*') ?? [])].some(e => e.getBoundingClientRect().bottom > m.getBoundingClientRect().bottom + 2),
          footer: !!f && f.getBoundingClientRect().height > 40, tooWide,
          labels: [...document.querySelectorAll('.stat .label')].filter(l => l.textContent && lines(l) > 2).map(l => l.textContent),
          heading: !!h && lines(h) > 2 };
      });
      // An image written before the text is a block of its own (full width); written last, it sits beside the text.
      const kinds = Object.keys(s.slide).filter(k => BLOCKS.includes(k));
      const imageFirst = kinds.includes('image') && kinds.at(-1) !== 'image';
      if (fit.main) warnings.push(`${s.id}: the slide's content doesn't fit (${imageFirst ? 'the image comes before the text, so it takes the full width: write it last to put it beside the text; or ' : ''}shorten it, or split the scene)`);
      if (fit.footer) warnings.push(`${s.id}: the footer note wraps; "note" is small print (a source, a date): use "callout" for a takeaway`);
      for (const v of fit.tooWide) warnings.push(`${s.id}: the stat "${v}" doesn't fit its tile even at half size (shorten it, or use fewer stats)`);
      for (const l of fit.labels) warnings.push(`${s.id}: the stat label "${l}" runs over two lines (shorten it)`);
      if (fit.heading) warnings.push(`${s.id}: the heading runs over two lines (shorten it, or move part of it to "kicker" or "subtitle")`);
      const file = path.join(slidesDir, `${s.id}.png`);
      await page.screenshot({ path: file });
      files[s.id] = file;
      if (s.slide.reveal) {
        const count = await page.evaluate(() => document.querySelectorAll('[data-i]').length);
        const at = revealTimes(s.slide.reveal, count, s.narration);
        frames[s.id] = [];
        for (let k = 0; k < count; k++) {
          // Items so far are shown; with "dim", the earlier ones are faded (not one that holds the current item).
          await page.evaluate(n => {
            const cur = document.querySelector(`[data-i="${n}"]`);
            for (const e of document.querySelectorAll('[data-i]')) {
              const i = Number(e.dataset.i);
              e.style.visibility = i <= n ? '' : 'hidden';
              e.classList.toggle('past', i < n && !e.contains(cur));
            }
          }, k);
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
/** Per-slide directive lines (never shown): Reveal:, Hold:, Note:, Use:, Theme:, Accent:. */
const DIRECTIVE = /^\s*(reveal|hold|note|use|theme|accent|layout|url|voice|rate)\s*:\s*(.*)$/i;
/** "Voice: Zira" / "Rate: 2" (a section, or the front matter) → { voice, rate }. */
const voiceOf = d => ({ ...(d.voice ? { voice: d.voice } : {}), ...(d.rate !== undefined && d.rate !== '' && Number.isFinite(Number(d.rate)) ? { rate: Number(d.rate) } : {}) });

/**
 * A ```steps block: one step per line, JSON ({ "click": "Save" }) or shorthand: goto <path> · click | dblclick |
 * hover | point | check | uncheck | focus | clear <target> · fill | type <target>: <text> · select <target>: <option>
 * · press <key> · wait <seconds> · verify <text> · verify url <path> · waitFor <target>. Blank lines and # comments are
 * skipped. A target is what a string step target is (a name, a label, a placeholder, #css).
 */
export function stepsOf(code) {
  const out = [];
  for (const raw of code.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('//')) continue;
    if (l.startsWith('{')) { try { out.push(JSON.parse(l)); continue; } catch (e) { throw new Error(`steps: not valid JSON: ${l} (${e.message})`); } }
    const m = l.match(/^(\w+)\s+(.*)$/);
    if (!m) throw new Error(`steps: "${l}": expected <action> <target>, or a JSON step`);
    const [, verb, rest] = m;
    const pair = () => { const i = rest.indexOf(': '); if (i < 0) throw new Error(`steps: "${l}": expected ${verb} <target>: <text>`); return [rest.slice(0, i).trim(), rest.slice(i + 2)]; };
    switch (verb.toLowerCase()) {
      case 'goto': out.push({ goto: rest }); break;
      case 'click': case 'dblclick': case 'hover': case 'point': case 'check': case 'uncheck': case 'focus': case 'clear':
        out.push({ [verb.toLowerCase()]: rest }); break;
      case 'waitfor': out.push({ waitFor: rest }); break;
      case 'fill': case 'type': { const [t, text] = pair(); out.push({ [verb.toLowerCase()]: t, text }); break; }
      case 'select': { const [t, option] = pair(); out.push({ select: t, option }); break; }
      case 'press': out.push({ press: rest }); break;
      case 'wait': out.push({ wait: Number(rest) }); break;
      case 'verify': { const u = rest.match(/^url\s+(.*)$/i); out.push(u ? { verify: { url: u[1] } } : { verify: { text: rest } }); break; }
      default: throw new Error(`steps: "${l}": unknown action "${verb}" (write it as a JSON step)`);
    }
  }
  return out;
}

/**
 * A ```chart block: "label | value" per line (value a number, with a unit after it if you like: "80 MB"), an
 * optional third column for a tone; "unit: ms" or "max: 100" lines set the scale. → { bars: [{ label, value, tone }],
 * unit, max }.
 */
/** Units written before the number. */
export const CURRENCY = /^(?:[$€£¥₹]|US\$|A\$|C\$)$/u;

export function chartOf(code) {
  const chart = { bars: [] };
  for (const raw of code.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const set = l.match(/^(unit|max)\s*:\s*(.+)$/i);
    if (set) { chart[set[1].toLowerCase()] = set[1].toLowerCase() === 'max' ? Number(set[2]) : set[2].trim(); continue; }
    const [label, value, tone] = l.split('|').map(x => x.trim());
    // "$6.77", "€12": a leading currency sign is the unit (shown before the number).
    const cur = String(value ?? '').match(/^\s*([$€£¥₹])/u);
    if (cur && !chart.unit) chart.unit = cur[1];
    const num = String(value ?? '').replace(/^\s*[$€£¥₹]/u, '');
    const n = parseFloat(num.replace(/,/g, ''));
    if (!label || !Number.isFinite(n)) throw new Error(`chart: "${l}": expected <label> | <number>`);
    chart.bars.push({ label, value: n, ...(TONES.includes(tone) ? { tone } : toned(label).tone ? { tone: toned(label).tone } : {}) });
    if (!chart.unit && /[a-z%]/i.test(num.replace(/[\d.,\s]/g, ''))) chart.unit = num.replace(/^[\d.,\s]+/, '').trim();
  }
  return chart;
}
const cap = s => s.replace(/^\p{Ll}/u, c => c.toUpperCase());

/** "yes", "dim", "no", or fractions ("0, 0.3, 0.6") → { reveal, dim }. */
function revealOf(v) {
  const t = String(v).trim().toLowerCase();
  if (/^(no|off|false|none)$/.test(t)) return { reveal: false };
  if (t === 'dim') return { reveal: true, dim: true };
  const nums = t.split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length && nums.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return { reveal: nums };
  return { reveal: true, ...(/dim/.test(t) ? { dim: true } : {}) };
}

/**
 * The document's front matter (between --- lines at the very top): deck settings. Keys: footer, theme, accent, voice,
 * reveal (auto | dim | off: the default for slides with two or more items), pronounce ("FOIA=Foya, RMS=R M S", or
 * indented "FOIA: Foya" lines), name, max-scenes. Returns { meta, text } (text: the document without it).
 */
export function frontMatter(markdown) {
  const m = markdown.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, text: markdown };
  const meta = {};
  let list = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const sub = line.match(/^\s+([^:]+?)\s*:\s*(.*)$/);
    if (sub && list) { meta[list][sub[1]] = sub[2].replace(/^["']|["']$/g, ''); continue; }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase(), value = kv[2].trim().replace(/^["']|["']$/g, '');
    list = null;
    if (key === 'pronounce') {
      meta.pronounce = {};
      if (value) for (const pair of value.split(/\s*,\s*/)) { const [k, ...v] = pair.split('='); if (k && v.length) meta.pronounce[k.trim()] = v.join('=').trim(); }
      else list = 'pronounce';
    } else meta[key] = value;
  }
  return { meta, text: markdown.replace(/\r\n?/g, '\n').slice(m[0].length) };
}

/** A paragraph that is a diagram: parts joined by " + ", " → ", " -> " or " = ", with at least one → or =. */
function flowOf(text) {
  const t = plain(text);
  if (!/\s(→|->|=)\s/.test(t) || t.length > 220) return null;
  const parts = t.split(/\s(\+|→|->|=)\s/).map(x => x.trim()).filter(Boolean);
  if (parts.length < 3 || parts.length > 9) return null;
  return parts.map(p => (p === '->' ? '→' : p));
}

/**
 * A markdown document (findings, a design note, release notes) as slide scenes, with no AI:
 * - front matter (see frontMatter) sets the deck: footer, theme, accent, voice, pronounce, reveal default;
 * - a title slide from the document's first heading (and its first paragraph as the subtitle), then one slide per
 *   section (the heading level that splits it into several); sub-headings become points;
 * - "Topic: claim" headings → kicker "Topic", heading "Claim"; the scene title is the topic ("Overview" for the
 *   title slide);
 * - the slide: list items → bullets ("**Label:** text" items → columns, "**number** phrase" items → stats), a table →
 *   table, a blockquote → callout, a code block → code, an image → image, a paragraph of "a + b → c" → flow, other
 *   prose → body (in the order they come);
 * - the narration: "Say: …" lines (or <!-- say: … --> comments) under the heading, never shown; without them, the
 *   section's prose and points, read as written (validate warns about what a voice misreads);
 * - directive lines, never shown: "Reveal: yes | dim | no | 0, 0.3, 0.6", "Hold: 2", "Note: …", "Use: closing"
 *   (a shared slide), "Theme: light", "Accent: #c53030".
 * Returns { title, scenes, said, meta, dropped } (said: the document wrote its narration; dropped: scenes past
 * maxScenes, when one is given).
 */
export function outline(markdown, { dir = '.', maxScenes } = {}) {
  const { meta, text } = frontMatter(markdown);
  maxScenes ??= meta['max-scenes'] ? Number(meta['max-scenes']) : Infinity;
  const lines = text
    // <!-- say: … --> comments, possibly over several lines, become Say: lines.
    .replace(/<!--\s*(?:say|narration)\s*:\s*([\s\S]*?)-->/gi, (_, t) => `Say: ${t.replace(/\s+/g, ' ').trim()}`)
    .split('\n');
  const blocks = [];
  let fence = null, lang = '';
  for (const l of lines) {
    // Fenced blocks keep their language: ```steps (a recorded scene's steps) and ```chart are not code.
    if (fence) { if (/^\s*(```|~~~)/.test(l)) { blocks.push({ code: fence.join('\n'), lang }); fence = null; } else fence.push(l); continue; }
    const open = l.match(/^\s*(?:```|~~~)\s*([\w-]*)/);
    if (open) { fence = []; lang = open[1].toLowerCase(); continue; }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    blocks.push(h ? { level: h[1].length, heading: h[2] } : { line: l });
  }
  if (fence) blocks.push({ code: fence.join('\n'), lang });
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
    const directives = {};
    const steps = [];
    let para = [], quote = [], table = [], saying = false;
    const last = kind => (parts.at(-1)?.kind === kind ? parts.at(-1) : null);
    const flush = () => {
      if (para.length) { const v = para.join(' '); const f = flowOf(v); parts.push(f ? { kind: 'flow', value: f } : { kind: 'body', value: v }); }
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
      if (b.code !== undefined) {
        flush();
        if (b.lang === 'steps') steps.push(...stepsOf(b.code));
        else if (b.lang === 'chart') parts.push({ kind: 'chart', value: chartOf(b.code) });
        else parts.push({ kind: 'code', value: b.code });
        continue;
      }
      if (b.heading) { flush(); (last('bullets') ?? parts[parts.push({ kind: 'bullets', value: [] }) - 1]).value.push(plain(b.heading)); continue; }
      const l = b.line;
      // "Say:" starts the narration; the lines right after it (up to a blank line) continue it.
      if (SAY.test(l)) { flush(); say.push(l.replace(SAY, '').trim()); saying = true; continue; }
      const d = l.match(DIRECTIVE);
      if (d) { flush(); saying = false; directives[d[1].toLowerCase()] = d[2].trim(); continue; }
      if (saying && l.trim() && !/^\s*([-*+]|\d+[.)]|>|\||!\[)/.test(l)) { say.push(l.trim()); continue; }
      saying = false;
      const img = l.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/);
      if (img) { flush(); if (!/^[a-z]+:/i.test(img[2])) parts.push({ kind: 'image', value: img[2], caption: img[1].trim() }); continue; }
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
    return { parts, say, directives, steps };
  };

  const docTitle = plain(titleBlock?.heading ?? sections.find(s => s.heading)?.heading ?? 'Overview');
  const autoReveal = meta.reveal && !/^(no|off|false|none)$/i.test(meta.reveal) ? revealOf(meta.reveal === 'auto' ? 'yes' : meta.reveal) : null;
  const scenes = [];
  const keys = []; // the section each scene came from (its heading), for --update to pair generations
  let said = false;
  for (const sec of sections) {
    const { parts, say, directives, steps } = parse(sec.body);
    if (!sec.heading && !parts.length && !say.length && !Object.keys(directives).length && !steps.length) continue;
    const heading = plain(sec.heading ?? docTitle);
    // A ```steps block: a recorded scene (the app or the tour's pages), not a slide. "Url:" opens a path first.
    if (steps.length) {
      const split0 = heading.match(/^([^:]{2,60}):\s+(\S.*)$/);
      const t = split0 ? plain(split0[1]) : shortTitle(heading);
      if (say.length) said = true;
      keys.push(sec.title ? '#' : plain(sec.heading ?? ''));
      scenes.push({ title: t, narration: say.join(' ') || heading, ...(directives.url ? { url: directives.url } : {}), steps,
        ...(directives.hold !== undefined && Number.isFinite(Number(directives.hold)) ? { hold: Number(directives.hold) } : {}), ...voiceOf(directives) });
      continue;
    }
    let slide = { heading };
    const bodies = parts.filter(p => p.kind === 'body');
    if (sec.title) {
      // The title slide: the first paragraph is its subtitle; the rest of it stays as content.
      if (bodies[0]) { slide.subtitle = plain(bodies[0].value); parts.splice(parts.indexOf(bodies[0]), 1); }
    }
    for (const p of parts) {
      let v = p.value;
      if (p.kind === 'image') {
        if (!fs.existsSync(path.resolve(dir, v)) || slide.image) continue;
        v = path.resolve(dir, v);
        if (p.caption) slide.caption = p.caption;
      }
      if (p.kind === 'code') v = v.split('\n').slice(0, 14).join('\n');
      if (p.kind === 'bullets') v = v.slice(0, 8);
      if (p.kind === 'body' && slide.body) { slide.body += `\n\n${v}`; continue; }
      if (p.kind in slide && p.kind !== 'body') continue; // one block of a kind per slide; the rest stays in the document
      slide[p.kind] = v;
    }
    // "Topic: claim" headings (the title slide's too): the topic is the kicker, the claim the heading.
    const split = heading.match(/^([^:]{2,60}):\s+(\S.*)$/);
    if (split) Object.assign(slide, { kicker: split[1], heading: cap(split[2]) });
    // Lists that are really cards or numbers: every item "**Label:** text" (2 to 4) → columns;
    // every item "**a number** phrase" (2 to 4) → stats. In the list's place.
    // "Layout: bullets" keeps a list as bullets.
    const b = slide.bullets;
    if (b && b.length >= 2 && b.length <= 4 && !/^bullets?$/i.test(directives.layout ?? '')) {
      const labelled = b.map(x => x.match(/^\*\*([^*]{1,40}?):?\*\*:?\s+(\S.*)$/));
      const numbers = b.map(x => x.match(/^\*\*([^*]{1,14})\*\*\s+(\S.*)$/)).map(m => (m && /\d/.test(m[1]) ? m : null));
      const replace = (key, value) => { const e = Object.entries(slide).map(([k, v]) => (k === 'bullets' ? [key, value] : [k, v])); for (const k of Object.keys(slide)) delete slide[k]; Object.assign(slide, Object.fromEntries(e)); };
      if (numbers.every(Boolean) && !slide.stats) replace('stats', numbers.map(m => ({ value: m[1], label: m[2] })));
      else if (labelled.every(Boolean) && !slide.columns) replace('columns', labelled.map(m => ({ heading: m[1], body: cap(m[2]) })));
    }
    // Directives: a shared slide, build-in, small print, look.
    if (directives.use) {
      // The shared slide's own heading wins unless the section says more than its heading.
      const { heading: _h, ...rest } = slide;
      slide = { use: directives.use, ...(parts.length ? slide : rest) };
    }
    // reveal: auto builds in a slide with two or more content blocks, or one block of two or more items (bullets,
    // cards, stats, flow boxes, table rows, chart bars).
    const items = (slide.bullets?.length ?? 0) + (slide.columns?.length ?? 0) + (slide.stats?.length ?? 0) + (slide.flow?.length ?? 0) + (slide.table?.rows?.length ?? 0) + (slide.chart?.bars?.length ?? 0);
    const blockCount = BLOCKS.filter(k => k in slide).length;
    if (directives.reveal) Object.assign(slide, revealOf(directives.reveal));
    else if (autoReveal && (items >= 2 || blockCount >= 2)) Object.assign(slide, autoReveal);
    if (slide.reveal === false) delete slide.reveal;
    if (directives.note) slide.note = directives.note;
    if (directives.theme) slide.theme = directives.theme.toLowerCase() === 'light' ? 'light' : 'dark';
    if (directives.accent) slide.accent = directives.accent;
    // Spoken: the Say lines, else the prose and points as written.
    let narration;
    if (say.length) { narration = say.join(' '); said = true; }
    else if (directives.use) narration = undefined; // the shared slide's narration
    else narration = [slide.subtitle, ...parts.filter(p => p.kind === 'body' || p.kind === 'callout').map(p => plain(p.value)),
      ...(b ?? []).map(x => plain(x).replace(/[.;:]?$/, '.'))].filter(Boolean).join(' ') || heading;
    const title = sec.title ? (split ? 'Overview' : shortTitle(heading)) : split ? plain(split[1]) : shortTitle(heading);
    const hold = directives.hold !== undefined && Number.isFinite(Number(directives.hold)) ? { hold: Number(directives.hold) } : {};
    keys.push(sec.title ? '#' : plain(sec.heading ?? ''));
    scenes.push({ title, ...(narration !== undefined ? { narration } : {}), slide, ...hold, ...voiceOf(directives) });
  }
  // Short titles that repeat (five "Foundry: …" headings) name reports and captions badly: those take the whole
  // heading ("Foundry: The existing project"); any still the same are numbered.
  const count = list => list.reduce((m, s) => m.set(s.title, (m.get(s.title) ?? 0) + 1), new Map());
  let seen = count(scenes);
  for (const s of scenes) if (seen.get(s.title) > 1 && s.slide?.kicker && s.slide.heading) s.title = `${s.slide.kicker}: ${s.slide.heading}`;
  seen = count(scenes);
  const n = new Map();
  for (const s of scenes) if (seen.get(s.title) > 1) { n.set(s.title, (n.get(s.title) ?? 0) + 1); s.title = `${s.title} (${n.get(s.title)})`; }
  let dropped = 0;
  if (scenes.length > maxScenes) {
    dropped = scenes.length - maxScenes;
    scenes.length = maxScenes;
  }
  // Keys are unique: a heading used twice is "<heading> #2".
  const used = new Map();
  const uniq = keys.slice(0, scenes.length).map(k => { const n = (used.get(k) ?? 0) + 1; used.set(k, n); return n > 1 ? `${k} #${n}` : k; });
  return { title: docTitle, scenes, said, meta, dropped, keys: uniq };
}

/** The tour-level settings front matter gives: { platform, env, role, pages (as written), slides, pronounce, voice, name }. */
export function deckSettings(meta = {}) {
  const slides = Object.fromEntries(['theme', 'accent', 'footer'].filter(k => meta[k]).map(k => [k, meta[k]]));
  const app = Object.fromEntries(['platform', 'env', 'role', 'pages'].filter(k => meta[k]).map(k => [k, meta[k]]));
  return { ...app, slides: { theme: 'dark', ...slides }, pronounce: meta.pronounce ?? {}, ...voiceOf(meta), ...(meta.name ? { name: meta.name } : {}) };
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

// ---- Shared slides ------------------------------------------------------------------------------------------------

/**
 * "slide": { "use": "<name or file>", …overrides }: a slide kept in a file of its own (a title or closing slide, a
 * team's disclaimer), shared by several tours. A name is platforms/<p>/slides/<name>.json, else slides/<name>.json
 * beside the tour; a path (with "/" or ".json") is relative to the tour. The file is { "title", "narration",
 * "slide": {…} } or a slide alone. The scene's own keys (and the slide's other keys) win. Images in it are relative
 * to the file. Mutates and returns scenes.
 */
export function resolveSlideUses(scenes, { dir, platformDir }) {
  for (const [i, s] of (scenes ?? []).entries()) {
    const use = s.slide?.use;
    if (!use) continue;
    const tries = /[\/]|\.json$/i.test(use) ? [path.resolve(dir, use)]
      : [...(platformDir ? [path.join(platformDir, 'slides', `${use}.json`)] : []), path.join(dir, 'slides', `${use}.json`)];
    const file = tries.find(f => fs.existsSync(f));
    if (!file) throw new Error(`scenes[${i}].slide.use "${use}": no such shared slide (looked for ${tries.join(', ')})`);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: not valid JSON (${e.message})`); }
    const shared = doc.slide ?? doc;
    delete shared.$schema;
    if (shared.image) shared.image = path.resolve(path.dirname(file), shared.image);
    const { use: _u, ...own } = s.slide;
    s.slide = { ...shared, ...own };
    if (!s.title) s.title = doc.title ?? path.basename(file, '.json');
    if (!s.narration && doc.narration) s.narration = doc.narration;
    s.slideFrom = file;
  }
  return scenes;
}
