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
//                                             (a custom-element tag name such as "forge-app-bar" is finally tried as CSS)
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
      ...ROLES.slice(0, 4).map(role => page.getByRole(role, { name: target })), page.getByText(target, { exact: true }), page.getByText(target),
      // A form field by its name attribute (inputs without a visible label).
      ...(/^[A-Za-z_][\w.-]*$/.test(target) ? [page.locator(`[name="${target}"]`)] : []),
      // Last resort: something shaped like a custom element's tag name (forge-app-bar, my-widget) as CSS.
      ...(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(target) ? [page.locator(target)] : [])];
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

/**
 * Waits for the page to be ready after an action. Default: DOM loaded, then network idle (briefly). Apps with
 * long-lived connections never go network-idle; for them a tour sets "ready" (see declarative.mjs):
 *   { "busy": "<css of spinners/splash>", "stableMs": 1500, "timeout": 60000, "stableTimeout": 15000 }
 * = wait until no busy element is visible, then until the page's text and element count stop changing.
 */
export async function settle(page, ready) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  if (!ready) { await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); return; }
  if (ready.busy)
    await page.waitForFunction(busy => ![...document.querySelectorAll(busy)].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'),
      ready.busy, { timeout: ready.timeout ?? 60000, polling: 250 }).catch(() => {});
  const until = Date.now() + (ready.stableTimeout ?? 15000);
  let last = null, since = Date.now();
  while (Date.now() < until) {
    const now = await page.evaluate(() => `${document.body?.innerText.length}:${document.getElementsByTagName('*').length}`).catch(() => null);
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= (ready.stableMs ?? 1500)) return;
    await page.waitForTimeout(250);
  }
}

/**
 * The app's own error indicator, if the tour declares one ("errors": { "selector": "<css>", "text": "<regex>" }):
 * returns the error's text when one is visible, else null. Lets a step fail with the app's message instead of
 * carrying on over an error dialog.
 */
export async function appError(page, errors) {
  if (!errors?.selector) return null;
  const re = errors.text ? new RegExp(errors.text, 'i') : null;
  for (const el of await page.locator(errors.selector).all()) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!re || re.test(text)) return text.slice(0, 300) || '(error shown)';
  }
  return null;
}

/** A step as it may be shown in logs, reports and errors: secret values never are. */
export const shown = step => (step.secret ? { ...step, text: '***' } : step);

/** Runs one step on the tour. Pacing ("at") is the caller's business unless the step is an explicit "at". */
export async function runStep(t, step, { baseUrl, timeouts = {}, ready, errors }) {
  const page = t.page;
  // Per-target defaults (tour.json "timeouts"), per-step override; slow screens such as reports need more.
  // An optional step gives up sooner, so a miss doesn't stall the scene.
  const timeout = step.timeout ?? (step.optional ? timeouts.optional ?? 3000 : timeouts.action ?? 10000);
  switch (actionOf(step)) {
    case 'goto': await page.goto(absolute(baseUrl, step.goto), { timeout: timeouts.navigation ?? 30000 }); await settle(page, ready); break;
    case 'click': await t.click(await resolve(page, step.click, { timeout })); await settle(page, ready); break;
    case 'fill': {
      const el = await resolve(page, step.fill, { timeout });
      if (step.secret) {
        // Set through the DOM, not typed: the value never appears in Playwright's action log or a trace.
        await t.moveTo(el);
        await el.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); },
          String(step.text ?? ''));
      } else await t.typeInto(el, String(step.text ?? ''));
      break;
    }
    case 'press': await page.keyboard.press(step.press); await sleep(300); await settle(page, ready); break;
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
  const err = await appError(page, errors);
  if (err) throw new Error(`the app showed an error: ${err}`);
}

/**
 * Runs a scene's steps. Unless the scene places its own "at" steps, actions are spread evenly across the narration
 * (the first right away, the last by about 80%), so the video moves while the narrator talks.
 */
/** Thrown at --until-step: the requested part of the run is done. */
export class StopRun extends Error {}

