// Declarative tour steps, so a tour can be plain JSON instead of code (and can be generated). The authoritative list
// of steps, locators and their options is schemas/common.schema.json (source: src/schema-defs.mjs); AGENTS.md has
// the table. A step is an object with one action key plus common options (optional, timeout, retries, criterion,
// waitForResponse/status/method). A locator is a string (tried as role/label/placeholder/text…) or an object with one
// of role, label, placeholder, text, testId, alt, css, narrowed by has/hasNot/hasText/hasNotText/nth and scoped by
// within (another locator) and frame (iframe selectors).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Failure } from './failures.mjs';
import { substitute } from './platform.mjs';
import { log, sleep } from './util.mjs';

const ROLES = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch', 'combobox', 'textbox'];
// Order matters only for waitForResponse, which is also an option on other steps: any other action key wins.
const ACTIONS = ['goto', 'click', 'dblclick', 'rightClick', 'hover', 'point', 'fill', 'type', 'clear', 'focus', 'press', 'check', 'uncheck', 'select', 'upload',
  'drag', 'scroll', 'waitFor', 'verify', 'capture', 'pin', 'wait', 'at', 'dialog', 'switchTo', 'download', 'mock', 'code', 'signInAs', 'waitForResponse'];

export function actionOf(step) {
  const a = ACTIONS.find(k => k in step);
  if (!a) throw new Error(`Unknown step ${JSON.stringify(step)}; expected one of ${ACTIONS.join(', ')}`);
  return a;
}

/** Candidate locators for a target, most specific first; each carries "how" (the equivalent target, for aft locate). */
export function candidates(page, target) {
  // has / hasNot / hasText / hasNotText narrow every candidate; within / frame are applied by scope() first.
  const f = typeof target === 'object' && target ? target : {};
  // "/regex/flags" in a name, label, text, alt or hasText is a regular expression (as in text patterns).
  const rx = v => { const m = typeof v === 'string' && v.match(/^\/(.+)\/([a-z]*)$/s); return m ? new RegExp(m[1], m[2]) : v; };
  const inner = t => { const c = candidates(page, t); return c.slice(1).reduce((a, b) => a.or(b), c[0]); };
  const filter = (f.has || f.hasNot || f.hasText || f.hasNotText)
    ? { ...(f.has ? { has: inner(f.has) } : {}), ...(f.hasNot ? { hasNot: inner(f.hasNot) } : {}), ...(f.hasText ? { hasText: rx(f.hasText) } : {}), ...(f.hasNotText ? { hasNotText: rx(f.hasNotText) } : {}) }
    : null;
  const as = (loc, how) => Object.assign(filter ? loc.filter(filter) : loc, { how });
  if (typeof target === 'string') {
    if (target.startsWith('css=')) return [as(page.locator(target.slice(4)), { css: target.slice(4) })];
    if (/^[#.[]/.test(target)) return [as(page.locator(target), { css: target })];
    const exact = ROLES.map(role => as(page.getByRole(role, { name: target, exact: true }), { role, name: target, exact: true }));
    return [...exact, as(page.getByLabel(target, { exact: true }), { label: target, exact: true }),
      as(page.getByPlaceholder(target, { exact: true }), { placeholder: target, exact: true }),
      ...ROLES.slice(0, 4).map(role => as(page.getByRole(role, { name: target }), { role, name: target })),
      as(page.getByText(target, { exact: true }), { text: target, exact: true }), as(page.getByText(target), { text: target }),
      // A form field by its name attribute (inputs without a visible label).
      ...(/^[A-Za-z_][\w.-]*$/.test(target) ? [as(page.locator(`[name="${target}"]`), { css: `[name="${target}"]` })] : []),
      // Last resort: something shaped like a custom element's tag name (forge-app-bar, my-widget) as CSS.
      ...(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(target) ? [as(page.locator(target), { css: target })] : [])];
  }
  const t = target;
  const how = Object.fromEntries(Object.entries(t).filter(([k]) => !['nth', 'within', 'frame'].includes(k)));
  if (t.css) return [as(page.locator(t.css), how)];
  if (t.testId) return [as(page.getByTestId(t.testId), how)];
  if (t.role) return [as(page.getByRole(t.role, { name: rx(t.name), exact: t.exact ?? false }), how)];
  if (t.label) return [as(page.getByLabel(rx(t.label)), how)];
  if (t.placeholder) return [as(page.getByPlaceholder(t.placeholder), how)];
  if (t.text) return [as(page.getByText(rx(t.text), { exact: t.exact ?? false }), how)];
  if (t.alt) return [as(page.getByAltText(rx(t.alt), { exact: t.exact ?? false }), how)];
  throw new Error(`Unusable target ${JSON.stringify(target)}`);
}

/** Resolves a target to one visible element, retrying until timeout (pages render asynchronously). */
/**
 * Where a locator searches: the page, inside its "frame" (iframe selectors, outermost first), inside the element its
 * "within" resolves to. Returns the root and the target without those keys.
 */
export async function scope(page, target, opts = {}) {
  if (!target || typeof target !== 'object') return { root: page, target };
  let root = page;
  for (const f of [target.frame ?? []].flat()) root = root.frameLocator(f);
  if (target.within) root = await resolve(root, target.within, opts);
  const { within, frame, ...rest } = target;
  return { root, target: rest };
}

export async function resolve(page, target0, { timeout = 10000, warnings, onPoll } = {}) {
  const until = Date.now() + timeout;
  const { root, target } = await scope(page, target0, { timeout, warnings, onPoll });
  const nth = typeof target === 'object' ? target.nth : undefined;
  for (;;) {
    for (const loc of candidates(root, target)) {
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      if (nth !== undefined) { if (n > nth && await loc.nth(nth).isVisible()) return loc.nth(nth); continue; }
      const visible = [];
      for (let i = 0; i < Math.min(n, 20) && visible.length < 2; i++) if (await loc.nth(i).isVisible().catch(() => false)) visible.push(i);
      if (visible.length) {
        // Several visible matches: use the first, but say so (add "nth" or a role to pick one deliberately).
        if (visible.length > 1) warnings?.push(`ambiguous target ${JSON.stringify(target0)}: ${n} matches, used the first visible one (add "nth" or a role)`);
        return loc.nth(visible[0]);
      }
    }
    if (Date.now() > until) throw new Error(`Target not found: ${JSON.stringify(target0)}`);
    // A known issue (a workaround's popup) may be what hides the target: deal with it, then look again.
    await onPoll?.();
    await sleep(250);
  }
}

/** A tour-shaped actor for steps run off camera (login, discovery): no cursor animation, no pacing. */
export function plainActor(page, { workarounds } = {}) {
  const actor = {
    workarounds,
    page,
    click: async (el, o = {}) => {
      // A known issue covering the target (a workaround's popup): deal with it, then click.
      try { await el.click({ button: o.button, clickCount: o.clickCount, modifiers: o.modifiers, timeout: 5000 }); }
      catch (e) { if (!actor.workarounds?.any || !(await actor.workarounds.checkpoint(actor))) throw e; await el.click({ button: o.button, clickCount: o.clickCount, modifiers: o.modifiers }); }
    },
    typeInto: (el, text) => el.fill(text),
    moveTo: el => el.hover().catch(() => {}),
    at: async () => {},
  };
  return actor;
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
  if (ready.busy) {
    const ok = await page.waitForFunction(busy => ![...document.querySelectorAll(busy)].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'),
      ready.busy, { timeout: ready.timeout ?? 60000, polling: 250 }).then(() => true, () => false);
    if (!ok) {
      const msg = `page never settled: a busy indicator (${ready.busy}) was still visible after ${(ready.timeout ?? 60000) / 1000}s`;
      if (ready.strict) throw new Failure('app', `the app showed an error: ${msg}`);
      ready.warnings?.push(msg);
    }
  }
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
    // A known issue (platform "workarounds") is reported under its own name, not as an app error.
    if (await el.evaluate((e, k) => !!(e.closest(`[${k}]`) || e.querySelector(`[${k}]`)), 'data-aft-workaround').catch(() => false)) continue;
    const text = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!re || re.test(text)) return text.slice(0, 300) || '(error shown)';
  }
  return null;
}

