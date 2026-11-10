// Slide scenes: a scene with "slide" instead of steps is a still image (heading, bullets, text, code, an image),
// drawn by a headless browser with no app, login or network, and narrated like any other scene. A tour can be all
// slides (an explainer: findings, a design review, release notes) or mix slides with recorded app scenes.
// Also: serving a tour's own static "pages" folder, and the outline of a markdown document as slide scenes
// (`aft generate --from doc.md`).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort } from './util.mjs';

export const SLIDE_SIZE = { width: 1920, height: 1080 };

/** Scenes that are slides (have "slide"); the rest are recorded in the browser (or off camera). */
export const isSlide = s => !!s?.slide;
/** True when the tour needs the browser and an app: some scene has steps, a url, or is off camera. */
export const needsBrowser = scenes => (scenes ?? []).some(s => !isSlide(s));

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A little inline markdown: **bold**, *italic*, `code`. Everything else is text. */
export const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** The slide's image file, made absolute (relative to the tour's folder). Throws when it isn't there. */
export function slideImage(image, dir) {
  const abs = path.resolve(dir, image);
  if (!fs.existsSync(abs)) throw new Error(`slide image "${image}" not found (looked in ${dir})`);
  if (!MIME[path.extname(abs).toLowerCase()]) throw new Error(`slide image "${image}": expected ${Object.keys(MIME).join(', ')}`);
  return abs;
}

const THEMES = {
  dark: { bg: '#1b2a41', fg: '#f4f6fa', dim: '#a9b6c8', panel: '#24364f', accent: '#5fb3f9' },
  light: { bg: '#f7f8fb', fg: '#1b2a41', dim: '#5a6b82', panel: '#e8ecf3', accent: '#1f6fd1' },
};

/** The HTML of one slide (1920×1080). scene: { number, title, slide }; style: the tour's "slides" settings. */
export function slideHtml({ number, title, slide }, { dir = '.', style = {}, total } = {}) {
  const t = { ...THEMES[style.theme === 'light' ? 'light' : 'dark'], ...(style.accent ? { accent: style.accent } : {}) };
  const s = slide === true ? {} : slide;
  const heading = s.heading ?? title;
  const img = s.image ? (() => { const f = slideImage(s.image, dir); return `data:${MIME[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(f).toString('base64')}`; })() : null;
  const body = (s.body ?? '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`).join('');
  const bullets = (s.bullets ?? []).length ? `<ul>${s.bullets.map(b => `<li>${inline(b)}</li>`).join('')}</ul>` : '';
  const code = s.code ? `<pre>${esc(s.code)}</pre>` : '';
  const text = body + bullets + code;
  const titleOnly = !text && !img;
  const content = img && text ? `<div class="split"><div class="text">${text}</div><div class="img"><img src="${img}"></div></div>`
    : img ? `<div class="img full"><img src="${img}"></div>` : `<div class="text">${text}</div>`;
  const footer = [style.footer, s.note].filter(Boolean).map(inline).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${SLIDE_SIZE.width}px; height: ${SLIDE_SIZE.height}px; overflow: hidden; }
  body { background: ${t.bg}; color: ${t.fg}; font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
         padding: 110px 140px 90px; display: flex; flex-direction: column; }
  .bar { width: 120px; height: 10px; background: ${t.accent}; border-radius: 5px; margin-bottom: 36px; }
  h1 { font-size: ${titleOnly ? 104 : 76}px; font-weight: 650; line-height: 1.12; letter-spacing: -0.01em; }
  .sub { font-size: 44px; color: ${t.dim}; margin-top: 28px; line-height: 1.3; }
  main { flex: 1; min-height: 0; margin-top: 56px; display: flex; }
  .text { flex: 1; min-width: 0; font-size: 44px; line-height: 1.38; }
  .text p { margin-bottom: 28px; }
  ul { padding-left: 1.1em; } li { margin-bottom: 22px; } li::marker { color: ${t.accent}; }
  code { font-family: Consolas, "Cascadia Mono", Menlo, monospace; background: ${t.panel}; padding: 0 0.25em; border-radius: 6px; font-size: 0.9em; }
  pre { font-family: Consolas, "Cascadia Mono", Menlo, monospace; font-size: 30px; line-height: 1.4; background: ${t.panel};
        padding: 32px 40px; border-radius: 16px; white-space: pre-wrap; overflow: hidden; margin-top: 8px; }
  b { color: ${t.accent}; font-weight: 650; }
  .split { display: flex; gap: 72px; width: 100%; } .split .img { flex: 0 0 46%; }
  .img { display: flex; align-items: center; justify-content: center; min-height: 0; } .img.full { width: 100%; }
  .img img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; }
  footer { display: flex; justify-content: space-between; color: ${t.dim}; font-size: 26px; margin-top: 24px; }
  body.title { justify-content: center; } body.title main { display: none; }
