// Workarounds: known app or environment issues, declared once per platform (platform.json "workarounds", refined per
// environment in environments.json), so tours never mention them. When the issue isn't there, nothing happens.
//
//   { "name": "TCM unavailable popup",
//     "when": { "role": "dialog", "hasText": "/TCM/" }       a locator (popup, panel, banner, toast)
//           | { "request": "/api/tcm/", "status": "5xx" }      a failing request (status: 404, "4xx", "5xx", a list; any if omitted)
//           | { "console": "/regex/" },                       a console message or uncaught exception
//     "paths": ["#/case/"],                                  only on pages whose URL contains / matches one of these
//     "do": [ { "click": "Ok" } ] | "tolerate" | "hide",      dismiss it (steps, scoped to the matched element unless
//                                                            "scoped": false), leave it on screen, or hide it with CSS
//     "as": "warn" | "fail" | "silent",                      report it (default) / APP failure / count it only
//     "times": 3, "noWaitAfter": false }                     at most n firings, then a normal error again
//
// The engine calls checkpoint() before every step, on each poll while a step looks for its target or waits for a
// check, after each step (before the app's error UI is checked) and when a click finds its target covered. Playwright's
// page.addLocatorHandler can't be used: it only fires inside Playwright's own actionability checks and expect(), which
// the paced recorder bypasses. Matched elements are marked data-aft-workaround="<name>", so the "errors" UI check skips
// them; request and console rules mark network.json / console.json entries "workaround": "<name>", so appErrors does too.

import { Failure } from './failures.mjs';
import { candidates, runStep, scope } from './steps.mjs';
import { sleep } from './util.mjs';

export const MARK = 'data-aft-workaround';

/** Platform rules, then the environment's: same name = merged over the platform's ("off": true disables it there). */
export function mergeWorkarounds(platformRules = [], envRules = [], envName = null) {
  const out = platformRules.map(r => ({ ...r, source: 'platform' }));
  for (const r of envRules) {
    const i = out.findIndex(x => x.name === r.name);
    const source = `env:${envName ?? 'default'}`;
    if (i >= 0) out[i] = { ...out[i], ...r, source };
    else out.push({ ...r, source });
  }
  return out.filter(r => !r.off);
}

/** Problems with merged rules (a rule needs a "when"; partial environment entries need a platform rule to complete). */
export function workaroundProblems(rules = []) {
  const problems = [];
  for (const r of rules) {
    if (!r.when) problems.push(`workaround "${r.name}" (${r.source ?? 'platform'}) has no "when"${r.source?.startsWith('env:') ? ' (and no platform rule of that name to complete it)' : ''}`);
    if (Array.isArray(r.do) && !r.do.length) problems.push(`workaround "${r.name}": "do" is an empty list`);
  }
  return problems;
}

const kindOf = when => (when && typeof when === 'object' && 'request' in when ? 'request' : when && typeof when === 'object' && 'console' in when ? 'console' : 'locator');

const matcher = pat => {
  const m = String(pat).match(/^\/(.+)\/([dgimsuy]*)$/);
  if (m) { const re = new RegExp(m[1], m[2].replace('g', '')); return s => re.test(String(s ?? '')); }
  return s => String(s ?? '').includes(pat);
};

const statusMatches = (want, got) => {
  if (want === undefined) return true;
  if (got === undefined || got === null) return false;
  return [want].flat().some(w => (/^\dxx$/i.test(String(w)) ? String(got)[0] === String(w)[0] : Number(w) === Number(got)));
};

export class Workarounds {
  /** ctx: { baseUrl, timeouts, ready, log } for the steps a workaround runs. */
  constructor(rules = [], ctx = {}) {
    this.rules = rules.map(r => ({ do: 'tolerate', as: 'warn', ...r, kind: kindOf(r.when), fired: 0, onPath: r.paths?.length ? r.paths.map(matcher) : null }));
    this.ctx = ctx;
    this.firings = [];
    this.busy = false;
  }

  get any() { return this.rules.length > 0; }

  /** For report.json: every rule in effect and where it came from. */
  summary() { return this.rules.map(r => ({ name: r.name, source: r.source ?? 'platform', when: r.kind, do: Array.isArray(r.do) ? 'steps' : r.do, as: r.as, fired: r.fired })); }

  active(kind, url) {
    return this.rules.filter(r => r.kind === kind && (r.times === undefined || r.fired < Number(r.times)) && (!r.onPath || r.onPath.some(m => m(url))));
  }

