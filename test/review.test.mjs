// Review: evidence strength per criterion, findings, decisions and the verdict (src/review.mjs); and story workarounds.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evidence, findings, review, verdict } from '../src/review.mjs';
import { startFixture } from './fixture/server.mjs';

const check = (spec, extra = {}) => ({ scene: 'scene-01', step: 1, action: 'verify', kind: 'check', spec, ok: true, criteria: ['1'], ...extra });
const raw = (extra = {}) => ({ story: { acceptanceCriteria: ['It works'] }, scenes: [{ title: 'A', narration: 'a', criteria: [1], steps: [] }], ...extra });
const crit = [{ id: '1', text: 'It works', status: 'met' }];
const strength = (steps, extra = {}) => evidence({ raw: raw(), steps, criteria: crit, ...extra })[0];

describe('evidence strength', () => {
  test('a specific condition on a named target is strong', () => {
    assert.equal(strength([check({ verify: { role: 'status' }, text: '2 items left' })]).strength, 'strong');
    assert.equal(strength([check({ verify: { text: '2 items left' } })]).strength, 'strong');
    assert.equal(strength([check({ verify: { url: '/done' } })]).strength, 'strong');
    assert.equal(strength([check({ verify: { role: 'checkbox', name: 'Done' }, state: 'checked' })]).strength, 'strong');
  });
  test('visible only, CSS targets and ambiguous matches are moderate, with the reason', () => {
    const v = strength([check({ verify: { role: 'button', name: 'Save' } })]);
    assert.equal(v.strength, 'moderate'); assert.match(v.reasons.join(), /only checks that something is visible/);
    assert.match(strength([check({ verify: { css: '.total' }, text: '3' })]).reasons.join(), /CSS/);
    const amb = strength([check({ verify: { text: 'Reports (3)' } }, { warnings: ['ambiguous target {"text":"Reports (3)"}: 2 matches, used the first visible one'] })]);
    assert.equal(amb.strength, 'moderate'); assert.match(amb.reasons.join(), /more than one element/);
  });
  test('only absent checks, or only optional ones, are weak; no check is none', () => {
    const w = strength([check({ verify: { css: '.refresh' }, state: 'hidden' })]);
    assert.equal(w.strength, 'weak'); assert.match(w.reasons.join(), /never showed it/);
    assert.equal(strength([check({ verify: { text: 'Saved' } }, { optional: true })]).strength, 'weak');
    assert.equal(strength([]).strength, 'none');
  });
  test('a mock or a hidden known issue caps it at weak; another known issue at moderate', () => {
    const strong = [check({ verify: { text: 'Saved' } })];
    assert.equal(strength(strong, { mockScenes: new Set(['*']) }).strength, 'weak');
    assert.equal(strength(strong, { firings: [{ name: 'X', scene: 'scene-01', action: 'hide' }] }).strength, 'weak');
    assert.equal(strength(strong, { firings: [{ name: 'X', scene: 'scene-01', action: 'tolerate' }] }).strength, 'moderate');
    assert.equal(strength(strong, { firings: [{ name: 'X', scene: 'scene-02', action: 'hide' }] }).strength, 'strong');
  });
  test('a failed check is "failed"', () => {
    assert.equal(strength([check({ verify: { text: 'Saved' } }, { ok: false })]).strength, 'failed');
  });
});