/** A step as it may be shown in logs, reports and errors: secret values never are; code steps by file name. */
export const shown = step => {
  // secret: true on fill/type hides its text; a pin's "secret" is a list of field names (its values never are in the step).
  let s = step.secret === true ? { ...step, text: '***' } : step;
  if (typeof s.code === 'string' && path.isAbsolute(s.code)) s = { ...s, code: path.basename(s.code) };
  return s;
};

const modules = new Map();

/**
 * A code step: { "code": "<file>.mjs", "with": { ... } } (normally a platform fragment). The module's default export
 * is called as  async ({ page, context, args, ctx }) => { ... }  and must be deterministic: no LLM, no randomness
 * that changes what's on screen. It is classified like any step: a plain throw is a SCRIPT failure;
 * ctx.check(condition, message) fails as a CRITERION (the step's "criterion", else the scene's criteria);
 * ctx.appError(message) fails as APP. ctx also has baseUrl, timeouts, log, url(path), the paced tour (ctx.tour:
 * click(el), typeInto(el, text), moveTo(el)) and ctx.resolve(target) (the same target rules as JSON steps).
 * Code steps are never retried (they may not be safe to repeat).
 */
async function runCode(t, step, { baseUrl, timeouts, warnings }) {
  const href = pathToFileURL(path.resolve(step.code)).href;
  if (!modules.has(href)) modules.set(href, import(href));
  const fn = (await modules.get(href)).default;
  if (typeof fn !== 'function') throw new Error(`${path.basename(step.code)} has no default export function`);
  const page = t.page;
  const ctx = {
    baseUrl, timeouts, log, warnings, tour: t, args: step.with ?? {}, vars: (t.vars ??= {}),
    url: p => absolute(baseUrl, p),
    resolve: (target, o = {}) => resolve(page, target, { timeout: o.timeout ?? timeouts.action ?? 10000, warnings }),
    check: (ok, message = 'check failed') => { if (!ok) throw Object.assign(new Error(`Verification failed: ${message}`), { failure: 'criterion' }); },
    appError: message => { throw new Error(`the app showed an error: ${message}`); },
  };
  await fn({ page, context: page.context(), args: ctx.args, ctx });
}

/** Runs one step on the tour. Pacing ("at") is the caller's business unless the step is an explicit "at". */
/** A URL pattern from a step: "/regex/" or a substring. */
const urlMatcher = pat => {
  const m = String(pat).match(/^\/(.+)\/([dgimsuy]*)$/);
  if (m) { const re = new RegExp(m[1], m[2]); return u => re.test(u); }
  return u => u.includes(pat);
};
const matches = (pat, value) => urlMatcher(pat)(String(value ?? ''));

/** Polls fn() until it returns true or the time is up; returns the last value fn reported. */
async function until(fn, timeout, onPoll) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = await fn().catch(e => ({ ok: false, seen: e.message.split('\n')[0] }));
    if (r.ok || Date.now() > end) return r;
    await onPoll?.();
    await sleep(200);
  }
}

