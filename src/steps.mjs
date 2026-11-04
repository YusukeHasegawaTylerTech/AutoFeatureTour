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
export async function runSteps(t, steps, { baseUrl, onError = 'fail', unpaced = false, timeouts } = {}) {
  const paced = unpaced || steps.some(s => 'at' in s); // unpaced: off camera (login, setup), as fast as possible
  const actions = steps.filter(s => !['at', 'wait', 'waitFor'].includes(actionOf(s)));
  let i = 0;
  for (const step of steps) {
    const a = actionOf(step);
    if (!paced && !['at', 'wait', 'waitFor'].includes(a)) {
      await t.at(actions.length > 1 ? 0.05 + (0.75 * i) / (actions.length - 1) : 0.1);
      i++;
    }
    try {
      await runStep(t, step, { baseUrl, timeouts });
    } catch (e) {
      // A failed "verify" always stops the run (it's an acceptance check) unless that step is marked optional.
      if (step.optional || (onError === 'skip' && a !== 'verify')) log(`step skipped (${e.message.split('\n')[0]}): ${JSON.stringify(step)}`);
      else throw e;
    }
  }
}