</style></head><body class="${titleOnly ? 'title' : ''}">
<div class="bar"></div><h1>${inline(heading)}</h1>${s.subtitle ? `<div class="sub">${inline(s.subtitle)}</div>` : ''}
<main>${titleOnly ? '' : content}</main>
<footer><span>${footer}</span><span>${number}${total ? ` / ${total}` : ''}</span></footer>
</body></html>`;
}

/**
 * Draws each slide scene to <outDir>/slides/<id>.png with a headless Chromium (no app, no network). scenes: [{ id,
 * number, title, slide }]. Returns { <id>: png path }. Text that overflows the slide is a warning, not a failure.
 */
export async function renderSlides(scenes, { outDir, dir, style, log = () => {} }) {
  const todo = scenes.filter(isSlide);
  if (!todo.length) return { files: {}, warnings: [] };
  const { chromium } = await import('playwright');
  const slidesDir = path.join(outDir, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const files = {}, warnings = [];
  try {
    const page = await browser.newPage({ viewport: SLIDE_SIZE });
    // Slides never load anything: images are inlined, and the network is off.
    await page.route('**/*', r => r.abort());
    for (const s of todo) {
      await page.setContent(slideHtml(s, { dir, style, total: scenes.filter(x => !x.offCamera).length }), { waitUntil: 'load' });
      const over = await page.evaluate(() => { const m = document.querySelector('main'); return !!m && (m.scrollHeight > m.clientHeight + 2 || m.scrollWidth > m.clientWidth + 2); });
      if (over) warnings.push(`${s.id}: the slide's text doesn't fit (shorten its bullets or body, or split the scene)`);
      const file = path.join(slidesDir, `${s.id}.png`);
      await page.screenshot({ path: file });
      files[s.id] = file;
    }
  } finally { await browser.close(); }
  log(`slides: ${todo.length} drawn${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  return { files, warnings };
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

/** Every file under dir, as forward-slash paths relative to it. */
export function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(f, base) : [path.relative(base, f).split(path.sep).join('/')];
  });
}

// ---- A document's outline as slides -------------------------------------------------------------------------------

const plain = s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
const firstSentence = p => (plain(p).match(/^.{12,}?[.!?](?=\s|$)/)?.[0] ?? plain(p)).slice(0, 140);
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);

/**
 * A markdown document (findings, a design note, release notes) as slide scenes, with no AI: a title slide from the
 * first heading, then one slide per section (the heading level that splits it into several), bullets from its list
 * items (else the first sentence of each paragraph), the first code block and image, and its prose as the narration.
 * Returns { title, scenes }.
 */