/** Number of visible elements a locator matches (the first candidate strategy that matches anything). */
async function visibleCount(page, target) {
  const { root, target: t } = await scope(page, target, { timeout: 1000 }).catch(() => ({ root: null }));
  if (!root) return 0;
  for (const loc of candidates(root, t)) {
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    let v = 0;
    for (let i = 0; i < Math.min(n, 200); i++) if (await loc.nth(i).isVisible().catch(() => false)) v++;
    if (v) return v;
  }
  return 0;
}

/**
 * A text condition on an element. It passes on the rendered text (innerText) or the source text (textContent): CSS
 * text-transform changes the first but not the second, so "Paused" matches a label shown as "PAUSED". When it fails
 * only on case, "seen" says so, so the fix (the page's case, or /…/i) is obvious.
 */
async function textCheck(el, test, want, near = 0) {
  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  // near: n: the text of the element's n-th parent instead (a label and its value in separate elements).
  const [shown, source] = (await el.evaluate((e, n) => { for (let i = 0; i < n && e.parentElement; i++) e = e.parentElement; return [e.innerText, e.textContent]; }, near)).map(norm);
  if (test(shown) || test(source)) return { ok: true };
  const lower = want.toLowerCase();
  const caseOnly = !/^\/.+\/[a-z]*$/.test(want) && [shown, source].some(s => s.toLowerCase().includes(lower));
  return { ok: false, seen: `text "${shown.slice(0, 120)}"${caseOnly ? ' (it matches if case is ignored: use the case on the page, or /…/i)' : ''}` };
}

const nearOf = step => step.near === true ? 1 : Number(step.near ?? 0);

const failCheck = message => { throw Object.assign(new Error(`Verification failed: ${message}`), { failure: 'criterion' }); };

/** verify: visible (default), or a condition on the element or the page. */
/** aria-selected (tabs, options) / aria-checked / aria-pressed is "true" on the element. */
const ariaOn = (el, ...attrs) => el.evaluate((e, names) => names.some(n => e.getAttribute(n) === 'true'), attrs);

/** checked: a checkbox, radio or switch; on anything else (a tab, a toggle button) its aria-selected / aria-checked / aria-pressed. */
const isOn = el => el.isChecked().catch(e => {
  if (/Not a checkbox|not a checkbox/i.test(e.message)) return ariaOn(el, 'aria-selected', 'aria-checked', 'aria-pressed');
  throw e;
});

async function verify(t, step, { timeout, warnings, onPoll }) {
  const page = t.page;
  const v = step.verify;
  const show = JSON.stringify(v);
  if (v && typeof v === 'object' && ('url' in v || 'title' in v) && Object.keys(v).length === 1) {
    const what = 'url' in v ? 'URL' : 'title';
    const r = await until(async () => { const seen = 'url' in v ? page.url() : await page.title(); return { ok: matches(v.url ?? v.title, seen), seen }; }, timeout, onPoll);
    if (!r.ok) failCheck(`page ${what} is "${r.seen}", expected ${String(v.url ?? v.title).startsWith('/') ? 'to match' : 'to contain'} "${v.url ?? v.title}"`);
    return;
  }
  if ('count' in step) {
    const want = Number(step.count);
    const r = await until(async () => { const n = await visibleCount(page, v); return { ok: n === want, seen: n }; }, timeout, onPoll);
    if (!r.ok) failCheck(`${show}: ${r.seen} visible, expected ${want}`);
    return;
  }
  if (step.state === 'hidden') {
    const r = await until(async () => { const n = await visibleCount(page, v); return { ok: n === 0, seen: n }; }, timeout, onPoll);
    if (!r.ok) failCheck(`${show} is still visible (${r.seen} match(es)), expected hidden`);
    return;
  }
  const el = await resolve(page, v, { timeout, warnings, onPoll }).catch(() => failCheck(`${show} is not on the page (${page.url()})`));
  const conditions = [
    ['text', async () => textCheck(el, s => matches(step.text, s), String(step.text), nearOf(step)), `text containing "${step.text}"`],
    ['exactText', async () => { const want = String(step.exactText).replace(/\s+/g, ' ').trim(); return textCheck(el, s => s === want, want, nearOf(step)); }, `text "${step.exactText}"`],
    ['value', async () => { const s = await el.inputValue(); return { ok: s === String(step.value), seen: `value "${s.slice(0, 120)}"` }; }, `value "${step.value}"`],
  ].filter(([k]) => k in step);
  const STATES = {
    visible: async () => ({ ok: await el.isVisible(), seen: 'hidden' }),
    enabled: async () => ({ ok: await el.isEnabled(), seen: 'disabled' }),
    disabled: async () => ({ ok: await el.isDisabled(), seen: 'enabled' }),
    checked: async () => ({ ok: await isOn(el), seen: 'unchecked' }),
    unchecked: async () => ({ ok: !(await isOn(el)), seen: 'checked' }),
    selected: async () => ({ ok: await ariaOn(el, 'aria-selected'), seen: 'not selected' }),
    unselected: async () => ({ ok: !(await ariaOn(el, 'aria-selected')), seen: 'selected' }),
    editable: async () => ({ ok: await el.isEditable(), seen: 'not editable' }),
    focused: async () => ({ ok: await el.evaluate(e => e === document.activeElement || e.contains(document.activeElement)), seen: 'not focused' }),
  };
  if (step.state) conditions.push(['state', STATES[step.state], step.state]);
  for (const [, fn, want] of conditions) {
    const r = await until(fn, timeout, onPoll);
    if (!r.ok) failCheck(`${show} has ${r.seen}, expected ${want}`);
  }
  await t.moveTo(el, { steps: 30 });
}

/**
 * capture: remembers a value from the page as {vars.<as>} for later steps (a record's id, a generated code, a link).
 * From an element: its "attribute", else a field's value, else its text; or the page URL ({ "url": true }). An optional
 * "pattern" (a regex, with or without /…/flags) keeps its first group, or the whole match without one.
 */