  /** Records a firing (and a warning unless silent); "as": "fail" throws an APP failure naming the issue. */
  fire(t, r, { matched, action, warnings }) {
    r.fired++;
    const firing = { name: r.name, source: r.source ?? 'platform', as: r.as, action, matched: String(matched ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      at: t.now ? +t.now().toFixed(2) : null, scene: t.current?.id ?? null, stepKey: t.stepKey ?? 'setup', url: t.page?.url?.() ?? null };
    this.firings.push(firing);
    this.ctx.log?.(`known issue "${r.name}" (${firing.source}): ${action}${firing.matched ? `: ${firing.matched.slice(0, 80)}` : ''}`);
    if (r.as === 'fail')
      throw new Failure('app', `the app showed an error: known issue "${r.name}" occurred (workaround "as": "fail")${firing.matched ? `: ${firing.matched.slice(0, 160)}` : ''}`, { workaround: r.name });
    if (r.as !== 'silent') warnings?.push(`known issue "${r.name}" (${firing.source}): ${action}${firing.matched ? ` — ${firing.matched.slice(0, 120)}` : ''}`);
    if (action === 'tolerated' || action === 'hidden') t.note?.(`Known issue: ${r.name}`);
    return firing;
  }

  /** A network.json entry: marks it (and fires) when a request rule matches. Returns the rule or null. */
  matchNetwork(t, n, warnings) {
    if (n.workaround) return null;
    const r = this.active('request', n.url ?? t.page?.url?.() ?? '').find(x => matcher(x.when.request)(n.request) && statusMatches(x.when.status, n.status)
      && (!x.when.method || x.when.method === n.method));
    if (!r) return null;
    n.workaround = r.name;
    this.fire(t, r, { matched: `${n.method} ${String(n.request).replace(/\?.*$/, '')} ${n.status ?? n.failure ?? ''}`, action: 'tolerated', warnings });
    return r;
  }

  /** A console.json entry (console error or uncaught exception). */
  matchConsole(t, c, warnings) {
    if (c.workaround) return null;
    const r = this.active('console', c.url ?? t.page?.url?.() ?? '').find(x => matcher(x.when.console)(c.text));
    if (!r) return null;
    c.workaround = r.name;
    this.fire(t, r, { matched: String(c.text).split('\n')[0], action: 'tolerated', warnings });
    return r;
  }

  /** Visible elements a locator rule matches on the page now (newest, i.e. last in the DOM, first). */
  async visible(page, r) {
    const { root, target } = await scope(page, r.when, { timeout: 500 }).catch(() => ({ root: null }));
    if (!root) return [];
    for (const loc of candidates(root, target)) {
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      const out = [];
      for (let i = 0; i < Math.min(n, 20); i++) if (await loc.nth(i).isVisible().catch(() => false)) out.push(loc.nth(i));
      if (out.length) return out.reverse();
    }
    return [];
  }

  /**
   * Looks for every locator rule's UI and deals with it: marks all matches first (so stacked known dialogs don't
   * count as app errors while the newest is being closed), then handles them newest first, waiting for each to close.
   * Returns how many were dismissed (steps or hide). No reentrancy: steps run by a workaround don't trigger workarounds.
   */
  async checkpoint(t, { warnings } = {}) {
    if (this.busy || !this.rules.length || !t.page || t.page.isClosed?.()) return 0;
    const rules = this.active('locator', t.page.url());
    if (!rules.length) return 0;
    this.busy = true;
    let handled = 0;
    const warn = warnings ?? t.stepWarnings;
    try {
      for (let round = 0; round < 10; round++) {
        const found = [];
        for (const r of rules) for (const el of await this.visible(t.page, r)) found.push({ r, el });
        if (!found.length) break;
        for (const f of found) f.order = await f.el.evaluate(e => [...document.querySelectorAll('*')].indexOf(e)).catch(() => -1);
        // Newest first: the last match in DOM order is normally the dialog on top.
        const order = [...found].sort((a, b) => b.order - a.order);
        const budget = r => r.times === undefined || r.fired < Number(r.times);
        // Tolerated UI: fired once per element (it stays marked, so the error-UI check skips it), never dismissed. Once
        // "times" is used up, further elements aren't marked: they are normal errors again.
        for (const f of order.filter(x => x.r.do === 'tolerate')) {
          const seen = await f.el.evaluate((e, k) => e.hasAttribute(k), MARK).catch(() => true);
          if (seen || !budget(f.r)) continue;
          await f.el.evaluate((e, [k, v]) => e.setAttribute(k, v), [MARK, f.r.name]).catch(() => {});
          this.fire(t, f.r, { matched: await f.el.innerText().catch(() => ''), action: 'tolerated', warnings: warn });
        }
        // UI to dismiss: all marked first, so stacked known dialogs don't count as app errors while the newest closes.
        const toHandle = order.filter(x => x.r.do !== 'tolerate' && budget(x.r));
        for (const f of toHandle) await f.el.evaluate((e, [k, v]) => e.setAttribute(k, v), [MARK, f.r.name]).catch(() => {});
        const next = toHandle[0] ?? null;
        if (!next) break;
        const { r, el } = next;
        const text = await el.innerText().catch(() => '');
        const started = t.now?.();
        if (r.do === 'hide') {
          this.fire(t, r, { matched: text, action: 'hidden', warnings: warn });
          await el.evaluate(e => e.style.setProperty('display', 'none', 'important')).catch(() => {});
        } else {
          this.fire(t, r, { matched: text, action: 'dismissed', warnings: warn });
          const ctx = this.ctx;
          for (const [i, step] of r.do.entries()) {
            try {
              await runStep(t, step, { baseUrl: ctx.baseUrl, timeouts: ctx.timeouts ?? {}, ready: ctx.ready, warnings: [], bare: true, root: r.scoped === false ? undefined : el });
            } catch (e) {
              throw new Failure('script', `workaround "${r.name}" step ${i + 1} ${JSON.stringify(step)} failed: ${e.message.split('\n')[0]}`, { workaround: r.name });
            }
          }
          if (!r.noWaitAfter) {
            const until = Date.now() + Number(ctx.timeouts?.action ?? 10000);
            while (await el.isVisible().catch(() => false)) {
              if (Date.now() > until) throw new Failure('script', `workaround "${r.name}": its UI is still visible after its steps (add the step that closes it, or "noWaitAfter": true)`, { workaround: r.name });
              await sleep(200);
            }
          }
        }
        handled++;
        if (started !== undefined) t.markWait?.('workaround', started, t.now());
      }
    } finally {
      this.busy = false;
    }
    return handled;
  }
}
