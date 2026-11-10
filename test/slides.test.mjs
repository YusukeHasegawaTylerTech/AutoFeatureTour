// Slide scenes, shared slides, a tour's own pages, document outlines, scratch tours and schema copies (src/slides.mjs and friends).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSlide, narrationWarnings, needsBrowser, outline, revealTimes, servePages, slideHtml } from '../src/slides.mjs';
import { spokenText } from '../src/script.mjs';
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
  // Prose stays prose (body), in full; lists are bullets; blocks keep the document's order.
  assert.equal(scenes[1].slide.body, 'It might not fit. It does fit.');
  assert.deepEqual(scenes[2].slide.bullets, ['a validator', '**17** tests']);
  assert.equal(scenes[2].slide.code, 'POST /x');
  assert.deepEqual(Object.keys(scenes[2].slide), ['heading', 'bullets', 'code']);
  assert.match(scenes[2].narration, /a validator\. 17 tests\./);
  assert.ok(scenes.every(s => s.narration && isSlide(s)));
  // Headings inside code blocks are not sections.
  assert.equal(outline('# A\n\n## B\n\n```\n## not a heading\n```\n\n## C\n\ntext\n').scenes.length, 3);
});

test('outline: tables, blockquotes as callouts, "Say:" narration, short titles', () => {
  const md = [
    '# Deck', '', '## Results: five of six passed', 'Say: Five of the six samples passed.', 'The sixth is a real finding.', '',
    'Sample runs:', '', '| Case | Result |', '|---|---|', '| One | valid ✓ |', '| Two | invalid ✗ |', '', '> The mismatch is a rule ambiguity.', '',
    '## Next', '<!-- say: Two things are left. -->', '- confirm the contract', '- add to CI', '',
  ].join('\n');
  const { scenes, said } = outline(md);
  assert.equal(said, true);
  const r = scenes.find(s => s.slide.table);
  assert.equal(r.title, 'Results');
  assert.equal(r.slide.heading, 'Five of six passed');
  assert.equal(r.slide.kicker, 'Results');
  assert.equal(r.narration, 'Five of the six samples passed. The sixth is a real finding.');
  assert.deepEqual(r.slide.table, { head: ['Case', 'Result'], rows: [['One', 'valid ✓'], ['Two', 'invalid ✗']] });
  assert.equal(r.slide.callout, 'The mismatch is a rule ambiguity.');
  assert.deepEqual(Object.keys(r.slide), ['heading', 'body', 'table', 'callout', 'kicker']);
  assert.ok(!JSON.stringify(r.slide).includes('Five of the six')); // narration never on the slide
  assert.equal(scenes.at(-1).narration, 'Two things are left.');
});

