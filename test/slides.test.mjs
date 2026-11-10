// Slide scenes, a tour's own pages, document outlines, scratch tours and schema copies (src/slides.mjs and friends).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSlide, needsBrowser, outline, servePages, slideHtml } from '../src/slides.mjs';
import { loadTourJson } from '../src/declarative.mjs';
import { check, writeSchemaCopy } from '../src/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-slides-'));
const write = (dir, name, doc) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
const cli = (args, opts = {}) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args, '--json'], { encoding: 'utf8', timeout: 120000, ...opts });

test('outline: a title slide, one slide per section, bullets, code and narration', () => {
  const md = '# Spike\n\nWhat we tried.\n\n## Concern\n\nIt might not fit. It does fit.\n\n## Built\n\n- a validator\n- **17** tests\n\n```\nPOST /x\n```\n\n## Next\n\n1. ship it\n';
  const { title, scenes } = outline(md);
  assert.equal(title, 'Spike');
  assert.deepEqual(scenes.map(s => s.title), ['Spike', 'Concern', 'Built', 'Next']);
  assert.equal(scenes[0].slide.subtitle, 'What we tried.');
  assert.deepEqual(scenes[1].slide.bullets, ['It might not fit.', 'It does fit.']);
  assert.deepEqual(scenes[2].slide.bullets, ['a validator', '**17** tests']);
  assert.equal(scenes[2].slide.code, 'POST /x');
  assert.match(scenes[2].narration, /a validator\. 17 tests\./);
  assert.ok(scenes.every(s => s.narration && isSlide(s)));
  // Headings inside code blocks are not sections.
  assert.equal(outline('# A\n\n## B\n\n```\n## not a heading\n```\n\n## C\n\ntext\n').scenes.length, 3);
});

test('slideHtml escapes text and keeps the little inline markdown', () => {
  const html = slideHtml({ number: 2, title: 'T', slide: { bullets: ['<script>x</script> **bold** `code`'] } }, { total: 3 });
  assert.ok(!html.includes('<script>x'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<b>bold<\/b> <code>code<\/code>/);
  assert.match(html, /2 \/ 3/);
});

test('a tour of slides needs no app; slides refuse steps; schema accepts slide scenes', () => {
  const dir = tmp();
  const doc = { name: 'explain', style: 'explainer', scenes: [{ title: 'Hi', narration: 'Hello.', slide: { subtitle: 'x' } }] };
  assert.deepEqual(check('tour', doc), []);
  const def = loadTourJson(write(dir, 'a.tour.json', doc), { toolRoot: root });
  assert.equal(def.needsBrowser, false);
  assert.equal(def.scenes[0].slide.subtitle, 'x');
  assert.throws(() => loadTourJson(write(dir, 'b.tour.json', { scenes: [{ title: 'S', narration: 'n', slide: {}, steps: [{ wait: 1 }] }] }), { toolRoot: root }), /slide scene has no "steps"/);
  // Mixed with a recorded scene, it needs a target again.
  assert.throws(() => loadTourJson(write(dir, 'c.tour.json', { scenes: [{ title: 'S', narration: 'n', slide: {} }, { title: 'App', narration: 'n', steps: [{ wait: 1 }] }] }), { toolRoot: root }), /no target/);
  assert.ok(needsBrowser([{ slide: {} }, { steps: [] }]));
  // A missing image is a config error at load time.
  assert.throws(() => loadTourJson(write(dir, 'd.tour.json', { scenes: [{ title: 'S', narration: 'n', slide: { image: 'nope.png' } }] }), { toolRoot: root }), /slide image "nope.png" not found/);
});

test('"pages" is the baseUrl of a stand-alone tour, and is served only inside its folder', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages', 'index.html'), '<h1>Hi</h1>');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
  const def = loadTourJson(write(dir, 'p.tour.json', { pages: 'pages', scenes: [{ title: 'P', narration: 'n', url: 'index.html', steps: [{ verify: { text: 'Hi' } }] }] }), { toolRoot: root });
  assert.equal(def.pagesDir, path.join(dir, 'pages'));
  assert.throws(() => loadTourJson(write(dir, 'q.tour.json', { pages: 'missing', scenes: [{ title: 'P', narration: 'n', steps: [] }] }), { toolRoot: root }), /"pages" folder/);
  const s = await servePages(path.join(dir, 'pages'));
  try {
    assert.equal(await (await fetch(`${s.url}/`)).text(), '<h1>Hi</h1>');
    assert.equal((await fetch(`${s.url}/..%2fsecret.txt`)).status, 403);
    assert.equal((await fetch(`${s.url}/nope.html`)).status, 404);
  } finally { await s.close(); }
});

test('aft schema --write puts a copy beside a file outside the checkout', () => {
  const dir = tmp();
  const ref = writeSchemaCopy(dir, 'tour');
  assert.equal(ref, '.aft-schemas/tour.schema.json');
  const copy = JSON.parse(fs.readFileSync(path.join(dir, ref), 'utf8'));
  assert.equal(copy.$id, undefined);
  assert.ok(fs.existsSync(path.join(dir, '.aft-schemas', 'common.schema.json')));
});

test('aft validate of a slides-only tour draws every slide, with no browser target', () => {
  const dir = tmp();
  const file = write(dir, 'v.tour.json', { name: 'v', style: 'explainer', scenes: [
    { title: 'One', narration: 'First.', slide: { subtitle: 'a' } }, { title: 'Two', narration: 'Second.', slide: { bullets: ['b'] } }] });
  const r = cli(['validate', file, '--out', path.join(dir, 'run')], { cwd: dir });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, r.stderr);
  assert.equal(out.data.steps, 2);
  assert.ok(fs.existsSync(path.join(dir, 'run', 'slides', 'scene-02.png')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run', 'validation.json'), 'utf8')).review, null);
});

test('generate --from writes an explainer tour from a document', () => {
  const dir = tmp();
  const doc = path.join(dir, 'notes.md');
  fs.writeFileSync(doc, '# Notes\n\nIntro.\n\n## One\n\n- a\n\n## Two\n\n- b\n');
  const r = cli(['generate', '--from', doc, '--out', path.join(dir, 'gen')], { cwd: dir });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, r.stderr);
  const tour = JSON.parse(fs.readFileSync(out.data.tour, 'utf8'));
  assert.equal(tour.style, 'explainer');
  assert.equal(tour.scenes.length, 3);
  assert.deepEqual(check('tour', tour), []);
});