export function outline(markdown, { dir = '.', maxScenes = 12 } = {}) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  // Code blocks are kept whole (and their lines are never headings).
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
  // The section level: the highest one that occurs more than once (a single H1 is the document's title).
  const level = levels.find(lv => blocks.filter(b => b.level === lv).length > 1) ?? levels[0];
  const titleBlock = blocks.find(b => b.level && b.level < (level ?? 7)) ?? (blocks.filter(b => b.level === level).length === 1 ? blocks.find(b => b.level === level) : null);
  const sections = [];
  let cur = { heading: null, body: [] };
  for (const b of blocks) {
    if (b === titleBlock) { sections.push(cur); cur = { heading: null, title: true, body: [] }; continue; }
    if (b.level === level) { sections.push(cur); cur = { heading: b.heading, body: [] }; continue; }
    cur.body.push(b);
  }
  sections.push(cur);
  const parse = body => {
    const paras = [], bullets = [], codes = [], images = [];
    let para = [];
    const flush = () => { if (para.length) paras.push(para.join(' ')); para = []; };
    for (const b of body) {
      if (b.code !== undefined) { flush(); codes.push(b.code); continue; }
      if (b.heading) { flush(); bullets.push(plain(b.heading)); continue; } // a sub-heading reads as a point
      const l = b.line;
      for (const m of l.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) images.push(m[1]);
      const item = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)/);
      if (item) { flush(); bullets.push(item[1].trim()); continue; }
      if (!l.trim() || /^\s*([-*_]\s*){3,}$/.test(l) || /^\s*\|/.test(l)) { flush(); continue; }
      para.push(l.replace(/^\s*>\s?/, '').trim());
    }
    flush();
    return { paras: paras.filter(p => plain(p)), bullets, codes, images: images.filter(i => !/^[a-z]+:/i.test(i)) };
  };
  const docTitle = plain(titleBlock?.heading ?? sections.find(s => s.heading)?.heading ?? 'Overview');
  const scenes = [];
  for (const sec of sections) {
    const { paras, bullets, codes, images } = parse(sec.body);
    if (!sec.heading && !sec.title && !paras.length && !bullets.length) continue;
    const heading = sec.title ? docTitle : plain(sec.heading ?? docTitle);
    const spoken = paras.length ? paras.map(plain).join(' ') : bullets.map(b => plain(b).replace(/[.;:]?$/, '.')).join(' ');
    const slide = { heading };
    if (sec.title) { if (paras[0]) slide.subtitle = short(plain(paras[0]), 160); }
    else {
      // A single paragraph: its sentences are the points; several: the first sentence of each.
      const sentences = p => plain(p).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter(x => x.length > 3).map(x => short(x, 140));
      const points = (bullets.length ? bullets.map(b => short(b, 110)) : paras.length === 1 ? sentences(paras[0]) : paras.map(firstSentence)).slice(0, 6);
      if (points.length) slide.bullets = points;
      if (codes[0]) slide.code = codes[0].split('\n').slice(0, 12).join('\n');
      const img = images.find(i => fs.existsSync(path.resolve(dir, i)));
      if (img) slide.image = path.resolve(dir, img);
    }
    scenes.push({ title: heading, narration: short(spoken || heading, 900), slide });
  }
  if (scenes.length > maxScenes) {
    // Too many sections: keep the first ones, and say so on the last slide's note.
    scenes.length = maxScenes;
    scenes[maxScenes - 1].slide.note = 'continued in the document';
  }
  return { title: docTitle, scenes };
}

/** The JSON schema of a Claude answer for `generate --from --llm claude`: slide scenes only. */
export const OUTLINE_SCHEMA = {
  type: 'object', required: ['title', 'scenes'], additionalProperties: false,
  properties: {
    title: { type: 'string' },
    scenes: { type: 'array', minItems: 1, items: { type: 'object', required: ['title', 'narration', 'slide'], additionalProperties: false, properties: {
      title: { type: 'string' }, narration: { type: 'string' },
      slide: { type: 'object', additionalProperties: false, properties: {
        heading: { type: 'string' }, subtitle: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' }, maxItems: 6 }, body: { type: 'string' }, code: { type: 'string' } } } } } },
  },
};

export const OUTLINE_SYSTEM = `You turn a document (findings, a design note, release notes, a spike write-up) into a short narrated slide video.
Return a title and scenes. Each scene is one slide: a heading, at most 5 short bullets (or a short body, or a short code
excerpt), and the narration a presenter would say over it, 2 to 5 sentences of plain spoken English (no markdown, no
lists, no abbreviations a voice would stumble on). Start with a title slide (heading and subtitle only), end with a
summary or next-steps slide. Keep what the document says: never add facts, numbers or conclusions it doesn't contain.
Aim for 5 to 12 scenes.`;