async function capture(t, step, { timeout, warnings }) {
  const { value } = await readValue(t, step, { timeout, warnings });
  (t.vars ??= {})[step.as] = value;
  log(`captured ${step.as} = "${value.slice(0, 80)}"`);
}

/** A value from the page, as capture reads it: { value, el } (el: the element it came from, if any). */
async function readValue(t, step, { timeout, warnings }) {
  const c = step.capture;
  let raw, el = null;
  if (c && typeof c === 'object' && 'url' in c && Object.keys(c).length === 1) raw = t.page.url();
  else {
    el = await resolve(t.page, c, { timeout, warnings });
    raw = step.attribute ? await el.getAttribute(step.attribute)
      : await el.evaluate(e => ('value' in e && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) ? e.value : e.innerText));
    if (raw === null) throw new Error(`${JSON.stringify(c)} has no attribute "${step.attribute}"`);
    await t.moveTo(el, { steps: 20 });
  }
  let value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (step.pattern !== undefined) {
    const m0 = String(step.pattern).match(/^\/(.+)\/([dgimsuy]*)$/);
    const m = value.match(m0 ? new RegExp(m0[1], m0[2].replace('g', '')) : new RegExp(step.pattern));
    if (!m) throw new Error(`capture: "${value.slice(0, 120)}" doesn't match ${step.pattern}`);
    value = m[1] ?? m[0];
  }
  if (!value) throw new Error(`capture: ${JSON.stringify(c)} is empty`);
  return { value, el };
}

/**
 * pin: a named group of values read from the page (an account the story created: its id, username, password), with
 * a role and an undo. t.artifacts keeps them for {artifact.<name>.<field>} / {artifact[<role>].<field>}; t.onPin (the
 * run) records its cleanup in the ledger at once. A cropped still of the element the first field came from is kept.
 */
async function pin(t, step, { timeout, warnings }) {
  const fields = {};
  let first = null;
  for (const [k, spec] of Object.entries(step.fields ?? {})) {
    if (spec && typeof spec === 'object' && 'value' in spec && Object.keys(spec).length === 1) { fields[k] = String(spec.value); continue; }
    const r = await readValue(t, spec && typeof spec === 'object' && 'capture' in spec ? spec : { capture: spec }, { timeout, warnings })
      .catch(e => { throw new Error(`pin ${step.pin}.${k}: ${e.message.split('\n')[0]}`); });
    fields[k] = r.value;
    first ??= r.el;
  }
  const unknown = (step.secret ?? []).filter(k => !(k in fields));
  if (unknown.length) throw new Error(`pin ${step.pin}: "secret" names ${unknown.map(k => `"${k}"`).join(', ')}, which it has no field for`);
  const secret = step.secret ?? [];
  t.secrets?.push(...secret.map(k => fields[k]).filter(Boolean));
  const a = { name: step.pin, role: step.role ?? null, fields, secret, source: 'step', stepKey: t.stepKey, readOnly: !!step.readOnly, at: new Date().toISOString() };
  if (first && t.outDir) {
    const dir = path.join(t.outDir, 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const mask = (t.mask?.selectors ?? []).map(s => t.page.locator(s));
    if (await first.screenshot({ path: path.join(dir, `${step.pin}.png`), mask, timeout: 5000 }).then(() => true, () => false)) a.shot = `artifacts/${step.pin}.png`;
  }
  // Its own cleanup may refer to it: resolved now, so the ledger holds exactly what to delete.
  const all = [...(t.artifacts ?? []).filter(x => x.name !== a.name), a];
  if (step.cleanup) a.cleanup = fillArtifacts(step.cleanup, all);
  t.artifacts = all;
  log(`pinned ${a.role ? `${a.role} ` : ''}${a.name}: ${Object.keys(fields).map(k => `${k}=${secret.includes(k) ? '***' : JSON.stringify(fields[k].slice(0, 40))}`).join(', ')}`);
  await t.onPin?.(a);
}

const ARTIFACT_REF = /\{artifact(?:\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)\])\.([A-Za-z0-9_-]+)\}/g;

/**
 * Fills {artifact.<name>.<field>} and {artifact[<role>].<field>} (the latest artifact of that role) in every string of
 * a value. An unknown artifact or field is an error (a SCRIPT failure in a step).
 */
export function fillArtifacts(value, artifacts = []) {
  if (typeof value === 'string') return value.replace(ARTIFACT_REF, (m, name, role, field) => {
    const a = name ? artifacts.find(x => x.name === name) : [...artifacts].reverse().find(x => x.role === role);
    if (!a) throw new Error(name ? `no artifact "${name}": pin it first with { "pin": "${name}", "fields": { … } }` : `no artifact with role "${role}" pinned yet`);
    if (!(field in a.fields)) throw new Error(`artifact "${a.name}" has no field "${field}" (has: ${Object.keys(a.fields).join(', ')})`);
    return a.fields[field];
  });
  if (Array.isArray(value)) return value.map(v => fillArtifacts(v, artifacts));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillArtifacts(v, artifacts)]));
  return value;
}

