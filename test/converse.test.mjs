// Generate as a conversation (src/converse.mjs): a scripted agent and a fake stage for the loop; then the real CLI
// with a scripted agent (AFT_FAKE_AGENT) on the fixture app: stage, probes, questions, answers, --finish.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyAnswers, decideProposal, draftTour, finish, newConversation, parseAnswers, readConversation, saveConversation, startRecording, stopRecording, turn, writeDraft } from '../src/converse.mjs';
import { check } from '../src/schema.mjs';
import { startFixture } from './fixture/server.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const conversationSchema = (() => { const a = new Ajv2020({ strict: false }); a.addSchema(readJsonAt('schemas/common.schema.json')); return a.compile(readJsonAt('schemas/conversation.schema.json')); })();
function readJsonAt(rel) { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8')); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aft-conv-'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const story = { id: 'TODO-9', title: 'Save a name', text: 'Save a name. Acceptance criteria: 1. A name can be saved. 2. Saved names are shown.', acceptanceCriteria: ['A name can be saved', 'Saved names are shown'] };

/** A scripted agent: replies in order; records what it was sent. */
function agent(replies) {
  const sent = [];
  return { sent, ask: async ({ input, resume }) => { sent.push({ input: JSON.parse(input), resume }); return { output: replies[sent.length - 1] ?? { say: 'nothing more', done: true }, sessionId: 'sess-1' }; } };
}

/** A fake stage: try-step passes unless a step clicks "Missing"; records calls. */
function fakeStage() {
  const calls = [];
  return {
    calls, ended: null,
    alive: () => true, ensure: async () => ({ state: 'staged' }),
    async call(op, p) {
      calls.push([op, p]);
      if (op === 'snapshot') return { url: 'http://app/ok', title: 'OK', aria: '- heading "Fixture"\n- textbox "Name"\n- button "Save"', text: 'Fixture' };
      if (op === 'locate') return { resolved: true, strategy: { role: 'button', name: 'Save' }, matches: [{}], alternatives: [] };
      if (op === 'try-step') {
        const bad = JSON.stringify(p.step).includes('Missing');
        return { ok: !bad, class: bad ? 'script' : 'ok', ...(bad ? { error: 'Target not found: "Missing"' } : {}), steps: p.step.map((s, i) => ({ step: i + 1, action: Object.keys(s)[0], ok: !bad })), network: [], console: [], after: { url: 'http://app/ok', aria: '- button "Save"' } };
      }
      if (op === 'record-start') return { recording: true };
      if (op === 'record-stop') return { steps: [{ step: { fill: { label: 'Name' }, text: 'Ann' } }, { step: { click: { role: 'button', name: 'Save' } } }, { step: { click: { css: 'div > span' } }, weak: true }], notes: [], seconds: 6 };
      throw new Error(`fake stage: ${op}`);
    },
    async redo(point) { calls.push(['redo', point]); return { state: 'staged', reached: 'x' }; },
    async end(o) { this.ended = o; return { undo: { undone: 2 } }; },
  };
}

const save = { click: { role: 'button', name: 'Save' } };
const fill = { fill: { label: 'Name' }, text: 'Ann' };
const shown = { verify: { text: 'Saved Ann' } };

describe('conversation loop (scripted agent, fake stage)', () => {
  test('probes run, tried steps are kept, untried ones are marked, questions wait, answers resume, finish validates', async () => {
    const dir = tmp();
    const conv = Object.assign(newConversation({ story, platform: 'app', env: 'local', stageName: 'stage-conv-x' }), { name: 'TODO-9' });
    assert.equal(conv.scenes.length, 2);
    writeDraft(dir, conv);
    assert.deepEqual(check('tour', readJson(path.join(dir, 'tour.json'))), [], 'the first draft is a valid tour');
    const a = agent([
      { say: 'Looking at the page.', probes: [{ kind: 'snapshot', url: '/ok' }, { kind: 'tryStep', steps: [fill, save], scene: 1 }, { kind: 'tryStep', steps: [{ click: 'Missing' }] }] },
      { say: 'Scene 1 works. Which name should scene 2 show?', scenes: [
        { index: 1, title: 'Save a name', narration: 'AC1: we type a name and save it.', url: '/ok', steps: [fill, save, shown] },
        { index: 2, title: 'Names are shown', narration: 'AC2: the saved name is listed.', steps: [{ verify: { text: 'Ann' }, bogusKey: 1 }] }],
      questions: [{ type: 'free-text', text: 'Which name?', scene: 2 }, { type: 'confirm-destructive', text: 'May I delete the test name?', scene: 2, options: [{ value: 'yes' }, { value: 'no' }] }] },
      { say: 'Thanks.', probes: [{ kind: 'tryStep', steps: [{ click: 'Delete name' }], scene: 2 }] },
      { say: 'Done.', scenes: [{ index: 2, steps: [shown] }], done: true },
    ]);
    const stage = fakeStage();
    const deps = { ask: a.ask, stage, validate: null, log: () => {} };
    let r = await turn(dir, conv, { kind: 'start', story }, deps);
    assert.equal(r.state, 'waiting');
    assert.equal(r.questions.length, 2);
    assert.equal(a.sent.length, 2, 'one probe round, then the report');
    assert.equal(a.sent[1].input.kind, 'probe-results');
    assert.equal(a.sent[1].input.results[1].ok, true);
    assert.equal(a.sent[1].input.results[2].ok, false);
    assert.equal(a.sent[1].resume, 'sess-1', 'later rounds resume the Claude session');
    const tour = readJson(path.join(dir, 'tour.json'));
    assert.deepEqual(check('tour', tour), []);
    assert.match(tour.scenes[0].todo, /not tried yet: step 3/, 'the verify was never tried');
    assert.doesNotMatch(tour.scenes[0].todo, /step 1/, 'fill and save were tried');
    assert.match(tour.scenes[1].todo, /invalid step/, 'a step the schema refuses goes into the todo');
    assert.equal(tour.draft, true);

    assert.deepEqual(parseAnswers(['q1=Ann', 'q2=yes']), { q1: 'Ann', q2: 'yes' });
    assert.throws(() => parseAnswers('Ann'), /q<N>=/);
    applyAnswers(conv, { q1: 'Ann', q2: 'yes' });
    assert.deepEqual(conv.allowDestructive, [2]);
    assert.throws(() => applyAnswers(conv, { q1: 'again' }), /already answered/);
    r = await turn(dir, conv, { kind: 'message', answers: { q1: 'Ann', q2: 'yes' } }, deps);
    assert.equal(a.sent[2].input.answers.q1, 'Ann');
    assert.equal(a.sent[3].input.results[0].refused, undefined, 'a confirmed destructive step runs');
    assert.equal(r.state, 'done');

    // finish: validate fails for scene 2 → a turn about it, still not finished
    const a2 = agent([{ say: 'Fixing scene 2.', scenes: [{ index: 2, steps: [{ verify: { text: 'Saved Ann' } }] }] }]);
    let validations = 0;
    deps.ask = a2.ask;
    deps.validate = async () => (++validations === 1
      ? { blocking: 1, runDir: 'v1', report: [{ scene: 'scene-01', step: 1, ok: true }, { scene: 'scene-02', step: 1, ok: false, error: 'not visible' }] }
      : { blocking: 0, runDir: 'v2', report: [{ scene: 'scene-01', step: 1, ok: true }, { scene: 'scene-02', step: 1, ok: true }] });
    r = await finish(dir, conv, deps);
    assert.equal(r.finished, undefined);
    assert.equal(r.validation.failures.length, 1);
    assert.equal(a2.sent[0].input.kind, 'validation');
    assert.equal(conv.scenes[0].state, 'verified');
    r = await finish(dir, conv, deps);
    assert.equal(r.finished, true);
    assert.deepEqual(stage.ended, { keep: false }, 'finishing ends the stage, undoing its data');
    const final = readJson(path.join(dir, 'tour.json'));
    assert.deepEqual(check('tour', final), []);
    assert.equal(final.draft, undefined);
    assert.ok(final.$schema, '$schema first');
    assert.equal(Object.keys(final)[0], '$schema');
    assert.ok(final.scenes.every(s => !s.todo));
    assert.equal(readConversation(dir).state, 'done');
    assert.ok(conversationSchema(readConversation(dir)), JSON.stringify(conversationSchema.errors));
  });

  test('a destructive step is refused until confirmed; the probe budget makes it report', async () => {
    const dir = tmp();
    const conv = Object.assign(newConversation({ story, platform: 'app', stageName: 's', limit: 3, perTurn: 3 }), { name: 'b' });
    const a = agent([
      { say: 'try', probes: [{ kind: 'tryStep', steps: [{ click: 'Delete all' }] }, { kind: 'snapshot' }] },
      { say: 'more', probes: [{ kind: 'snapshot' }, { kind: 'snapshot' }, { kind: 'snapshot' }] },
      { say: 'still more', probes: [{ kind: 'snapshot' }] },
    ]);
    const stage = fakeStage();
    const r = await turn(dir, conv, { kind: 'start' }, { ask: a.ask, stage, log: () => {} });
    assert.equal(a.sent[1].input.results[0].refused, true);
    assert.ok(!stage.calls.some(([op, p]) => op === 'try-step' && JSON.stringify(p).includes('Delete')));
    assert.equal(conv.budget.probes, 3, 'never more than the budget');
    assert.match(a.sent[2].input.note, /budget/);
    assert.equal(r.state, 'waiting');
  });

  test('recording: stage before the scene, steps into the scene, the agent narrates; proposals need accepting', async () => {
    const dir = tmp();
    const conv = Object.assign(newConversation({ story, platform: 'app', stageName: 's' }), { name: 'r' });
    conv.scenes[1].url = '/ok';
    const a = agent([{ say: 'Narrated.', scenes: [{ index: 2, narration: 'AC2: we save Ann and see it.' }], proposals: [{ kind: 'decision', decision: { finding: 'weak|AC2', decision: 'accept', note: 'fine' }, why: 'only a text check' }] }]);
    const stage = fakeStage();
    const deps = { ask: a.ask, stage, log: () => {} };
    let r = await startRecording(dir, conv, { scene: 2 }, deps);
    assert.equal(r.state, 'recording');
    assert.deepEqual(stage.calls.find(c => c[0] === 'redo')[1], { untilScene: 1 });
    assert.deepEqual(stage.calls.find(c => c[0] === 'try-step')[1].step, [{ goto: '/ok' }], 'the scene\'s url is opened before recording');
    r = await stopRecording(dir, conv, deps);
    assert.equal(conv.scenes[1].steps.length, 3);
    assert.equal(conv.scenes[1].state, 'recorded');
    assert.equal(a.sent[0].input.kind, 'recorded');
    assert.ok(a.sent[0].input.narrationWords >= 8);
    assert.match(conv.scenes[1].todo, /check recorded step 3/);
    const tour = draftTour(conv, {});
    assert.match(tour.scenes[1].todo, /not tried yet: step 3/, 'a weak recorded step isn\'t counted as tried');
    assert.doesNotMatch(tour.scenes[1].todo, /step 1 /);
    assert.equal(r.proposals.length, 1);
    assert.equal(draftTour(conv, {}).review, undefined, 'never applied silently');
    decideProposal(conv, 'p1', true);
    assert.equal(draftTour(conv, {}).review.decisions[0].finding, 'weak|AC2');
    assert.throws(() => decideProposal(conv, 'p1', false), /already accepted/);
    saveConversation(dir, conv);
  });

  test('a lost Claude session falls back to the compacted conversation', async () => {
    const dir = tmp();
    const conv = Object.assign(newConversation({ story, platform: 'app', stageName: 's' }), { name: 'f', claudeSessionId: 'gone' });
    conv.turns.push({ who: 'agent', text: 'earlier' });
    const sent = [];
    const ask = async ({ input, resume }) => { sent.push({ input: JSON.parse(input), resume }); if (resume) throw new Error('No conversation found'); return { output: { say: 'ok' }, sessionId: 'new' }; };
    await turn(dir, conv, { kind: 'message', say: 'hi' }, { ask, stage: fakeStage(), log: () => {} });
    assert.equal(sent.length, 2);
    assert.ok(sent[1].input.history.length >= 1);
    assert.equal(conv.claudeSessionId, 'new');
  });
});

// ---- The real CLI, a scripted agent, the fixture app ---------------------------------------------------------------

let app;
before(async () => { app = await startFixture(); });
after(() => app?.close());

function cli(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args, '--json'], { cwd: root, env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => { let doc = null; try { doc = JSON.parse(out); } catch { /* below */ } resolve({ code, doc, err }); });
  });
}

