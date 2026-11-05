// Review: what a person should look at in a run, and the decisions they made about it, per story.
//
// Deterministic (no LLM). From the steps a run or a dry run reported, the known issues that fired and the mocks that
// answered, it works out:
//   evidence   per acceptance criterion, how easily its checks could pass while the app is wrong:
//              strong | moderate | weak | none (or failed), each with the reasons
//   findings   failures, weak or missing evidence, known issues that fired, mocks, story workarounds for an app issue
//              that no longer fire; each has a stable id (a fingerprint), so a decision about it carries over runs
//   verdict    passed | passed-with-issues | needs-review | failed | failed-app-issue
//
// Decisions live in the tour, "review": { "decisions": [ { "finding": "<id>", "decision": "script" | "workaround" |
// "app-issue" | "accept", "note", "ticket", "at" } ] }. They never change how a run executes; they change how its
// result is read: an accepted weak check stops asking for review, a failure marked as an app issue is reported as one,
// and a story workaround for an app issue ("issue": { … }) makes a passing run "passed with known issues", never plain
// green.

const POSITIVE_STATES = new Set(['visible', 'enabled', 'disabled', 'checked', 'unchecked', 'selected', 'unselected', 'editable', 'focused']);
const NEGATIVE_STATES = new Set(['hidden', 'detached']);
const NAMED = ['role', 'label', 'placeholder', 'text', 'testId', 'alt'];
const OPTS = new Set(['criterion', 'optional', 'timeout', 'retries', 'comment', 'from', 'waitForResponse', 'status', 'method', 'state', 'text', 'exactText', 'value', 'count']);

export const DECISIONS = ['script', 'workaround', 'app-issue', 'accept'];
export const VERDICTS = {
  'passed': 'PASSED',
  'passed-with-issues': 'PASSED WITH KNOWN ISSUES',
  'needs-review': 'PASSED, NEEDS REVIEW',
  'failed': 'FAILED',
  'failed-app-issue': 'FAILED: APP ISSUE',
};

const sceneId = s => String(s ?? '').replace(/\s.*$/, '');
const actionOf = spec => (spec && typeof spec === 'object' ? Object.keys(spec).find(k => !OPTS.has(k)) : null) ?? null;
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x));

