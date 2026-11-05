// Platform notes: parsing, export/import, the run's snapshot, the triage bundle and the planner's input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { notesMarkdown, parseFindings, parseFrontmatter, readNotes, snapshotNotes } from '../src/notes.mjs';
import { exportTour, importTour } from '../src/exchange.mjs';
import { finalize } from '../src/triage.mjs';
import { planInput } from '../src/plan.mjs';
import { Failure } from '../src/failures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-notes-'));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };

const NOTES = `---
schema: aft-platform-notes/1
platform: src
apps: [A, B]
---

# App notes

## Accounts

| user | can |
|---|---|
| clerk | add |

## Findings

### APP-1 · Save button hides under the footer
- area: editor
- type: ux
- status: open
- evidence: scene 2; the click lands on the
  footer first.

### ENV-2: No seed data
- type: environment
`;

function platform(dir, name, notes = {}) {
  const p = path.join(dir, name);
  write(path.join(p, 'platform.json'), {});
  write(path.join(p, 'environments.json'), { default: 'local', local: { baseUrl: 'http://localhost:9/' } });
  for (const [f, text] of Object.entries(notes)) write(path.join(p, 'notes', f), text);
  return p;
}

describe('platform notes', () => {
  test('frontmatter and findings with ids; plain markdown is read leniently', () => {
    const { meta, body } = parseFrontmatter(NOTES);
    assert.equal(meta.schema, 'aft-platform-notes/1');
    assert.deepEqual(meta.apps, ['A', 'B']);
    const f = parseFindings(body);
    assert.deepEqual(f.map(x => x.id), ['APP-1', 'ENV-2']);
    assert.equal(f[0].title, 'Save button hides under the footer');
    assert.equal(f[0].area, 'editor');
    assert.equal(f[0].evidence, 'scene 2; the click lands on the footer first.');
    assert.equal(f[1].title, 'No seed data');
    assert.equal(f[1].type, 'environment');
    assert.deepEqual(parseFrontmatter('# just text\n').meta, {});
    assert.deepEqual(parseFindings('# just text\n## Accounts\n- user: x\n'), []);
  });

  test('readNotes: own files first, then imported/; a run snapshot holds them all', () => {
    const p = platform(tmp(), 'app', { 'b.md': NOTES, 'a.md': 'plain notes\n', 'imported/x/c.md': '### X-1 · y\n' });
    const notes = readNotes(p);
    assert.deepEqual(notes.map(n => n.file), ['a.md', 'b.md', 'imported/x/c.md']);
    const run = tmp();
    assert.ok(snapshotNotes(run, p, 'app'));
    const md = fs.readFileSync(path.join(run, 'notes.md'), 'utf8');
    assert.match(md, /3 file\(s\), 3 finding\(s\)/);
    assert.match(md, /APP-1 · Save button/);
    assert.equal(snapshotNotes(tmp(), platform(tmp(), 'none'), 'none'), null);
    assert.equal(notesMarkdown([]), null);
  });

  test('export carries the notes; import writes them under imported/<source>/, never over the target\'s, and lists new finding ids', () => {
    const dir = path.join(tmp(), 'platforms');
    platform(dir, 'src', { 'findings.md': NOTES, 'imported/other/z.md': '### Z-1 · not ours\n' });
    const target = platform(dir, 'dst', { 'findings.md': '# Ours\n\n### APP-1 · already known here\n' });
    const tour = path.join(dir, 'src', 'tours', 'ex.tour.json');
    write(tour, { name: 'ex', platform: 'src', scenes: [{ title: 't', narration: 'n', steps: [{ goto: '/' }] }] });
    const { doc } = exportTour(tour, { toolRoot: root, outRoot: tmp() });
    assert.deepEqual(doc.notes.map(n => n.file), ['findings.md']);
    assert.deepEqual(doc.notes[0].findings.map(f => f.id), ['APP-1', 'ENV-2']);
    const bundle = path.join(tmp(), 'ex.aft.json');
    write(bundle, doc);
    process.env.AFT_PLATFORMS = dir;
    try {
      const r = importTour(bundle, { toolRoot: root, platform: 'dst' });
      const out = path.join(target, 'notes', 'imported', 'src', 'findings.md');
      assert.deepEqual(r.notes.written, [out]);
      assert.equal(fs.readFileSync(out, 'utf8'), NOTES);
      assert.match(fs.readFileSync(path.join(target, 'notes', 'findings.md'), 'utf8'), /already known here/);
      assert.deepEqual(r.notes.newFindings.map(f => f.id), ['ENV-2']);
      // A second import keeps the earlier copy unless --force.
      fs.writeFileSync(out, 'edited\n');
      const again = importTour(bundle, { toolRoot: root, platform: 'dst', name: 'ex2' });
      assert.deepEqual(again.notes.kept, [out]);
      assert.equal(fs.readFileSync(out, 'utf8'), 'edited\n');
      importTour(bundle, { toolRoot: root, platform: 'dst', name: 'ex3', force: true });
      assert.equal(fs.readFileSync(out, 'utf8'), NOTES);
      // A notes path that climbs out is refused.
      write(bundle, { ...doc, notes: [{ file: '../../evil.md', text: 'x' }] });
      assert.throws(() => importTour(bundle, { toolRoot: root, platform: 'dst', name: 'ex4' }), /bad notes file name/);
    } finally { delete process.env.AFT_PLATFORMS; }
  });

  test('a failed run\'s triage bundle and PROMPT.md include notes.md', async () => {
    const run = tmp();
    write(path.join(run, 'notes.md'), NOTES);
    await finalize({ outDir: run, error: new Failure('script', 'SCRIPT failure: x'), def: { name: 't' } });
    assert.equal(fs.readFileSync(path.join(run, 'triage', 'notes.md'), 'utf8'), NOTES);
    const prompt = fs.readFileSync(path.join(run, 'triage', 'PROMPT.md'), 'utf8');
    assert.match(prompt, /## Platform notes/);
    assert.match(prompt, /APP-1 · Save button/);
    const bare = tmp();
    await finalize({ outDir: bare, error: new Failure('script', 'SCRIPT failure: x'), def: { name: 't' } });
    assert.doesNotMatch(fs.readFileSync(path.join(bare, 'triage', 'PROMPT.md'), 'utf8'), /Platform notes/);
  });

  test('the planner\'s input carries the notes only when there are some', () => {
    assert.equal(JSON.parse(planInput({})).platformNotes, undefined);
    const j = JSON.parse(planInput({ notes: [{ file: 'a.md', findings: ['APP-1'], text: 'x' }] }));
    assert.deepEqual(j.platformNotes[0].findings, ['APP-1']);
  });
});
