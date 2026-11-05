// Recording by hand (codegen-like): what a person does in the live browser becomes tour steps. Used by the stage and
// session daemons (ops record-start / record-steps / record-stop) and so by `aft converse <run> --record N`.
//
// In the page (an init script, so it survives navigation; the same pattern as the recorder's cursor), capture-phase
// listeners report clicks, double clicks, changes (checkbox, radio, select), typed fields (one fill per field, sent on
// blur or Enter), Enter / Escape outside a text field, with a description of the element. The element is marked
// (data-aft-cap) so the Node side can pick the best locator while it still exists: role + name (from Playwright's
// ARIA snapshot of the element) → label → placeholder → text → testId → the same inside a named container ("within")
// → nth → CSS, keeping the first that resolves to exactly that element with the engine's own resolver
// (src/steps.mjs candidates / scope). CSS and nth are marked weak. A top-level navigation not caused by a click or a
// key becomes a goto (relative to the base URL). Password fields become "secret": true with {data.<name>} (the value
// is never written) and a missing-data note. A new id in the URL after a click suggests a pin.

import fs from 'node:fs';
import path from 'node:path';
import { candidates, scope } from './steps.mjs';

const BINDING = '__aftCapture';
const bound = new WeakSet();

/** In-page: report what the person does. Runs in every document of the context. */
function pageScript() {
  if (window.__aftCapInstalled) return;
  window.__aftCapInstalled = true;
  let n = 0;
  const send = (kind, el, extra = {}) => {
    if (typeof window.__aftCapture !== 'function' || !el || el.nodeType !== 1) return;
    const id = `${Date.now().toString(36)}-${++n}`;
    el.setAttribute('data-aft-cap', id);
    const text = s => String(s ?? '').replace(/\s+/g, ' ').trim();
    const labelOf = e => {
      if (e.getAttribute('aria-label')) return text(e.getAttribute('aria-label'));
      const by = e.getAttribute('aria-labelledby');
      if (by) return text(by.split(/\s+/).map(i => document.getElementById(i)?.innerText ?? '').join(' '));
      if (e.id) { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l) return text(l.innerText); }
      const wrap = e.closest('label');
      return wrap ? text(wrap.innerText) : '';
    };
    const container = (() => {
      const c = el.parentElement?.closest('[role=row],[role=dialog],[role=region],[role=listitem],[role=group],[role=tabpanel],[role=form],tr,li,dialog,form,section,article,fieldset');
      if (!c) return null;
      const role = c.getAttribute('role') ?? ({ tr: 'row', li: 'listitem', dialog: 'dialog', form: 'form', section: 'region', article: 'article', fieldset: 'group' })[c.tagName.toLowerCase()];
      const name = c.getAttribute('aria-label') ?? c.querySelector('legend,h1,h2,h3,h4,caption')?.innerText ?? '';
      return { role, name: text(name).slice(0, 60), text: text(c.innerText).slice(0, 60) };
    })();
    // The implicit ARIA role of common elements: the fallback when the element is gone before Node can ask.
    function implicit(e) {
      const tag = e.tagName.toLowerCase(), type = (e.getAttribute('type') ?? '').toLowerCase();
      if (tag === 'a' && e.hasAttribute('href')) return 'link';
      if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
      if (tag === 'input' && type === 'checkbox') return 'checkbox';
      if (tag === 'input' && type === 'radio') return 'radio';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea' || (tag === 'input' && !['hidden', 'file', 'range', 'color'].includes(type))) return 'textbox';
      if (tag === 'summary') return 'button';
      return null;
    }
    const cssPath = (() => {
      const parts = [];
      for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
        if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
        const tag = e.tagName.toLowerCase();
        const sib = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
        parts.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(e) + 1})` : tag);
      }
      return parts.join(' > ');
    })();
    window.__aftCapture({ kind, id, url: location.href, at: Date.now(),
      el: { tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), role: el.getAttribute('role') ?? implicit(el), name: el.getAttribute('name'),
        label: labelOf(el), placeholder: el.getAttribute('placeholder'), testId: el.getAttribute('data-testid'), text: text(el.innerText ?? '').slice(0, 80),
        title: el.getAttribute('title'), container, css: cssPath }, ...extra });
  };
  const field = e => e && (e.tagName === 'TEXTAREA' || e.isContentEditable || (e.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(e.type)));
  const toggle = e => e?.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type);
  const dirty = new Map();
  const flush = el => { if (dirty.has(el)) { dirty.delete(el); send('fill', el, { value: el.isContentEditable ? el.innerText : el.value, secret: el.type === 'password' }); } };
  const clickable = e => e.closest('button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=treeitem],summary,label,input,select,textarea') ?? e;
  document.addEventListener('input', e => { if (field(e.target)) dirty.set(e.target, true); }, true);
  document.addEventListener('focusout', e => flush(e.target), true);
  document.addEventListener('change', e => {
    const el = e.target;
    if (toggle(el)) send(el.checked ? 'check' : 'uncheck', el);
    else if (el.tagName === 'SELECT') send('select', el, { option: [...el.selectedOptions].map(o => text2(o.label || o.text)) });
    else if (field(el)) flush(el);
  }, true);
  const text2 = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  document.addEventListener('click', e => {
    const el = clickable(e.target);
    if (toggle(el) || (el.tagName === 'LABEL' && toggle(el.control))) return;   // the change event says check/uncheck
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    for (const d of [...dirty.keys()]) if (d !== el) flush(d);
    send(e.detail === 2 ? 'dblclick' : 'click', el, e.button === 2 ? { button: 'right' } : {});
  }, true);
  document.addEventListener('contextmenu', e => send('rightClick', clickable(e.target)), true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab') return;
    const el = e.target;
    if (field(el)) { flush(el); if (e.key === 'Tab') return; if (el.tagName === 'TEXTAREA' && e.key === 'Enter') return; }
    else if (e.key === 'Tab') return;
    send('press', el, { key: e.key, inField: field(el) });
  }, true);
}

/** First line of an element's ARIA snapshot → { role, name }. */
export function ariaRole(snapshot) {
  const m = String(snapshot ?? '').split('\n')[0].match(/^- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/);
  return m ? { role: m[1], name: m[2]?.replace(/\\"/g, '"') ?? '' } : null;
}

const WEAK = t => typeof t === 'object' && (t.css || t.nth !== undefined);

/** Locator targets to try for an element, best first. */
export function targetsFor(el, aria) {
  const out = [];
  const name = aria?.name || el.label || '';
  if (aria?.role && !['generic', 'text', 'paragraph', 'none', 'presentation'].includes(aria.role) && name) out.push({ role: aria.role, name });
  if (el.label) out.push({ label: el.label });
  if (el.placeholder) out.push({ placeholder: el.placeholder });
  if (el.testId) out.push({ testId: el.testId });
  // The same name inside its named container (a row, a dialog, a region) before any text match or index.
  const c = el.container;
  if (c?.role) {
    const within = c.name ? { role: c.role, name: c.name } : c.text ? { role: c.role, hasText: c.text.slice(0, 40) } : null;
    if (within) for (const t of out.slice(0, 2)) out.push({ ...t, within });
  }
  if (el.text && el.text.length <= 60 && !['input', 'textarea', 'select'].includes(el.tag)) out.push({ text: el.text, exact: true });
  if (out[0]) for (let i = 0; i < 6; i++) out.push({ ...out[0], nth: i });
  if (el.css) out.push({ css: el.css });
  return out;
}

/** The first target that the engine resolves to exactly the marked element (by the marker id), or null. */
export async function bestTarget(page, el, id) {
  const marked = page.locator(`[data-aft-cap="${id}"]`);
  if (!(await marked.count().catch(() => 0))) return null;
  const aria = ariaRole(await marked.first().ariaSnapshot({ timeout: 1000 }).catch(() => ''));
  for (const target of targetsFor(el, aria)) {
    try {
      const { root, target: inner } = await scope(page, target, { timeout: 500 });
      const loc = candidates(root, inner)[0];
      const n = await loc.count();
      const visible = [];
      for (let i = 0; i < Math.min(n, 10); i++) if (await loc.nth(i).isVisible().catch(() => false)) visible.push(i);
      const pick = typeof target === 'object' && target.nth !== undefined ? (visible.includes(target.nth) ? target.nth : -1) : visible.length === 1 ? visible[0] : -1;
      if (pick < 0) continue;
      if (await loc.nth(pick).getAttribute('data-aft-cap').catch(() => null) === id) return { target, weak: WEAK(target) };
    } catch { /* this strategy doesn't apply here */ }
  }
  return null;
}

/** When the element is gone before it could be checked (it was removed by the click): the best guess, unverified. */
export function guessTarget(el) {
  const t = targetsFor(el, el.role ? { role: el.role, name: el.label || el.text || el.title || '' } : null)[0] ?? { css: el.css };
  return { target: t, weak: true, unverified: true };
}

const short = t => (typeof t === 'object' && t && Object.keys(t).length === 2 && t.role && t.name && !t.exact ? t : t);
const keyName = s => String(s ?? 'value').replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, c => c.toLowerCase()) || 'value';

/** Raw events → steps (with notes). */
export function toStep(ev) {
  const target = short(ev.target);
  switch (ev.kind) {
    case 'fill': return ev.secret ? { fill: target, text: `{data.${keyName(ev.el.name || ev.el.label || 'password')}}`, secret: true } : { fill: target, text: ev.value ?? '' };
    case 'check': return { check: target };
    case 'uncheck': return { uncheck: target };
    case 'select': return { select: target, option: ev.option?.length === 1 ? ev.option[0] : ev.option };
    case 'press': return ev.inField ? { press: ev.key, on: target } : { press: ev.key };
    case 'goto': return { goto: ev.path };
    case 'rightClick': return { rightClick: target };
    case 'dblclick': return { dblclick: target };
    default: return { click: target, ...(ev.button ? { button: ev.button } : {}) };
  }
}

const sameTarget = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Collapses noise: a click into a field followed by its fill (the fill is enough), repeated fills of one field (the
 * last), two clicks that were a double click (the dblclick), a click on a label just before its field's fill.
 */
export function collapse(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    const s = e.step;
    if (prev && 'fill' in s && 'fill' in prev.step && sameTarget(prev.step.fill, s.fill)) { out[out.length - 1] = e; continue; }
    if (prev && 'fill' in s && 'click' in prev.step && (sameTarget(prev.step.click, s.fill) || prev.el?.tag === 'label' || ['input', 'textarea'].includes(prev.el?.tag))) { out[out.length - 1] = e; continue; }
    if (prev && 'dblclick' in s && 'click' in prev.step && sameTarget(prev.step.click, s.dblclick)) {
      out[out.length - 1] = e;
      const before = out[out.length - 2];
      if (before && 'click' in before.step && sameTarget(before.step.click, s.dblclick)) out.splice(out.length - 2, 1);
      continue;
    }
    if (prev && 'press' in s && s.on && 'press' in prev.step && prev.step.press === s.press && sameTarget(prev.step.on, s.on)) continue;
    out.push(e);
  }
  return out;
}

const NEW_ID = /\/(\d{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[/?#])/i;

/** Records what a person does on a page (and pages opened from it later in the same context). */
export class Capture {
  constructor(page, { outDir, baseUrl, mask, log = () => {} } = {}) {
    Object.assign(this, { page, outDir, baseUrl, mask, log });
    this.entries = [];
    this.notes = [];
    this.active = false;
    this.expectNav = null;
    this.queue = Promise.resolve();
    this.stills = [];
  }

  async start() {
    const context = this.page.context();
    if (!bound.has(context)) {
      bound.add(context);
      await context.exposeBinding(BINDING, (src, ev) => { context.__aftCapture?.(src.page, ev); });
      await context.addInitScript(pageScript);
    }
    context.__aftCapture = (page, ev) => {
      if (!this.active || page !== this.page) return;
      // Set at once (the navigation it causes may be reported before the queue gets to this event).
      if (['click', 'dblclick', 'press', 'rightClick'].includes(ev.kind)) this.expectNav = Date.now();
      this.queue = this.queue.then(() => this.onEvent(ev)).catch(e => this.log(`capture: ${e.message}`));
    };
    await this.page.evaluate(pageScript).catch(() => {});
    this.onNav = frame => {
      if (!this.active || frame !== this.page.mainFrame()) return;
      const url = frame.url();
      // The first navigation within a few seconds of a click or a key is its result; any other is a goto.
      const caused = this.expectNav && Date.now() - this.expectNav < 3000;
      this.expectNav = null;
      const prevUrl = this.url;
      this.url = url;
      if (caused) {
        // A click that led to a page with a new record id in the URL: suggest pinning it.
        const m = url.match(NEW_ID);
        if (m && !(prevUrl ?? '').includes(m[1])) this.notes.push({ suggest: { pin: 'newRecord', fields: { id: { capture: { url: true }, pattern: NEW_ID.source } }, comment: 'recorded: a new id in the URL; check it, add "cleanup"' }, after: this.entries.length });
        return;
      }
      this.queue = this.queue.then(() => this.add({ kind: 'goto', path: this.relative(url), url }));
    };
    this.page.on('framenavigated', this.onNav);
    this.url = this.page.url();
    this.active = true;
    this.startedAt = Date.now();
    return { recording: true, url: this.url };
  }

  relative(url) {
    if (!this.baseUrl) return new URL(url).pathname + new URL(url).search + new URL(url).hash;
    const base = new URL(this.baseUrl);
    const u = new URL(url);
    if (u.origin !== base.origin) return url;
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const p = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
    return `${p}${u.search}${u.hash}` || '/';
  }

  async onEvent(ev) {
    const found = await bestTarget(this.page, ev.el, ev.id).catch(() => null) ?? guessTarget(ev.el);
    await this.page.evaluate(id => document.querySelector(`[data-aft-cap="${id}"]`)?.removeAttribute('data-aft-cap'), ev.id).catch(() => {});
    if (ev.secret) this.notes.push({ missingData: keyName(ev.el.name || ev.el.label || 'password'), why: 'a password field: the value is never recorded; give it as data (a fixture or the environment)' });
    await this.add({ ...ev, ...found });
  }

  async add(ev) {
    const step = toStep(ev);
    const e = { step, el: ev.el, weak: !!ev.weak, unverified: !!ev.unverified, url: ev.url ?? this.page.url(), at: Date.now() - this.startedAt };
    this.entries.push(e);
    if (this.outDir) {
      const dir = path.join(this.outDir, 'capture');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `step-${String(this.entries.length).padStart(2, '0')}.png`);
      const mask = (this.mask?.selectors ?? []).map(s => this.page.locator(s));
      // Not awaited here: the next event's element must be resolved while it still exists.
      this.stills.push(this.page.screenshot({ path: file, mask }).then(() => { e.still = file; }, () => {}));
    }
  }

  /** The steps so far, collapsed, with weak/unverified marks and stills. */
  steps() {
    return collapse(this.entries).map(e => ({ step: e.step, ...(e.weak ? { weak: true } : {}), ...(e.unverified ? { unverified: true } : {}), url: e.url, ...(e.still ? { still: e.still } : {}) }));
  }

  dropLast() { this.entries.pop(); return this.steps(); }

  async stop() {
    this.active = false;
    await this.queue;
    await Promise.all(this.stills);
    this.page.off('framenavigated', this.onNav);
    return { steps: this.steps(), notes: this.notes, seconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }
}