describe('findings, decisions and the verdict', () => {
  const failing = { scene: 'scene-01', step: 2, action: 'click', kind: 'action', spec: { click: 'Svae' }, ok: false, error: 'Target not found', suggestions: ['Save'] };
  test('a failure has a stable id that a decision attaches to', () => {
    const [f] = findings({ raw: raw(), steps: [failing] });
    assert.equal(f.id, 'fail|scene-01|click|"Svae"'); assert.equal(f.class, 'script'); assert.deepEqual(f.suggestions, ['Save']);
    const r = review({ raw: raw({ review: { decisions: [{ finding: f.id, decision: 'app-issue', note: 'Save button was removed' }] } }), steps: [failing], criteria: crit, passed: false });
    assert.equal(r.findings[0].decision.decision, 'app-issue');
    assert.equal(r.verdict, 'failed-app-issue');
    assert.equal(review({ raw: raw(), steps: [failing], criteria: crit, passed: false }).verdict, 'failed');
  });
  test('weak evidence and platform known issues need review until decided', () => {
    const steps = [check({ verify: { css: '.x' }, state: 'hidden' })];
    const firings = [{ name: 'TCM popup', source: 'platform', as: 'warn', action: 'dismissed', scene: 'scene-01' }];
    const open = review({ raw: raw(), steps, criteria: crit, firings, passed: true });
    assert.equal(open.verdict, 'needs-review');
    assert.deepEqual(open.findings.map(f => f.id), ['evidence|1|weak', 'known|TCM popup']);
    const decided = review({ raw: raw({ review: { decisions: [{ finding: 'evidence|1|weak', decision: 'accept' }, { finding: 'known|TCM popup', decision: 'accept' }] } }), steps, criteria: crit, firings, passed: true });
    assert.equal(decided.verdict, 'passed'); assert.equal(decided.open, 0);
  });
  test('a story workaround for an app issue: passed with known issues; when it stops firing, "may be fixed"', () => {
    const w = { name: 'Totals off by one', when: { css: '.total' }, do: 'tolerate', issue: { note: 'count is wrong', ticket: 'APP-7' } };
    const steps = [check({ verify: { text: 'Saved' } })];
    const fired = review({ raw: raw({ workarounds: [w] }), steps, criteria: crit, firings: [{ name: w.name, source: 'story', action: 'tolerate', scene: 'scene-01' }], passed: true });
    assert.equal(fired.verdict, 'passed-with-issues');
    assert.equal(fired.findings.find(f => f.kind === 'known-issue').decision.ticket, 'APP-7');
    const gone = review({ raw: raw({ workarounds: [w] }), steps, criteria: crit, firings: [], passed: true });
    assert.ok(gone.findings.some(f => f.id === 'gone|Totals off by one'));
    assert.equal(gone.verdict, 'needs-review');
  });
  test('a check marked knownIssue: failing is "passed with known issues"; passing says the issue may be fixed', () => {
    const k = { note: 'count missing', ticket: 'APP-3' };
    const bad = check({ verify: { text: 'IBR (0)' } }, { ok: false, knownIssue: k, error: 'not on the page' });
    const r = review({ raw: raw(), steps: [bad], criteria: [{ id: '1', text: 'It works', status: 'known issue' }], passed: true });
    assert.equal(r.verdict, 'passed-with-issues');
    assert.equal(r.findings[0].kind, 'known-issue'); assert.equal(r.findings[0].decision.ticket, 'APP-3');
    assert.match(r.evidence[0].reasons[0], /known app issue \(APP-3\)/);
    const good = review({ raw: raw(), steps: [{ ...bad, ok: true }], criteria: crit, passed: true });
    assert.equal(good.findings[0].kind, 'issue-gone'); assert.equal(good.verdict, 'needs-review');
  });
  test('verdict precedence', () => {
    assert.equal(verdict({ passed: true, findings: [] }), 'passed');
    assert.equal(verdict({ passed: true, findings: [{ kind: 'mock', decision: { decision: 'workaround' } }] }), 'passed-with-issues');
  });
});

// ---- end to end: a platform tour with its own workaround (formerly refused) ----
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.mjs');
let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

function runCli(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [cli, ...args], { windowsHide: true, cwd: root, env: { ...process.env, AFT_OUT_DIR: path.join(os.tmpdir(), 'aft-test-out'), ...env } });
    let out = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code, out }));
  });
}

describe('story workarounds', { timeout: 300000 }, () => {
  test('a platform tour may declare its own workaround; marked as an issue it reads "passed with known issues"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-review-'));
    const pdir = path.join(dir, 'platforms', 'fx');
    fs.mkdirSync(path.join(pdir, 'tours'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'platform.json'), JSON.stringify({ errors: { selector: '.error-panel, [role=dialog]', text: 'error|unavailable' } }));
    fs.writeFileSync(path.join(pdir, 'environments.json'), JSON.stringify({ default: 'local', local: { baseUrl: app.url, timeouts: { action: 3000, verify: 3000, navigation: 5000 } } }));
    const file = path.join(pdir, 'tours', 'story.tour.json');
    fs.writeFileSync(file, JSON.stringify({
      name: 'story-wa', platform: 'fx', retries: 0, story: { id: 'S-1', acceptanceCriteria: ['Saving works'] },
      workarounds: [{ name: 'TCM popup', when: { role: 'dialog', hasText: 'TCM' }, do: [{ click: { role: 'button', name: 'Ok' } }], issue: { note: 'TCM down', ticket: 'APP-9' } }],
      scenes: [{ title: 'Save', narration: 'We save.', url: '/known?popup=1', criteria: [1], steps: [{ wait: 0.6 }, { click: 'Save' }, { verify: { text: 'Saved' } }] }],
    }));
    const out = path.join(dir, 'run');
    const r = await runCli(['run', file, '--speech', 'silent', '--out', out], { AFT_PLATFORMS: path.join(dir, 'platforms') });
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.ok(report.workarounds.some(w => w.name === 'TCM popup' && w.source === 'story'), JSON.stringify(report.workarounds));
    assert.equal(report.review.verdict, 'passed-with-issues');
    assert.equal(report.review.evidence[0].strength, 'moderate');   // strong check, but a known issue fired in its scene
    assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /PASSED WITH KNOWN ISSUES/);
  });

  test('a failing check marked knownIssue does not stop the run; the criterion reads "known issue"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-xfail-'));
    const file = path.join(dir, 'tour.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'xfail', baseUrl: app.url, retries: 0, timeouts: { verify: 1500, action: 3000, navigation: 5000 }, story: { acceptanceCriteria: ['A', 'B'] },
      scenes: [{ title: 'A', narration: 'a', url: '/known', criteria: [1], steps: [{ verify: { text: 'No such text anywhere' }, knownIssue: { ticket: 'APP-1' } }] },
        { title: 'B', narration: 'b', criteria: [2], steps: [{ click: 'Save' }, { verify: { text: 'Saved' } }] }] }));
    const out = path.join(dir, 'run');
    const r = await runCli(['run', file, '--speech', 'silent', '--out', out], {});
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(report.criteria.map(c => c.status), ['known issue', 'met']);
    assert.equal(report.review.verdict, 'passed-with-issues');
  });
});