describe('aft generate --converse / aft converse (fixture app)', { timeout: 300000 }, () => {
  test('start, probe on the stage, answer, finish: a valid tour, the stage ended', async () => {
    const base = tmp();
    const p = path.join(base, 'platforms', 'app');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'platform.json'), JSON.stringify({ timeouts: { action: 5000, verify: 5000, navigation: 30000, optional: 1000 }, retries: 0, ignore: ['favicon'] }));
    fs.writeFileSync(path.join(p, 'environments.json'), JSON.stringify({ default: 'local', local: { baseUrl: app.url + '/' } }));
    const storyFile = path.join(base, 'story.md');
    fs.writeFileSync(storyFile, 'APP-7 "Save a name"\nAcceptance criteria:\n1. A saved name is confirmed.\n');
    const replies = path.join(base, 'replies.json');
    fs.writeFileSync(replies, JSON.stringify([
      { say: 'Trying it.', probes: [{ kind: 'tryStep', url: '/ok', steps: [{ fill: 'Name', text: 'Ann' }, { click: { role: 'button', name: 'Save' } }, { verify: { text: 'Saved Ann' } }], scene: 1 }] },
      { say: 'It works. Is the confirmation enough?', scenes: [{ index: 1, title: 'Save a name', narration: 'AC1: we type a name, save, and see the confirmation.', url: '/ok',
        steps: [{ fill: 'Name', text: 'Ann' }, { click: { role: 'button', name: 'Save' } }, { verify: { text: 'Saved Ann' } }] }],
      questions: [{ type: 'criterion-ambiguous', text: 'Is "Saved Ann" the confirmation?', options: [{ value: 'yes' }, { value: 'no' }] }] },
      { say: 'Good, nothing else to do.', done: true },
    ]));
    const env = { AFT_OUT_DIR: path.join(base, 'out'), AFT_FAKE_AGENT: replies, AFT_PLATFORMS: path.join(base, 'platforms') };
    const started = await cli(['generate', '--story', storyFile, '--platform', 'app', '--converse', '--headless', '--no-discover'], env);
    assert.equal(started.code, 0, started.err.slice(-3000));
    const d = started.doc.data;
    assert.equal(d.state, 'waiting');
    assert.equal(d.questions[0].id, 'q1');
    assert.equal(d.scenes[0].untried, 0, 'every step was tried on the stage');
    const run = started.doc.runDir;
    const answered = await cli(['converse', run, '--answer', 'q1=yes'], env);
    assert.equal(answered.code, 0, answered.err.slice(-3000));
    assert.equal(answered.doc.data.state, 'done');
    const finished = await cli(['converse', run, '--finish'], env);
    assert.equal(finished.code, 0, finished.err.slice(-3000));
    assert.equal(finished.doc.data.finished, true);
    const tour = readJson(path.join(run, 'tour.json'));
    assert.deepEqual(check('tour', tour), []);
    assert.equal(tour.draft, undefined);
    assert.equal(tour.scenes[0].steps.length, 3);
    const list = await cli(['stage', 'list'], env);
    assert.ok(!list.doc.data.stages.some(s => s.name.startsWith('stage-conv-') && s.alive), 'the stage ended');
  });
});
