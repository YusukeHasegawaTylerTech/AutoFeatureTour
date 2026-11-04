// Declarative tour steps, so a tour can be plain JSON instead of code (and can be generated).
//
// A step is an object with one action key:
//   { "goto": "/path" }                       navigate (relative to baseUrl)
//   { "click": <target> }                     move the cursor there and click
//   { "fill": <target>, "text": "..." }       click, clear and type
//   { "press": "Enter" }                      keyboard
//   { "hover": <target> } / { "point": ... }  move the cursor there (point: alias, for "look at this")
//   { "select": <target>, "option": "..." }   choose a <select> option
//   { "scroll": 400 }                         wheel by pixels (negative = up)
//   { "waitFor": <target> }                   wait (off-pace) until visible
//   { "verify": <target> }                    assert it's visible (fails clearly if not) and point at it
//   { "wait": 1.5 }                           pause, in seconds
//   { "at": 0.5 }                             wait until 50% of the scene's narration has played
// Optional on any step: "optional": true (log and continue if it fails), "timeout": ms (defaults: tour.json
// "timeouts": { "action": 10000, "verify": 15000, "waitFor": 30000, "navigation": 30000 }).
//
// A target is either a string or an object:
//   "Save"                                    a button/link/tab/menu item named Save, else a label, placeholder or text
//   "css=.toolbar button"  "#id"  ".class"    CSS (anything starting with # . [ or css=)
//   { "role": "button", "name": "Save" }     ARIA role + accessible name
//   { "label": "Email" } { "placeholder": "Search" } { "text": "Welcome" } { "testId": "save" } { "css": "..." }
//   plus "nth": n to pick among several matches (default: the first visible one).

import { log, sleep } from './util.mjs';

const ROLES = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch', 'combobox', 'textbox'];
const ACTIONS = ['goto', 'click', 'fill', 'press', 'hover', 'point', 'select', 'scroll', 'waitFor', 'verify', 'wait', 'at'];

export function actionOf(step) {
  const a = ACTIONS.find(k => k in step);
  if (!a) throw new Error(`Unknown step ${JSON.stringify(step)}; expected one of ${ACTIONS.join(', ')}`);
  return a;
}

