// Recording by hand (src/capture.mjs): a fixture page; Playwright plays the person (real input events), the capture
// turns them into steps: role + name, labels, a checkbox scoped to its row, duplicates, a password, navigation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { ariaRole, Capture, collapse } from '../src/capture.mjs';

const ORIGIN = 'http://capture.test';
const PAGES = {
  '/form': `<h1>Form</h1>
    <label>Name <input id="name"></label>
    <label>Password <input type="password" name="password"></label>
    <label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
    <table><tr><td>Alpha</td><td><input type="checkbox" aria-label="Done"></td></tr><tr><td>Beta</td><td><input type="checkbox" aria-label="Done"></td></tr></table>
    <section aria-label="Panel A"><button>Open</button></section><section aria-label="Panel B"><button>Open</button></section>
    <button id="save" onclick="document.getElementById('out').textContent='Saved'">Save</button><p id="out"></p>
    <a href="/next">Next page</a>`,
  '/next': '<h1>Next</h1><p>Here</p>',
};

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function open() {
  const context = await browser.newContext();
  await context.route(`${ORIGIN}/**`, route => {
    const p = new URL(route.request().url()).pathname;
    return PAGES[p] ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>${p}</title></head><body>${PAGES[p]}</body></html>` }) : route.fulfill({ status: 404, body: '' });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/form`);
  return { context, page };
}

describe('capture', { timeout: 120000 }, () => {
  test('person\'s actions → steps', async () => {
    const { context, page } = await open();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-cap-'));
    const cap = new Capture(page, { outDir, baseUrl: `${ORIGIN}/` });
    await cap.start();
    await page.getByLabel('Name').click();
    await page.getByLabel('Name').pressSequentially('Ann');
    await page.getByLabel('Password').fill('hunter2');
    await page.getByLabel('Password').press('Tab');
    await page.getByLabel('Size').selectOption('Large');
    await page.waitForTimeout(200);
    await page.getByRole('row', { name: /Beta/ }).getByRole('checkbox').check();
    await page.waitForTimeout(200);
    await page.getByRole('region', { name: 'Panel B' }).getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(200);
    await page.getByRole('link', { name: 'Next page' }).click();
    await page.waitForURL('**/next');
    await page.waitForTimeout(300);
    await page.goto(`${ORIGIN}/form`);   // a navigation the person typed: a goto
    await page.waitForTimeout(500);
    const r = await cap.stop();
    const steps = r.steps.map(s => s.step);
    const has = s => steps.some(x => JSON.stringify(x) === JSON.stringify(s));
    assert.ok(has({ fill: { label: 'Name' }, text: 'Ann' }) || has({ fill: { role: 'textbox', name: 'Name' }, text: 'Ann' }), JSON.stringify(steps));
    assert.ok(!steps.some(x => 'click' in x && JSON.stringify(x.click).includes('Name')), 'the click into the field is folded into its fill');
    const pw = steps.find(x => x.secret);
    assert.ok(pw, 'the password is a secret fill');
    assert.equal(pw.text, '{data.password}');
    assert.ok(!JSON.stringify(r).includes('hunter2'), 'the value is never recorded');
    assert.ok(r.notes.some(n => n.missingData === 'password'));
    assert.ok(steps.some(x => x.select && x.option === 'Large'));
    const check = steps.find(x => x.check);
    assert.ok(check?.check.within || check?.check.nth !== undefined, `a duplicate checkbox is scoped: ${JSON.stringify(check)}`);
    const openB = steps.find(x => x.click && JSON.stringify(x.click).includes('Open'));
    assert.ok(openB.click.within ?? openB.click.nth !== undefined, `duplicate "Open" is scoped: ${JSON.stringify(openB)}`);
    if (openB.click.within) assert.equal(openB.click.within.name, 'Panel B');
    assert.ok(has({ click: { role: 'button', name: 'Save' } }));
    assert.ok(has({ click: { role: 'link', name: 'Next page' } }));
    assert.ok(!steps.some(x => x.goto === 'next'), 'a navigation caused by a click is not a goto');
    assert.ok(has({ goto: 'form' }), `a typed navigation is a goto: ${JSON.stringify(steps)}`);
    assert.ok(r.steps.some(s => s.still && fs.existsSync(s.still)), 'a still per step');
    await context.close();
  });

  test('helpers', () => {
    assert.deepEqual(ariaRole('- button "Save \\"it\\""'), { role: 'button', name: 'Save "it"' });
    assert.equal(ariaRole(''), null);
    const t = { label: 'Name' };
    const c = collapse([{ step: { click: t } }, { step: { fill: t, text: 'A' } }, { step: { fill: t, text: 'Ann' } }, { step: { click: 'X' } }, { step: { click: 'X' } }, { step: { dblclick: 'X' } }]);
    assert.deepEqual(c.map(e => e.step), [{ fill: t, text: 'Ann' }, { dblclick: 'X' }]);
  });
});