test('slides: blocks in written order, tones, callout apart from the footer note, reveal items', () => {
  const html = slideHtml({ number: 1, title: 'T', slide: { kicker: 'K', code: 'x = 1', bullets: ['✓ ok', { text: 'meh', tone: 'warn' }, 'plain'],
    stats: [{ value: '13K', label: 'tokens' }], callout: { text: 'Takeaway', tone: 'ok' }, note: 'source', reveal: true } });
  assert.ok(html.indexOf('<pre') < html.indexOf('<ul>'), 'code before bullets, as written');
  assert.match(html, /<li class="ok"/);
  assert.match(html, /<li class="warn"/);
  assert.match(html, /class="callout ok"/);
  assert.match(html, /<span class="note">source<\/span>/);
  assert.match(html, /class="kicker">K</);
  assert.equal((html.match(/data-i="/g) ?? []).length, 6); // code, 3 bullets, a stat, the callout
});

test('revealTimes: one item per sentence, or fractions as written', () => {
  const t = revealTimes(true, 3, 'Aaaa. Bbbb. Cccc.');
  assert.equal(t[0], 0);
  assert.ok(t[1] > 0 && t[2] > t[1] && t[2] < 1);
  assert.deepEqual(revealTimes([0, 0.5], 3), [0, 0.5, 0.5]);
});

test('narration: warnings for what a voice misreads; ranges and arrows are said', () => {
  const w = narrationWarnings('About 13K tokens (roughly). See RMS-4923 → done, e.g. now.');
  assert.ok(w.some(x => x.startsWith('"13K"')));
  assert.ok(w.some(x => x.startsWith('"RMS-4923"')));
  assert.ok(w.some(x => x.includes('symbol')));
  assert.ok(w.some(x => x.includes('parentheses')));
  assert.ok(w.some(x => x.includes('abbreviation')));
  assert.deepEqual(narrationWarnings('RMS-4923 is done.', { 'RMS-4923': 'R M S forty-nine twenty-three' }), []);
  assert.equal(spokenText('60–80 KB, a → b'), '60 to 80 KB, a to b');
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

test('round 3: flow connectors, heading split, lists as columns or stats, row tones, dim, code comments', async () => {
  const { slideHtml: html1, outline: ol } = await import('../src/slides.mjs');
  const f = html1({ number: 1, title: 'T', slide: { flow: ['Rules', '+', 'Form', '→', 'Decision', 'Done'] } });
  assert.deepEqual([...f.matchAll(/class="arrow">([^<]+)</g)].map(m => m[1]), ['+', '→', '→']);
  const t = html1({ number: 1, title: 'T', slide: { table: { rows: [{ cells: ['a', 'b'], tone: 'warn' }] }, code: 'x = 1 // why', dim: true } });
  assert.match(t, /<tr class="warn"/);
  assert.match(t, /<span class="cm">\/\/ why<\/span>/);
  assert.match(t, /<body class="dim">/);
  const md = '# D\n\n## Network load: sending rules is fine\n\n- **60 KB** of text\n- **80 MB** a day\n\n## Agents\n\n- **Misconception:** agents remember\n- **Reality:** they do not\n';
  const [, net, agents] = ol(md).scenes;
  assert.equal(net.title, 'Network load');
  assert.equal(net.slide.kicker, 'Network load');
  assert.equal(net.slide.heading, 'Sending rules is fine');
  assert.deepEqual(net.slide.stats, [{ value: '60 KB', label: 'of text' }, { value: '80 MB', label: 'a day' }]);
  assert.deepEqual(agents.slide.columns, [{ heading: 'Misconception', body: 'Agents remember' }, { heading: 'Reality', body: 'They do not' }]);
  assert.equal(agents.slide.bullets, undefined);
});

test('shared slides: "use" fills a slide from a file, the scene overrides it; hold is in the schema', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'slides'));
  fs.writeFileSync(path.join(dir, 'slides', 'closing.json'), JSON.stringify({ narration: 'Thanks.', slide: { heading: 'Questions?', subtitle: 'shared' } }));
  const doc = { scenes: [{ title: 'End', slide: { use: 'closing', subtitle: 'mine' }, hold: 2 }] };
  assert.deepEqual(check('tour', doc), []);
  const def = loadTourJson(write(dir, 's.tour.json', doc), { toolRoot: root });
  assert.deepEqual(def.scenes[0].slide, { heading: 'Questions?', subtitle: 'mine' });
  assert.equal(def.scenes[0].narration, 'Thanks.');
  assert.equal(def.scenes[0].hold, 2);
  assert.throws(() => loadTourJson(write(dir, 'u.tour.json', { scenes: [{ title: 'X', narration: 'n', slide: { use: 'nope' } }] }), { toolRoot: root }), /no such shared slide/);
});

test('round 4: front matter, directives, H1 split, flow from prose, glyph tones everywhere, no scene cap', async () => {
  const m = await import('../src/slides.mjs');
  const md = ['---', 'footer: F', 'reveal: auto', 'pronounce: FOIA=Foya, RMS=R M S', '---', '# ID-1 · Area: big question', '', 'Sub.', '',
    '## Design: one call', 'A + B → C ✓', 'Hold: 2', 'Note: small', '', '## List', '- a', '- b', 'Reveal: dim', '',
    '## End', 'Use: closing', ...Array.from({ length: 14 }, (_, i) => `\n## S${i}\n\ntext ${i}`)].join('\n');
  const { scenes, meta, dropped } = m.outline(md);
  assert.equal(dropped, 0);
  assert.equal(scenes.length, 18);
  assert.deepEqual(m.deckSettings(meta), { slides: { theme: 'dark', footer: 'F' }, pronounce: { FOIA: 'Foya', RMS: 'R M S' } });
  assert.deepEqual([scenes[0].title, scenes[0].slide.kicker, scenes[0].slide.heading], ['Overview', 'ID-1 · Area', 'Big question']);
  const d = scenes[1];
  assert.deepEqual(d.slide.flow, ['A', '+', 'B', '→', 'C ✓']);
  assert.equal(d.hold, 2);
  assert.equal(d.slide.note, 'small');
  assert.equal(d.slide.reveal, true); // reveal: auto, 2+ items
  assert.deepEqual([scenes[2].slide.reveal, scenes[2].slide.dim], [true, true]);
  assert.deepEqual(scenes[3].slide, { use: 'closing' });
  assert.equal(scenes[3].narration, undefined);
  assert.equal(m.outline(md, { maxScenes: 5 }).dropped, 13);
  const h = m.slideHtml({ number: 1, title: 't', slide: { callout: '△ careful', stats: [{ value: '1', label: 'x ✓' }], columns: [{ heading: 'A', body: 'x ✗' }, { heading: 'B' }], table: { rows: [['a', 'b △']] } } });
  assert.match(h, /callout warn/);
  assert.match(h, /stat ok/);
  assert.match(h, /col bad/);
  assert.match(h, /<tr class="warn"/);
});

test('scratch --from --update keeps hand edits and takes the document\'s changes', () => {
  const dir = tmp();
  const doc = path.join(dir, 'd.md');
  fs.writeFileSync(doc, '# Deck\n\nIntro.\n\n## One\n\n- a\n\nSay: first.\n\n## Two\n\n- b\n\nSay: second.\n');
  const name = `t-update-${process.pid}`;
  const tourFile = path.join(root, 'scratch', name, `${name}.tour.json`);
  try {
    assert.equal(JSON.parse(cli(['scratch', name, '--from', doc]).stdout).ok, true);
    const t = JSON.parse(fs.readFileSync(tourFile, 'utf8'));
    t.scenes.find(s => s.title === 'One').narration = 'mine';
    fs.writeFileSync(tourFile, JSON.stringify(t));
    fs.writeFileSync(doc, '# Deck\n\nIntro.\n\n## One\n\n- a\n\nSay: first, changed.\n\n## Two\n\n- b\n\nSay: second, changed.\n');
    assert.equal(JSON.parse(cli(['scratch', name, '--from', doc]).stdout).ok, false); // exists: needs --update or --force
    const r = JSON.parse(cli(['scratch', name, '--from', doc, '--update']).stdout);
    assert.deepEqual(r.data.kept, ['scene "One": narration']);
    const after = JSON.parse(fs.readFileSync(tourFile, 'utf8'));
    assert.equal(after.scenes.find(s => s.title === 'One').narration, 'mine');
    assert.equal(after.scenes.find(s => s.title === 'Two').narration, 'second, changed.');
  } finally { fs.rmSync(path.join(root, 'scratch', name), { recursive: true, force: true }); }
});

test('a shared-slide scene needs no title', () => {
  assert.deepEqual(check('tour', { scenes: [{ slide: { use: 'closing' } }] }), []);
  assert.ok(check('tour', { scenes: [{ narration: 'x' }] }).length);
});

test('round 5: glyphs come off the text, Layout: bullets, reveal rule, captions, steps and chart blocks', async () => {
  const m = await import('../src/slides.mjs');
  assert.deepEqual(m.toned('a guess △'), { text: 'a guess', tone: 'warn' });
  assert.deepEqual(m.toned('✓ done'), { text: 'done', tone: 'ok' });
  const h = m.slideHtml({ number: 1, title: 't', slide: { columns: [{ heading: 'A', body: 'x ℹ' }, { heading: 'B' }], callout: '△ c', stats: [{ value: '1', label: 'l ✓' }] } });
  assert.ok(!/[△✓ℹ]/.test(h), 'no glyph left on the slide');
  const md = '# D\n\n## Items\n- **A:** one\n- **B:** two\nLayout: bullets\n\n## Mixed\n```js\nx\n```\n\n> takeaway\n\n## Chart\n```chart\nunit: ms\nA | 10\nB | 20 | ok\n```\n\n## Live: try it\nUrl: index.html\n```steps\nclick Save\nfill Name: Ann\nverify Saved\n```\nSay: Watch.\n';
  const { scenes } = m.outline(`---\nreveal: auto\n---\n${md}`);
  assert.deepEqual(scenes[1].slide.bullets, ['**A:** one', '**B:** two']);
  assert.equal(scenes[2].slide.reveal, true); // two blocks
  assert.deepEqual(scenes[3].slide.chart, { unit: 'ms', bars: [{ label: 'A', value: 10 }, { label: 'B', value: 20, tone: 'ok' }] });
  assert.deepEqual(scenes[4], { title: 'Live', narration: 'Watch.', url: 'index.html', steps: [{ click: 'Save' }, { fill: 'Name', text: 'Ann' }, { verify: { text: 'Saved' } }] });
  assert.throws(() => m.stepsOf('dance wildly'), /unknown action "dance"/);
  assert.match(m.slideHtml({ number: 1, title: 't', slide: { chart: scenes[3].slide.chart } }), /class="cbar ok"/);
});

test('voices: per scene in the tour and in markdown; short names resolve', async () => {
  const m = await import('../src/slides.mjs');
  assert.deepEqual(check('tour', { voice: 'Zira', rate: 1, scenes: [{ title: 'A', narration: 'n', voice: 'David', rate: -2, slide: {} }] }), []);
  assert.ok(check('tour', { rate: 20, scenes: [{ title: 'A', narration: 'n' }] }).length);
  const { scenes, meta } = m.outline('---\nvoice: Zira\nrate: 1\n---\n# D\n\n## One\nSay: hi.\n\n## Two\nSay: there.\nVoice: David\nRate: -2\n');
  assert.deepEqual(m.deckSettings(meta).voice, 'Zira');
  assert.equal(m.deckSettings(meta).rate, 1);
  assert.equal(scenes[1].voice, undefined);
  assert.deepEqual([scenes[2].voice, scenes[2].rate], ['David', -2]);
  const { listVoices, resolveVoice } = await import('../src/tts.mjs');
  assert.equal(await resolveVoice('anything', { provider: 'silent' }), 'anything'); // silent: no voice needed
  const voices = await listVoices();
  if (voices.length) {
    const v = voices[0];
    assert.equal(await resolveVoice(v.toLowerCase()), v);
    await assert.rejects(resolveVoice('no-such-voice-xyz'), /is installed \(installed: /);
  }
});
