// Discovery: crawls an app from a start URL (same origin, breadth first) and records what each screen offers:
// title, headings, navigation, buttons, form fields, tabs and a text excerpt, plus a screenshot. `aft plan` turns
// this into a tour. It only navigates and reads (it never clicks buttons or submits forms), but point it at a demo or
// test instance all the same: some apps change state on GET.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { appError, plainActor, runSteps, settle } from './steps.mjs';
import { log } from './util.mjs';

const SKIP = /log ?out|sign ?out|delete|remove|destroy|unsubscribe|reset|\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|mp[34]|exe)(\?|$)/i;

/** Page key for "already seen": origin + path + hash route, without query noise. */
const keyOf = u => { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, '') + (x.hash.startsWith('#/') ? x.hash : ''); };

function inventory() {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = el => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText.trim(); }
    const wrap = el.closest('label'); if (wrap) return wrap.innerText.trim();
    return el.placeholder || el.name || '';
  };
  const uniq = a => [...new Map(a.filter(x => x.name || x.label).map(x => [JSON.stringify(x), x])).values()];
  const all = sel => [...document.querySelectorAll(sel)].filter(vis);
  const navRoots = all('nav, header, aside, [role=navigation], [role=menubar], [role=tablist]');
  const inNav = el => navRoots.some(n => n.contains(el));
  return {
    title: document.title,
    headings: all('h1, h2, h3, [role=heading]').map(h => ({ level: h.tagName, name: name(h) })).filter(h => h.name).slice(0, 12),
    links: uniq(all('a[href]').map(a => ({ name: name(a), href: a.href, nav: inNav(a) }))).slice(0, 60),
    buttons: uniq(all('button, [role=button], input[type=submit], input[type=button]').map(b => ({ name: name(b) }))).slice(0, 30),
    fields: uniq(all('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select')
      .map(f => ({ label: labelOf(f).replace(/\s+/g, ' ').slice(0, 80), type: f.tagName === 'INPUT' ? f.type : f.tagName.toLowerCase(), placeholder: f.placeholder || undefined }))).slice(0, 25),
    tabs: uniq(all('[role=tab]').map(t => ({ name: name(t) }))).slice(0, 15),
    excerpt: (document.querySelector('main, [role=main]') ?? document.body).innerText.replace(/\s+/g, ' ').trim().slice(0, 600),
  };
}

export async function discover({ url, outDir, maxPages = 12, viewport = { width: 1440, height: 810 }, loginSteps, storageState, include, exclude, ready, ignoreHTTPSErrors, paths = [], errors }) {
  const start = new URL(url);
  const browser = await chromium.launch();
  const pages = [];
  try {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors, ...(storageState ? { storageState } : {}) });
    const page = await context.newPage();
    page.on('dialog', d => d.dismiss());
    if (loginSteps?.length) {
      await page.goto(start.href);
      log('logging in for discovery');
      await runSteps(plainActor(page), loginSteps, { baseUrl: start.href, unpaced: true, ready });
    }
    // Extra start points (screens the story names, which nav links may not reach) are crawled first.
    const queue = [start.href, ...paths.map(p => new URL(p, start.href).href)];
    const seen = new Set();
    fs.mkdirSync(path.join(outDir, 'screens'), { recursive: true });
    while (queue.length && pages.length < maxPages) {
      const next = queue.shift();
      const key = keyOf(next);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await settle(page, ready);
        await page.waitForTimeout(400);
      } catch (e) { log(`skip ${next}: ${e.message.split('\n')[0]}`); continue; }
      const landed = page.url();
      if (new URL(landed).origin !== start.origin) { log(`skip ${next}: left the app (${landed})`); continue; }
      if (keyOf(landed) !== key) { if (seen.has(keyOf(landed))) continue; seen.add(keyOf(landed)); }
      const inv = await page.evaluate(inventory);
      inv.error = await appError(page, errors);
      if (inv.error) log(`page shows an app error: ${inv.error}`);
      const n = String(pages.length + 1).padStart(2, '0');
      const screenshot = path.join('screens', `page-${n}.png`);
      await page.screenshot({ path: path.join(outDir, screenshot) });
      pages.push({ url: landed, path: new URL(landed).pathname + new URL(landed).search + new URL(landed).hash, screenshot, ...inv });
      log(`page ${n}: ${landed}  "${inv.headings[0]?.name ?? inv.title}"  ${inv.buttons.length} buttons, ${inv.fields.length} fields`);
      // Nav links first: they're the app's main screens.
      const links = [...inv.links].sort((a, b) => Number(b.nav) - Number(a.nav));
      for (const l of links) {
        let u;
        try { u = new URL(l.href); } catch { continue; }
        if (u.origin !== start.origin || SKIP.test(u.href) || SKIP.test(l.name)) continue;
        if (include && !new RegExp(include).test(u.href)) continue;
        if (exclude && new RegExp(exclude).test(u.href)) continue;
        if (!seen.has(keyOf(u.href))) queue.push(u.href);
      }
    }
  } finally {
    await browser.close();
  }
  const result = { startUrl: start.href, origin: start.origin, discoveredAt: new Date().toISOString(), pages };
  fs.writeFileSync(path.join(outDir, 'discovery.json'), JSON.stringify(result, null, 2));
  return result;
}