/** {vars.x} in a step: the values captured so far. One that hasn't been captured is a SCRIPT failure. */
function withVars(t, step0) {
  // A pin's own cleanup is resolved when it is pinned (it may name the artifact being made).
  if ('pin' in step0 && step0.cleanup) { const { cleanup, ...rest } = step0; return { ...withVars(t, rest), cleanup }; }
  const step = JSON.stringify(step0).includes('{artifact') ? fillArtifacts(step0, t.artifacts ?? []) : step0;
  const json = JSON.stringify(step);
  if (!json.includes('{vars.') && !json.includes('{data.')) return step;
  // {data.x} left after loading: a value a fixture hook looked up at run time ("output"), filled in now.
  const out = substitute(step, { vars: t.vars ?? {}, data: t.data ?? {} }, ['vars', 'data']);
  const missing = JSON.stringify(out).match(/\{vars\.([A-Za-z0-9_.-]+)\}/);
  if (missing) throw new Error(`no captured value "${missing[1]}": capture it first with { "capture": <target>, "as": "${missing[1]}" }`);
  const noData = JSON.stringify(out).match(/\{data\.([A-Za-z0-9_.-]+)\}/);
  if (noData) throw new Error(`no data value "${noData[1]}": no fixture's "data" has it and no fixture hook set it (a hook with "output")`);
  return out;
}