/** Candidate locators for a target, most specific first. */
function candidates(page, target) {
  if (typeof target === 'string') {
    if (target.startsWith('css=')) return [page.locator(target.slice(4))];
    if (/^[#.[]/.test(target)) return [page.locator(target)];
    const exact = ROLES.map(role => page.getByRole(role, { name: target, exact: true }));
    return [...exact, page.getByLabel(target, { exact: true }), page.getByPlaceholder(target, { exact: true }),
      ...ROLES.slice(0, 4).map(role => page.getByRole(role, { name: target })), page.getByText(target, { exact: true }), page.getByText(target)];
  }
  const t = target;
  if (t.css) return [page.locator(t.css)];
  if (t.testId) return [page.getByTestId(t.testId)];
  if (t.role) return [page.getByRole(t.role, { name: t.name, exact: t.exact ?? false })];
  if (t.label) return [page.getByLabel(t.label)];
  if (t.placeholder) return [page.getByPlaceholder(t.placeholder)];
  if (t.text) return [page.getByText(t.text, { exact: t.exact ?? false })];
  throw new Error(`Unusable target ${JSON.stringify(target)}`);
}

/** Resolves a target to one visible element, retrying until timeout (pages render asynchronously). */
export async function resolve(page, target, { timeout = 10000 } = {}) {
  const until = Date.now() + timeout;
  const nth = typeof target === 'object' ? target.nth : undefined;
  for (;;) {
    for (const loc of candidates(page, target)) {
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      if (nth !== undefined) { if (n > nth && await loc.nth(nth).isVisible()) return loc.nth(nth); continue; }
      for (let i = 0; i < Math.min(n, 20); i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
    }
    if (Date.now() > until) throw new Error(`Target not found: ${JSON.stringify(target)}`);
    await sleep(250);
  }
}

/** A tour-shaped actor for steps run off camera (login, discovery): no cursor animation, no pacing. */
export function plainActor(page) {
  return {
    page,
    click: el => el.click(),
    typeInto: (el, text) => el.fill(text),
    moveTo: el => el.hover().catch(() => {}),
    at: async () => {},
  };
}

const absolute =(baseUrl, url) => new URL(url, baseUrl).href;

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

/** Runs one step on the tour. Pacing ("at") is the caller's business unless the step is an explicit "at". */
export async function runStep(t, step, { baseUrl, timeouts = {} }) {
  const page = t.page;
  // Per-target defaults (tour.json "timeouts"), per-step override; slow screens such as reports need more.
  // An optional step gives up sooner, so a miss doesn't stall the scene.
  const timeout = step.timeout ?? (step.optional ? timeouts.optional ?? 3000 : timeouts.action ?? 10000);
  switch (actionOf(step)) {
    case 'goto': await page.goto(absolute(baseUrl, step.goto), { timeout: timeouts.navigation ?? 30000 }); await settle(page); break;
    case 'click': await t.click(await resolve(page, step.click, { timeout })); await settle(page); break;
    case 'fill': await t.typeInto(await resolve(page, step.fill, { timeout }), String(step.text ?? '')); break;
    case 'press': await page.keyboard.press(step.press); await sleep(300); await settle(page); break;
    case 'hover': await t.moveTo(await resolve(page, step.hover, { timeout }), { steps: 35 }); break;
    case 'point': await t.moveTo(await resolve(page, step.point, { timeout }), { steps: 35 }); break;
    case 'select': {
      const el = await resolve(page, step.select, { timeout });
      await t.moveTo(el);
      await el.selectOption(step.option);
      break;
    }
    case 'scroll': {
      const vp = page.viewportSize();
      await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 20 });
      await page.mouse.wheel(0, Number(step.scroll));
      await sleep(400);
      break;
    }
    case 'waitFor': await resolve(page, step.waitFor, { timeout: step.timeout ?? timeouts.waitFor ?? 30000 }); break;
    case 'verify': {
      let el;
      try { el = await resolve(page, step.verify, { timeout: step.timeout ?? timeouts.verify ?? 15000 }); }
      catch { throw new Error(`Verification failed: ${JSON.stringify(step.verify)} is not on the page (${page.url()})`); }
      await t.moveTo(el, { steps: 30 });
      break;
    }
    case 'wait': await sleep(Number(step.wait) * 1000); break;
    case 'at': await t.at(Number(step.at)); break;
  }
}

/**
 * Runs a scene's steps. Unless the scene places its own "at" steps, actions are spread evenly across the narration
 * (the first right away, the last by about 80%), so the video moves while the narrator talks.
 */
export async function runSteps(t, steps, { baseUrl, onError = 'fail', unpaced = false, timeouts, report, scene } = {}) {
  const paced = unpaced || steps.some(s => 'at' in s); // unpaced: off camera (login, setup), as fast as possible
  const actions = steps.filter(s => !['at', 'wait', 'waitFor'].includes(actionOf(s)));
  let i = 0;
  for (const step of steps) {
    const a = actionOf(step);
    if (!paced && !['at', 'wait', 'waitFor'].includes(a)) {
      await t.at(actions.length > 1 ? 0.05 + (0.75 * i) / (actions.length - 1) : 0.1);
      i++;
    }
    const index = steps.indexOf(step) + 1;
    try {
      await runStep(t, step, { baseUrl, timeouts });
      report?.push({ scene, step: index, action: a, ok: true, spec: step });
    } catch (e) {
      const message = e.message.split('\n')[0];
      const target = targetOf(step);
      const suggestions = target ? await suggest(t.page, target) : [];
      report?.push({ scene, step: index, action: a, ok: false, optional: !!step.optional, spec: step, error: message, url: t.page.url(), suggestions });
      const hint = suggestions.length ? ` (did you mean ${suggestions.map(x => JSON.stringify(x)).join(', ')}?)` : '';
      // collect (dry run): report everything and carry on. Otherwise a failed "verify" always stops the run (it's an
      // acceptance check) unless that step is marked optional.
      if (onError === 'collect' || step.optional || (onError === 'skip' && a !== 'verify'))
        log(`${scene ?? 'setup'} step ${index} ${onError === 'collect' ? 'FAILED' : 'skipped'}: ${message}${hint}`);
      else throw new StepError(`${scene ?? 'setup'} step ${index} ${JSON.stringify(step)}: ${message}${hint}`);
    }
  }
}

/** A step that couldn't be done; the CLI maps it to exit code 2. */
export class StepError extends Error {}

const targetOf = step => step[actionOf(step)] && actionOf(step) !== 'goto' && typeof step[actionOf(step)] !== 'number' ? step[actionOf(step)] : null;
const targetText = t => (typeof t === 'string' ? t.replace(/^css=/, '') : t.name ?? t.label ?? t.placeholder ?? t.text ?? t.testId ?? t.css ?? '');

/** Levenshtein distance, for closest-match suggestions. */
function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return d[b.length];
}

/** Up to three visible names on the page closest to a target that didn't resolve. */
export async function suggest(page, target) {
  const want = targetText(target).toLowerCase().trim();
  if (!want) return [];
  const names = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = new Set();
    for (const el of document.querySelectorAll('a, button, [role], label, input, textarea, select, h1, h2, h3, h4, th, td, li, span'))
      if (vis(el)) for (const v of [el.getAttribute('aria-label'), el.placeholder, el.innerText]) { const s = (v ?? '').replace(/\s+/g, ' ').trim(); if (s && s.length <= 60) out.add(s); }
    return [...out].slice(0, 800);
  }).catch(() => []);
  return names
    .map(n => ({ n, score: n.toLowerCase().includes(want) || want.includes(n.toLowerCase()) ? 0.1 : distance(want, n.toLowerCase()) / Math.max(want.length, n.length) }))
    .filter(x => x.score < 0.5).sort((a, b) => a.score - b.score).slice(0, 3).map(x => x.n);
}