export async function runSteps(t, steps, { baseUrl, onError = 'fail', unpaced = false, timeouts, report, scene, ready, errors, criteria = [], retries = 1, range } = {}) {
  const paced = unpaced || steps.some(s => 'at' in s); // unpaced: off camera (login, setup), as fast as possible
  const actions = steps.filter(s => !['at', 'wait', 'waitFor'].includes(actionOf(s)));
  let i = 0;
  for (const step of steps) {
    const a = actionOf(step);
    // --from-step / --until-step count scene steps across the whole tour (1-based, as in report.md's order).
    if (range && !unpaced) {
      range.n++;
      if (range.until && range.n > range.until) throw new StopRun(`stopped before step ${range.n} (--until-step ${range.until})`);
    }
    const fastForward = range?.from && range.n < range.from;
    if (!paced && !fastForward && !['at', 'wait', 'waitFor'].includes(a)) {
      await t.at(actions.length > 1 ? 0.05 + (0.75 * i) / (actions.length - 1) : 0.1);
      i++;
    }
    const index = steps.indexOf(step) + 1;
    // A check (verify) tests the app; anything else is the script driving it. Checks carry the acceptance criteria
    // they cover: the step's own "criterion" (e.g. "AC2" or 2), else the scene's "criteria".
    const kind = a === 'verify' ? 'check' : 'action';
    const covers = kind === 'check' ? [step.criterion ?? criteria].flat().filter(c => c !== undefined && c !== '').map(String) : [];
    const started = Date.now();
    const entry = { scene, step: index, action: a, kind, ...(covers.length ? { criteria: covers } : {}), spec: shown(step) };
    try {
      // Rule-based retries for actions only (timeouts, elements not there yet). A failed check is never retried.
      for (let attempt = 0; ; attempt++) {
        try { await runStep(t, step, { baseUrl, timeouts, ready, errors }); break; } catch (e) {
          if (kind === 'check' || attempt >= (step.retries ?? retries) || !/Timeout|not found|not visible|detached/i.test(e.message)) throw e;
          log(`${scene ?? 'setup'} step ${index}: retrying (${e.message.split('\n')[0]})`);
          await settle(t.page, ready);
          entry.retried = attempt + 1;
        }
      }
      report?.push({ ...entry, ok: true, ms: Date.now() - started });
    } catch (e) {
      const message = e.message.split('\n')[0];
      const target = targetOf(step);
      const suggestions = target ? await suggest(t.page, target) : [];
      // The app's own error UI (tour "errors") during a step is an APP failure, whatever the step.
      const failure = /^the app showed an error/.test(message) ? 'app' : kind === 'check' ? 'criterion' : 'script';
      Object.assign(entry, { ok: false, failure, optional: !!step.optional, error: message, url: t.page.url(), ms: Date.now() - started,
        ...(target && failure !== 'app' ? { expected: target, found: suggestions.length ? `closest on the page: ${suggestions.join(' | ')}` : 'nothing similar on the page' } : {}),
        suggestions });
      report?.push(entry);
      const hint = suggestions.length ? ` (did you mean ${suggestions.map(x => JSON.stringify(x)).join(', ')}?)` : '';
      // collect (dry run): report everything and carry on. Otherwise a failed "verify" always stops the run (it's an
      // acceptance check) unless that step is marked optional.
      if (onError === 'collect' || step.optional || (onError === 'skip' && a !== 'verify'))
        log(`${scene ?? 'setup'} step ${index} ${onError === 'collect' ? 'FAILED' : 'skipped'}: ${message}${hint}`);
      else throw Object.assign(new StepError(`${failure === 'criterion' ? `CRITERION${covers.length ? ` ${covers.join(', ')}` : ''} not met` : failure === 'app' ? 'APP error' : 'SCRIPT failure'}: ${scene ?? 'setup'} step ${index} ${JSON.stringify(shown(step))}: ${message}${hint}`), { failure, entry });
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