/** The page a popup / new tab opened by fn; t.page switches to it (the main page is kept as t.mainPage). */
async function inPopup(t, fn, timeout) {
  const [popup] = await Promise.all([t.page.context().waitForEvent('page', { timeout }), fn()]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  t.mainPage ??= t.page;
  t.page = popup;
  return popup;
}

/** Runs one step on the tour. Pacing ("at") is the caller's business unless the step is an explicit "at". */
/**
 * bare: a workaround's own step (no workaround checkpoint, no error-UI check: the UI it closes is a known issue).
 * root: search targets inside this locator (a workaround's matched dialog) instead of the whole page.
 */
export async function runStep(t, step0, { baseUrl, timeouts = {}, ready: readyCfg, errors, warnings = [], allowMocks = false, outDir, bare = false, root }) {
  const step = withVars(t, step0);
  const page = t.page;
  const ready = readyCfg ? { ...readyCfg, warnings } : readyCfg;
  // Per-target defaults (tour.json "timeouts"), per-step override; slow screens such as reports need more.
  // An optional step gives up sooner, so a miss doesn't stall the scene.
  const timeout = step.timeout ?? (step.optional ? timeouts.optional ?? 3000 : timeouts.action ?? 10000);
  const poll = !bare && t.workarounds?.any ? () => t.workarounds.checkpoint(t, { warnings }) : undefined;
  const el = target => resolve(root ?? page, target, { timeout, warnings, onPoll: poll });
  // Waits are recorded (timings.json "waits") so long ones can be trimmed from the video.
  const timed = async (reason, fn) => { const s0 = t.now?.(); const r = await fn(); if (s0 !== undefined) t.markWait?.(reason, s0, t.now()); return r; };
  const settled = p => timed('ready', () => settle(p, ready));
  const a = actionOf(step);
  // waitForResponse on an action: listen before acting, so a fast response can't be missed.
  const waiting = step.waitForResponse !== undefined && a !== 'waitForResponse' ? watchResponse(page, step, timeouts) : null;
  waiting?.catch(() => {}); // awaited below; don't let an early failure go unhandled
  switch (a) {
    case 'goto':
      // A page that doesn't load in time is the app's (or the network's) problem, not the script's.
    {
      // The same URL (a hash route already open) wouldn't navigate, leaving old UI state: reload instead. "reload": true
      // always loads the page afresh after navigating.
      const url = absolute(baseUrl, step.goto);
      const nav = { timeout: timeouts.navigation ?? 30000 };
      const fail = e => {
        if (/Timeout/i.test(e.message)) throw new Error(`the app showed an error: page didn't load within ${(timeouts.navigation ?? 30000) / 1000}s (${url})`);
        throw e;
      };
      if (page.url() === url) await page.reload(nav).catch(fail);
      else {
        await page.goto(url, nav).catch(fail);
        if (step.reload) await page.reload(nav).catch(fail);
      }
      await settled(page);
      break;
    }
    case 'click': {
      const target = await el(step.click);
      const opts = { button: step.button, clickCount: step.clickCount !== undefined ? Number(step.clickCount) : undefined, modifiers: step.modifiers };
      if (step.opensPopup) await inPopup(t, () => t.click(target, opts), timeout);
      else await t.click(target, opts);
      await settled(t.page);
      break;
    }
    case 'dblclick': await t.click(await el(step.dblclick), { clickCount: 2 }); await settled(page); break;
    case 'rightClick': await t.click(await el(step.rightClick), { button: 'right' }); await settled(page); break;
    case 'fill': case 'type': {
      const field = await el(step[a]);
      const text = String(step.text ?? '');
      if (step.secret) {
        // Set through the DOM, not typed: the value never appears in Playwright's action log or a trace.
        await t.moveTo(field);
        await field.evaluate((e, [v, append]) => { e.value = append ? e.value + v : v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); },
          [text, a === 'type']);
      } else if (a === 'fill') await t.typeInto(field, text);
      else { await t.click(field); await field.pressSequentially(text, { delay: step.delay !== undefined ? Number(step.delay) : 45 }); }
      break;
    }
    case 'clear': { const f = await el(step.clear); await t.moveTo(f); await f.clear(); break; }
    case 'focus': { const f = await el(step.focus); await t.moveTo(f); await f.focus(); break; }
    case 'press':
      if (step.on) { const f = await el(step.on); await t.moveTo(f); await f.press(step.press); }
      else await page.keyboard.press(step.press);
      await sleep(300); await settled(page); break;
    case 'check': case 'uncheck': {
      const box = await el(step[a]);
      await t.moveTo(box);
      await (a === 'check' ? box.check({ timeout }) : box.uncheck({ timeout }));
      await settled(page);
      break;
    }
    case 'hover': await t.moveTo(await el(step.hover), { steps: 35 }); break;
    case 'point': await t.moveTo(await el(step.point), { steps: 35 }); break;
    case 'select': {
      const sel = await el(step.select);
      await t.moveTo(sel);
      await sel.selectOption(step.option);
      break;
    }
    case 'upload': {
      const files = [step.files].flat();
      const target = await el(step.upload);
      await t.moveTo(target);
      // A file input takes the files directly; anything else (an upload button) opens a file chooser.
      if (await target.evaluate(e => e.tagName === 'INPUT' && e.type === 'file')) await target.setInputFiles(files);
      else { const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout }), t.click(target)]); await chooser.setFiles(files); }
      await settled(page);
      break;
    }
    case 'drag': {
      const from = await el(step.drag);
      const to = await el(step.to);
      const a0 = await t.moveTo(from);
      await page.mouse.down();
      await to.scrollIntoViewIfNeeded();
      const b = await to.boundingBox();
      if (!b) throw new Error('drop target not visible');
      await page.mouse.move(a0.x ?? b.x, a0.y ?? b.y, { steps: 5 });
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 });
      await page.mouse.up();
      await settled(page);
      break;
    }
    case 'scroll': {
      if (typeof step.scroll === 'number' || /^-?\d+(\.\d+)?$/.test(String(step.scroll))) {
        const vp = page.viewportSize();
        await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 20 });
        await page.mouse.wheel(0, Number(step.scroll));
      } else await t.moveTo(await el(step.scroll), { steps: 30 }); // moveTo scrolls it into view
      await sleep(400);
      break;
    }
    case 'waitFor': {
      const wait = step.timeout ?? timeouts.waitFor ?? 30000;
      const state = step.state ?? 'visible';
      if (state === 'visible') { await timed('waitFor', () => resolve(page, step.waitFor, { timeout: wait, onPoll: poll })); break; }
      const r = await timed('waitFor', () => until(async () => {
        const { root, target } = await scope(page, step.waitFor, { timeout: 1000 });
        const counts = await Promise.all(candidates(root, target).map(c => c.count().catch(() => 0)));
        const n = counts.reduce((x, y) => x + y, 0);
        const v = state === 'hidden' ? await visibleCount(page, step.waitFor) : 0;
        return { ok: state === 'attached' ? n > 0 : state === 'detached' ? n === 0 : v === 0, seen: n };
      }, wait, poll));
      if (!r.ok) throw new Error(`Timeout: ${JSON.stringify(step.waitFor)} didn't become ${state} within ${wait / 1000}s`);
      break;
    }
    case 'verify': await verify(t, step, { timeout: step.timeout ?? timeouts.verify ?? 15000, warnings, onPoll: poll }); break;
    case 'capture': await capture(t, step, { timeout, warnings }); break;
    case 'pin': await pin(t, step, { timeout, warnings }); break;
    case 'wait': await sleep(Number(step.wait) * 1000); break;
    case 'at': await t.at(Number(step.at)); break;
    case 'dialog': t.dialogPlan = { action: step.dialog, text: step.text, expect: step.expect }; break;
    case 'signInAs': {
      // Another login role, in the same browser (the run installs t.signInAs; see accountSwitcher in declarative.mjs).
      if (!t.signInAs) throw new Error(`{ "signInAs": "${step.signInAs}" } needs a run of a tour with login roles (aft run / validate / stage)`);
      await t.signInAs(t, step, { timeouts });
      break;
    }
    case 'switchTo': {
      const pages = page.context().pages().filter(p => !p.isClosed());
      t.mainPage ??= pages[0];
      t.page = step.switchTo === 'main' ? t.mainPage : pages[pages.length - 1];
      await t.page.bringToFront().catch(() => {});
      break;
    }
    case 'download': {
      const target = await el(step.download);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), t.click(target)]);
      const name = dl.suggestedFilename();
      const dir = path.join(outDir ?? t.outDir ?? process.cwd(), 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, path.basename(step.saveAs ?? name));
      await dl.saveAs(file);
      (t.downloads ??= []).push(file);
      if (step.expect !== undefined && !matches(step.expect, name)) failCheck(`downloaded "${name}", expected a file name ${String(step.expect).startsWith('/') ? 'matching' : 'containing'} "${step.expect}"`);
      break;
    }
    case 'mock': {
      if (!allowMocks) throw new Error('mock steps need "allowMocks": true on the tour (mocked responses are listed in the report)');
      const match = urlMatcher(step.mock);
      const body = step.json !== undefined ? JSON.stringify(step.json) : String(step.body ?? '');
      const contentType = step.contentType ?? (step.json !== undefined ? 'application/json' : 'text/plain');
      await page.context().route(u => match(u.href), route => (step.method && route.request().method() !== step.method ? route.fallback()
        : ((t.mockedScenes ??= new Set()).add(t.current?.id ?? 'setup'), route.fulfill({ status: Number(step.status ?? 200), contentType, body }))), step.times ? { times: Number(step.times) } : undefined);
      (t.mocks ??= []).push({ pattern: step.mock, status: Number(step.status ?? 200), method: step.method ?? null });
      warnings.push(`mocked: ${step.method ?? 'any'} ${step.mock} → ${step.status ?? 200} (this part of the run is not end to end)`);
      break;
    }
    case 'waitForResponse': await timed('waitForResponse', () => watchResponse(page, step, timeouts)); break;
    case 'code': await runCode(t, step, { baseUrl, timeouts, warnings }); await settled(page); break;
  }
  if (waiting) await timed('waitForResponse', () => waiting);
  if (t.dialogFailure) { const m = t.dialogFailure; t.dialogFailure = null; failCheck(m); }
  if (bare) return;
  // Known issues the step brought up are dealt with (or marked tolerated) before the app's error UI is looked at.
  await t.workarounds?.checkpoint(t, { warnings });
  let err = await appError(t.page, errors);
  // A known issue that came up after the checkpoint (a slow server answer) is seen here first: give the workarounds
  // another look, briefly, before calling it the app's error.
  for (let i = 0; err && t.workarounds?.any && i < 4; i++) {
    await t.workarounds.checkpoint(t, { warnings });
    err = await appError(t.page, errors);
    if (err) await page.waitForTimeout(250);
  }
  if (err) throw new Error(`the app showed an error: ${err}`);
}

