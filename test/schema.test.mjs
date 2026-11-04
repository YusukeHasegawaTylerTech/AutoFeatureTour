// The published schemas: generated from src/schema-defs.mjs, every definition file in the repo matches its schema,
// and problems come back as one precise line per path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCHEMAS } from '../src/schema-defs.mjs';
import { check } from '../src/schema.mjs';
import { initPlatform } from '../src/platform.mjs';
import { plan } from '../src/plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const typeOf = f => {
  const b = path.basename(f), d = path.basename(path.dirname(f));
  if (b.endsWith('.tour.json')) return 'tour';
  if (['platform.json', 'environments.json', 'login.json'].includes(b)) return b.replace('.json', '');
  if (d === 'fragments' && b.endsWith('.json')) return 'fragment';
  if (d === 'fixtures' && b.endsWith('.json')) return 'fixture';
  return null;
};

test('schemas/*.schema.json are up to date with src/schema-defs.mjs (node src/schema-defs.mjs --write)', () => {
  for (const [k, v] of Object.entries(SCHEMAS)) {
    const file = path.join(root, 'schemas', `${k}.schema.json`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(v)), `${file} is stale`);
    if (k !== 'common') assert.match(v.$id, /\/v1\/[a-z]+\.schema\.json$/);
  }
});

// platforms/ is local and git-ignored: check a freshly scaffolded platform, plus whatever this machine has.
test('scaffolded and local definition files match their schemas and name them in "$schema"', () => {
  const scaffold = initPlatform(fs.mkdtempSync(path.join(os.tmpdir(), 'aft-scaffold-')), 'demo');
  const local = path.join(root, 'platforms');
  const files = [...walk(scaffold), ...(fs.existsSync(local) ? walk(local) : [])].filter(typeOf);
  assert.ok(files.length >= 4);
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(check(typeOf(f), doc), [], f);
    assert.ok(doc.$schema, `${f} has no $schema`);
    assert.ok(fs.existsSync(path.resolve(path.dirname(f), doc.$schema)), `${f}: $schema ${doc.$schema} doesn't resolve`);
  }
});

test('problems are reported per path, once', () => {
  const p = check('tour', { scenes: [{ title: 't', narration: 'n', steps: [
    { click: { nmae: 'Save' } }, { fill: 'Name', txet: 'x' }, { clik: 'Save' }, { click: 5 }, { click: 'A', fill: 'B', text: 'x' },
    { click: { role: 'button', within: { label: 'x', css: '.y' } } }, { at: 2 }, { wait: 'soon' },
  ] }], onError: 'never' });
  const want = [
    /^scenes\[0\]\.steps\[0\]\.click: a locator object needs exactly one of/,
    /^scenes\[0\]\.steps\[0\]\.click: unknown key "nmae"/,
    /^scenes\[0\]\.steps\[1\]: missing "text"$/,
    /^scenes\[0\]\.steps\[1\]: unknown key "txet"$/,
    /^scenes\[0\]\.steps\[2\]: no action; expected one of goto, click/,
    /^scenes\[0\]\.steps\[3\]\.click: expected a locator/,
    /^scenes\[0\]\.steps\[4\]: more than one action \(click, fill\)/,
    /^scenes\[0\]\.steps\[5\]\.click\.within: .*\(has label and css\)/,
    /^scenes\[0\]\.steps\[6\]\.at: must be <= 1$/,
    /^scenes\[0\]\.steps\[7\]\.wait: expected a number/,
    /^onError: expected one of "fail", "skip"$/,
  ];
  for (const re of want) assert.ok(p.some(x => re.test(x)), `no problem matching ${re}:\n${p.join('\n')}`);
  assert.equal(p.length, want.length, p.join('\n'));
});

test('a generated tour.json names its schema', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-gen-'));
  const tour = await plan({ discovery: null, outDir: out, name: 'x', story: { id: 'X-1', title: 't', acceptanceCriteria: ['a'] } });
  const doc = JSON.parse(fs.readFileSync(path.join(out, 'tour.json'), 'utf8'));
  assert.equal(Object.keys(doc)[0], '$schema');
  assert.ok(fs.existsSync(path.resolve(out, doc.$schema)));
  assert.deepEqual(check('tour', doc), []);
  assert.equal(tour.$schema, doc.$schema);
});