/** How a check's target is found: by visible name (role, label, text…), by CSS, or a plain string (tried as a name). */
function targetKind(t) {
  if (typeof t === 'string') return /^(#|\.|\[|css=)/.test(t) ? 'css' : 'named';
  if (!t || typeof t !== 'object') return 'other';
  if (t.url !== undefined || t.title !== undefined) return 'page';
  if (NAMED.some(k => k in t)) return 'named';
  return 'css' in t ? 'css' : 'other';
}

/** One check: what it asserts. { positive, specific, kind, ambiguous, label } */
function describeCheck(s) {
  const spec = s.spec ?? {};
  if (s.action === 'code') return { positive: true, specific: true, kind: 'code', ambiguous: false, label: 'a code check' };
  const target = spec.verify;
  const kind = targetKind(target);
  const state = spec.state;
  const negative = NEGATIVE_STATES.has(state) || spec.count === 0 || spec.count === '0';
  // Found by its text ({ "text": "2 items left" }): being visible is the assertion about what the page says.
  const byText = target && typeof target === 'object' && 'text' in target && !target.within && !target.has;
  const specific = kind === 'page' || (byText && !negative) || ['text', 'exactText', 'value'].some(k => k in spec) || ('count' in spec && !negative) || (state && POSITIVE_STATES.has(state) && state !== 'visible');
  const ambiguous = (s.warnings ?? []).some(w => /ambiguous target/.test(w));
  const name = typeof target === 'string' ? target : target && typeof target === 'object' ? (target.name ?? target.text ?? target.label ?? target.css ?? target.url ?? target.title ?? JSON.stringify(target)) : '';
  return { positive: !negative, specific: !!specific, kind, ambiguous, label: `${negative ? `"${String(name).slice(0, 60)}" ${state ?? 'count 0'}` : `"${String(name).slice(0, 60)}"`}` };
}

/** Scene ids (scene-NN) of the scenes that list a criterion, and of the steps that name it. */
function scenesFor(id, raw, steps) {
  const out = new Set();
  (raw?.scenes ?? []).forEach((s, i) => { if ([s.criteria ?? []].flat().map(String).includes(id)) out.add(`scene-${String(i + 1).padStart(2, '0')}`); });
  for (const s of steps) if ((s.criteria ?? []).includes(id)) out.add(sceneId(s.scene));
  return out;
}

/**
 * Evidence per criterion. criteria: [{ id, text, status }] as the report has them (status NOT MET → "failed").
 * firings: known issues that fired; mockScenes: scene ids answered by a mock ("*" for all).
 */
export function evidence({ raw, steps, criteria, firings = [], mockScenes = new Set() }) {
  return criteria.filter(c => c.id !== 'setup').map(c => {
    const id = String(c.id);
    const checks = steps.filter(s => (s.kind === 'check' || s.action === 'code') && (s.criteria ?? []).includes(id));
    const required = checks.filter(s => !s.optional);
    const reasons = [];
    const known = required.filter(s => s.ok === false && s.knownIssue);
    if (c.status === 'NOT MET' || required.some(s => s.ok === false && !s.knownIssue)) return { id, text: c.text ?? '', strength: 'failed', reasons: ['a check for it failed'] };
    if (known.length) return { id, text: c.text ?? '', strength: 'failed', reasons: [`fails as a known app issue${known[0].knownIssue.ticket ? ` (${known[0].knownIssue.ticket})` : ''}${known[0].knownIssue.note ? `: ${known[0].knownIssue.note}` : ''}`] };
    if (!checks.length) {
      const planned = c.status === 'not run';
      return { id, text: c.text ?? '', strength: 'none', reasons: [planned ? 'its checks did not run' : 'shown, not checked: no "verify" for it'] };
    }
    if (!required.length) return { id, text: c.text ?? '', strength: 'weak', reasons: ['its only checks are optional (they may fail without failing the run)'] };

    const d = required.filter(s => s.ok).map(s => ({ s, ...describeCheck(s) }));
    const strong = d.filter(x => x.positive && x.specific && (x.kind === 'named' || x.kind === 'page' || x.kind === 'code') && !x.ambiguous);
    let strength;
    if (strong.length) { strength = 'strong'; reasons.push(`${strong[0].label} checked ${strong[0].kind === 'page' ? 'on the page' : strong[0].kind === 'code' ? 'by code' : 'by its name'} for a specific condition`); }
    else if (d.some(x => x.positive)) {
      strength = 'moderate';
      const p = d.filter(x => x.positive);
      if (p.every(x => !x.specific)) reasons.push(`only checks that something is visible (${p.slice(0, 2).map(x => x.label).join(', ')}), not what it says or its state`);
      if (p.some(x => x.kind === 'css')) reasons.push('found by CSS, not by a name a user sees');
      if (p.some(x => x.ambiguous)) reasons.push(`${p.find(x => x.ambiguous).label} matched more than one element; the first was used`);
    } else {
      strength = 'weak';
      reasons.push(`only checks that something is absent (${d.slice(0, 2).map(x => x.label).join(', ')}): these also pass if the page never showed it`);
    }
    // What the run did around it caps the strength: simulated data or a hidden element can't prove the app works.
    const scenes = scenesFor(id, raw, steps);
    if (mockScenes.has('*') || [...scenes].some(s => mockScenes.has(s))) { strength = 'weak'; reasons.push('a mock answered (simulated data)'); }
    const fired = firings.filter(f => scenes.has(f.scene));
    if (fired.some(f => f.action === 'hide')) { strength = 'weak'; reasons.push(`known issue "${fired.find(f => f.action === 'hide').name}" was hidden on screen`); }
    else if (fired.length) {
      if (strength === 'strong') strength = 'moderate';
      reasons.push(`known issue${fired.length > 1 ? 's' : ''} ${[...new Set(fired.map(f => `"${f.name}"`))].join(', ')} fired in its scene`);
    }
    return { id, text: c.text ?? '', strength, reasons };
  });
}

const failureClass = s => s.failure ?? (s.kind === 'check' ? 'criterion' : 'script');
const CLASS_WORDS = { script: 'a step could not be done', criterion: 'a check failed', app: 'the app showed an error', unreachable: 'the app did not answer', login: 'sign-in failed', tooling: 'a local tool failed', error: 'an error' };

/** Story workarounds marked as an app issue ("issue"): their rule names. */
const issueRules = raw => (raw?.workarounds ?? []).filter(r => r.issue && !r.off);

/**
 * Everything a person should decide about, with its decision if the tour has one.
 * steps: the run's step entries; firings: known issues that fired; mocks: [{ pattern }]; passed/complete: the outcome.
 */
export function findings({ raw, steps, firings = [], mocks = [], evidence: ev = [], passed, complete = true }) {
  const out = [];
  const add = f => { if (!out.some(x => x.id === f.id)) out.push(f); };
  for (const s of steps) {
    const a = s.action ?? actionOf(s.spec);
    const target = s.spec ? s.spec[a] : s.error;
    const where = `${sceneId(s.scene)} step ${s.scriptStep ?? s.step}`;
    // A step marked as a known app issue: failing is expected (amber); passing means the issue may be fixed.
    if (s.knownIssue) {
      const k = s.knownIssue, about = [k.note, k.ticket].filter(Boolean).join(' · ');
      if (s.ok === false) add({ id: `xfail|${sceneId(s.scene)}|${a}|${stable(target)}`, kind: 'known-issue', scene: sceneId(s.scene), step: s.step, scriptStep: s.scriptStep ?? s.step,
        title: `${where}: fails as a known app issue`, detail: [about, s.error].filter(Boolean).join(': '), decision: { decision: 'workaround', note: k.note ?? '', ticket: k.ticket ?? '', implied: true } });
      else if (s.ok) add({ id: `xpass|${sceneId(s.scene)}|${a}|${stable(target)}`, kind: 'issue-gone', scene: sceneId(s.scene), step: s.step, scriptStep: s.scriptStep ?? s.step,
        title: `${where}: the known app issue did not happen: it may be fixed`, detail: `${about ? `${about}. ` : ''}Remove "knownIssue" from the step if so.` });
      continue;
    }
    if (s.ok !== false || s.optional) continue;
    add({ id: `fail|${sceneId(s.scene)}|${a}|${stable(target)}`, kind: 'failure', class: failureClass(s), scene: sceneId(s.scene), step: s.step, scriptStep: s.scriptStep ?? s.step,
      title: `${sceneId(s.scene)} step ${s.scriptStep ?? s.step}${s.from ? ` (in ${s.from})` : ''}: ${CLASS_WORDS[failureClass(s)] ?? 'it failed'}`, detail: s.error ?? '', suggestions: s.suggestions ?? [],
      spec: s.spec ?? null, from: s.from ?? null, criteria: s.criteria ?? [] });
  }
  for (const e of ev) if (e.strength === 'weak' || e.strength === 'none')
    add({ id: `evidence|${e.id}|${e.strength}`, kind: 'evidence', criteria: [e.id], title: `AC${e.id}: ${e.strength === 'none' ? 'not checked' : 'weak evidence'}`, detail: e.reasons.join('; ') });
  const issues = new Map(issueRules(raw).map(r => [r.name, r]));
  for (const f of firings) {
    if (issues.has(f.name)) {
      const r = issues.get(f.name);
      add({ id: `issue|${f.name}`, kind: 'known-issue', scene: f.scene, title: `known app issue "${f.name}" worked around`, detail: [r.issue.note, r.issue.ticket].filter(Boolean).join(' · ') || f.matched,
        decision: { decision: 'workaround', note: r.issue.note ?? '', ticket: r.issue.ticket ?? '', implied: true } });
    } else if (f.as !== 'silent' && f.as !== 'fail') {
      add({ id: `known|${f.name}`, kind: 'workaround', scene: f.scene, title: `known issue "${f.name}" (${f.source}) ${f.action === 'hide' ? 'was hidden' : f.action === 'tolerate' ? 'was left on screen' : 'was dismissed'}`, detail: f.matched });
    }
  }
  for (const m of mocks) add({ id: `mock|${m.pattern}`, kind: 'mock', title: `simulated data: ${m.pattern} was answered by a mock`, detail: `status ${m.status ?? 200}` });
  if (passed && complete) for (const [name, r] of issues) if (!firings.some(f => f.name === name))
    add({ id: `gone|${name}`, kind: 'issue-gone', title: `app issue "${name}" did not occur: it may be fixed`, detail: `${[r.issue.note, r.issue.ticket].filter(Boolean).join(' · ')}. Remove the workaround if so.` });

  const decided = new Map((raw?.review?.decisions ?? []).map(d => [d.finding, d]));
  for (const f of out) if (!f.decision && decided.has(f.id)) f.decision = decided.get(f.id);
  return out;
}

/** The reading of a run's outcome once decisions are taken into account. */
export function verdict({ passed, findings: fs }) {
  if (!passed) {
    const failing = fs.filter(f => f.kind === 'failure');
    return failing.length && failing.every(f => f.decision?.decision === 'app-issue') ? 'failed-app-issue' : 'failed';
  }
  if (fs.some(f => f.kind === 'known-issue' || f.decision?.decision === 'workaround')) return 'passed-with-issues';
  if (fs.some(f => !f.decision && f.kind !== 'failure')) return 'needs-review';
  return 'passed';
}

/** Scene ids a mock answered in: a mock step's scene and every scene after it; fixture mocks ("setup") all. */
function mockScenesOf(steps, raw) {
  const out = new Set();
  const n = (raw?.scenes ?? []).length;
  for (const s of steps) {
    if ((s.action ?? actionOf(s.spec)) !== 'mock' || s.ok === false) continue;
    const id = sceneId(s.scene);
    if (!/^scene-\d+$/.test(id)) { out.add('*'); continue; }
    for (let i = Number(id.slice(6)); i <= n; i++) out.add(`scene-${String(i).padStart(2, '0')}`);
  }
  if (raw?.mocks?.length) out.add('*');
  return out;
}

/** The whole review for a report: { verdict, label, evidence, findings, open }. */
export function review({ raw, steps = [], criteria = [], firings: fired = [], mocks = [], passed, complete = true }) {
  // A firing while a scene's page loads has no scene yet, only its step key ("scene-01 (url)#1").
  const firings = fired.map(f => ({ ...f, scene: f.scene ?? (/^scene-\d+/.exec(f.stepKey ?? '')?.[0] ?? null) }));
  const ev = evidence({ raw, steps, criteria, firings, mockScenes: mockScenesOf(steps, raw) });
  const fs = findings({ raw, steps, firings, mocks, evidence: ev, passed, complete });
  const v = verdict({ passed, findings: fs });
  return { verdict: v, label: VERDICTS[v], evidence: ev, findings: fs, open: fs.filter(f => !f.decision).length };
}