/** Waits for a response matching step.waitForResponse (+ method); a wrong "status" is an APP failure. */
async function watchResponse(page, step, timeouts) {
  const match = urlMatcher(step.waitForResponse);
  const wait = step.timeout ?? timeouts.waitFor ?? 30000;
  const res = await page.waitForResponse(r => match(r.url()) && (!step.method || r.request().method() === step.method), { timeout: wait })
    .catch(() => { throw new Error(`no response matching "${step.waitForResponse}" arrived within ${wait / 1000}s`); });
  if (step.status !== undefined && res.status() !== Number(step.status))
    throw new Error(`the app showed an error: ${res.request().method()} ${res.url().replace(/\?.*$/, '')} ${res.status()} (expected ${step.status})`);
  return res;
}

/**
 * Runs a scene's steps. Unless the scene places its own "at" steps, actions are spread evenly across the narration
 * (the first right away, the last by about 80%), so the video moves while the narrator talks.
 */
/**
 * Per-target policy for app errors seen during a step (tour "appErrors"):
 *   { "network": "fail"|"warn", "console": "fail"|"warn", "pageErrors": "fail"|"warn", "ignore": ["<regex>", ...] }
 * Defaults: network 5xx and uncaught page exceptions are warnings, console errors are warnings. Ignored entries
 * (known noisy endpoints or messages) are kept in network.json/console.json, marked "ignored".
 * "fail": the step fails as an APP error naming the request, e.g. "GET /internal/DynamicReports/Modules 500".
 */
function appErrorPolicy(t, marks, entry, warnings = (entry.warnings ??= [])) {
  const p = t.policy ?? {};
  // Known issues first (platform "workarounds"): a matching request or message is reported under its name, never as an
  // app error; "as": "fail" makes it an APP failure (thrown by matchNetwork / matchConsole).
  if (t.workarounds?.any) {
    for (const n of (t.networkFailures ?? []).slice(marks.net)) if (!n.ignored) t.workarounds.matchNetwork(t, n, warnings);
    for (const c of (t.consoleErrors ?? []).slice(marks.con)) if (!c.ignored) t.workarounds.matchConsole(t, c, warnings);
  }
  const fresh = [
    ...(t.networkFailures ?? []).slice(marks.net).filter(n => !n.ignored && !n.workaround && (n.status >= 500 || (p.network4xx === 'fail' && n.status >= 400)))
      .map(n => ({ rule: p.network, text: `${n.method} ${n.request.replace(/\?.*$/, '')} ${n.status}` })),
    ...(t.consoleErrors ?? []).slice(marks.con).filter(c => !c.ignored && !c.workaround && c.type === 'pageerror')
      .map(c => ({ rule: p.pageErrors, text: `uncaught exception: ${c.text.split('\n')[0].slice(0, 200)}` })),
    ...(t.consoleErrors ?? []).slice(marks.con).filter(c => !c.ignored && !c.workaround && c.type === 'error')
      .map(c => ({ rule: p.console, text: `console error: ${c.text.split('\n')[0].slice(0, 200)}` })),
  ];
  const fatal = fresh.find(f => f.rule === 'fail');
  if (fatal) throw new Error(`the app showed an error: ${fatal.text}`);
  if (fresh.length) warnings.push(...fresh.slice(0, 5).map(f => f.text));
}

/** Thrown at --until-step: the requested part of the run is done. */
export class StopRun extends Error {}

/**
 * unpaced: off camera (login, setup), as fast as possible, not counted by --from-step / --until-step. offCamera: a
 * scene with "camera": false: as fast as possible, but its steps are the tour's (counted, reported as off camera). A
 * step with "camera": false inside a filmed scene runs unpaced and its time is cut from the video.
 */
export async function runSteps(t, steps, { baseUrl, onError = 'fail', unpaced = false, offCamera = false, timeouts, report, scene, ready, errors, criteria = [], retries = 1, range, allowMocks, outDir } = {}) {
  const paced = unpaced || offCamera || steps.some(s => 'at' in s);
  const actions = steps.filter(s => !['at', 'wait', 'waitFor'].includes(actionOf(s)) && s.camera !== false);
  let i = 0;
  for (const step of steps) {
    const a = actionOf(step);
    const hidden = offCamera || step.camera === false;
    // --from-step / --until-step count scene steps across the whole tour (1-based, as in report.md's order).
    if (range && !unpaced) {
      range.n++;
      if (range.until && range.n > range.until) throw new StopRun(`stopped before step ${range.n} (--until-step ${range.until})`);
    }
    const fastForward = range?.from && range.n < range.from;
    if (!paced && !fastForward && !hidden && !['at', 'wait', 'waitFor'].includes(a)) {
      await t.at(actions.length > 1 ? 0.05 + (0.75 * i) / (actions.length - 1) : 0.1);
      i++;
    }
    const index = steps.indexOf(step) + 1;
    // A check (verify) tests the app; anything else is the script driving it. Checks carry the acceptance criteria
    // they cover: the step's own "criterion" (e.g. "AC2" or 2), else the scene's "criteria".
    const kind = a === 'verify' ? 'check' : 'action';
    const covers = kind === 'check' || a === 'code' ? [step.criterion ?? criteria].flat().filter(c => c !== undefined && c !== '').map(String) : [];
    const started = Date.now();
    const entry = { scene, step: index, action: a, kind, ...(covers.length && kind === 'check' ? { criteria: covers } : {}), spec: shown(step),
      ...(step.from ? { from: step.from } : {}), ...(step.scriptStep ? { scriptStep: step.scriptStep } : {}), ...(step.knownIssue ? { knownIssue: step.knownIssue } : {}),
      ...(hidden && !unpaced ? { offCamera: true } : {}), ...(t.account ? { account: t.account } : {}) };
    // An off-camera step in a filmed scene: its time is cut from the video, and the narration's pacing skips it.
    const offStart = step.camera === false && !offCamera && t.current ? t.now() : null;
    const warnings = [];
    // Attribution: browser errors and failing requests from now on belong to this step.
    t.stepKey = `${scene ?? 'setup'}#${index}`;
    t.stepScript = step.scriptStep ?? null;
    t.stepLabel = `${a} ${JSON.stringify(shown(step)[a] ?? '').slice(0, 60)}`;
    const marks = { net: t.networkFailures?.length ?? 0, con: t.consoleErrors?.length ?? 0 };
    t.stepWarnings = warnings;
    try {
      // A known issue already on screen (a popup left by the previous step, or by the page loading) goes first.
      await t.workarounds?.checkpoint(t, { warnings });
      // Rule-based retries for actions only (timeouts, elements not there yet). A failed check is never retried.
      for (let attempt = 0; ; attempt++) {
        try {
          await runStep(t, step, { baseUrl, timeouts, ready, errors, warnings, allowMocks, outDir });
          appErrorPolicy(t, marks, entry, warnings);
          break;
        } catch (e) {
          // Never retried: checks, code steps, and steps whose effect may already have happened.
          if (kind === 'check' || ['code', 'mock', 'download', 'dialog', 'signInAs'].includes(a) || step.waitForResponse !== undefined || step.opensPopup || e.failure || attempt >= (step.retries ?? retries) || !/Timeout|not found|not visible|detached/i.test(e.message)) throw e;
          log(`${scene ?? 'setup'} step ${index}: retrying (${e.message.split('\n')[0]})`);
          await settle(t.page, ready);
          entry.retried = attempt + 1;
        }
      }
      report?.push({ ...entry, ok: true, ms: Date.now() - started, url: t.page.url(), ...(warnings.length ? { warnings } : {}) });
    } catch (e) {
      const message = e.message.split('\n')[0];
      const target = targetOf(step);
      const suggestions = target ? await suggest(t.page, target) : [];
      // The app's own error UI (tour "errors") during a step is an APP failure, whatever the step.
      const failure = /^the app showed an error/.test(message) ? 'app' : e.failure ?? (kind === 'check' ? 'criterion' : 'script');
      // A code step that failed its ctx.check() counts as a check of the criteria it covers.
      if (failure === 'criterion' && kind !== 'check') Object.assign(entry, { kind: 'check', ...(covers.length ? { criteria: covers } : {}) });
      if (e.workaround) entry.workaround = e.workaround;
      Object.assign(entry, { ok: false, failure, optional: !!step.optional, error: message, url: t.page.url(), ms: Date.now() - started, ...(warnings.length ? { warnings } : {}),
        ...(target && failure !== 'app' ? { expected: target, found: suggestions.length ? `closest on the page: ${suggestions.join(' | ')}` : 'nothing similar on the page' } : {}),
        suggestions });
      report?.push(entry);
      const hint = suggestions.length ? ` (did you mean ${suggestions.map(x => JSON.stringify(x)).join(', ')}?)` : '';
      // collect (dry run): report everything and carry on. Otherwise a failed "verify" always stops the run (it's an
      // acceptance check) unless that step is marked optional.
      // A step marked as a known app issue fails as expected: reported, and the run carries on.
      if (step.knownIssue && onError !== 'collect') log(`${scene ?? 'setup'} step ${index}: known app issue${step.knownIssue.ticket ? ` ${step.knownIssue.ticket}` : ''}, failed as expected: ${message}`);
      else if (onError === 'collect' || step.optional || (onError === 'skip' && a !== 'verify'))
        log(`${scene ?? 'setup'} step ${index} ${onError === 'collect' ? 'FAILED' : 'skipped'}: ${message}${hint}`);
      else throw Object.assign(new StepError(`${failure === 'criterion' ? `CRITERION${entry.criteria?.length ? ` ${entry.criteria.join(', ')}` : ''} not met` : failure === 'app' ? 'APP error' : 'SCRIPT failure'}: ${scene ?? 'setup'} step ${index}${step.from ? ` (fragment ${step.from})` : ''} ${JSON.stringify(shown(step))}: ${message}${hint}`), { failure, entry });
    }
    if (offStart !== null && t.current) {
      const end = t.now();
      t.markWait?.('offCamera', offStart, end);
      t.current.shift = (t.current.shift ?? 0) + (end - offStart);
    }
  }
}

/** A step that couldn't be done; the CLI maps it to exit code 2. */
export class StepError extends Error {}

const targetOf = step => step[actionOf(step)] && !['goto', 'code', 'press', 'dialog', 'switchTo', 'mock', 'waitForResponse', 'wait', 'at', 'pin'].includes(actionOf(step)) && typeof step[actionOf(step)] !== 'number' ? step[actionOf(step)] : null;
const targetText = t => (typeof t === 'string' ? t.replace(/^css=/, '') : t.name ?? t.label ?? t.placeholder ?? t.text ?? t.alt ?? t.testId ?? t.css ?? '');

/** Edit distance (optimal string alignment: a swapped pair of letters is one edit), for closest-match suggestions. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
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
