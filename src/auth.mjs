// Saved logins (Playwright storageState), one file per target and role: auth/<target>/<role>.json (git-ignored).
// `aft login` creates it, either by running the tour's login steps (credentials from env vars / .env only) or, with
// --manual, by opening a real browser window for SSO/MFA and saving the state once you've logged in by hand.
// Tours load the file, so credentials are never typed on camera and login isn't repeated every run.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';
import { Failure } from './failures.mjs';
import { plainActor, runSteps } from './steps.mjs';
import { log } from './util.mjs';
import { Workarounds } from './workarounds.mjs';

const SAFE = /^[A-Za-z0-9_-]+$/;

export function authFile(toolRoot, target, role = 'default') {
  if (!SAFE.test(target) || !SAFE.test(role)) throw new Error(`Target and role names must match ${SAFE} (got "${target}", "${role}")`);
  return path.join(toolRoot, 'auth', target, `${role}.json`);
}

/** Logs in and saves storageState to file. Returns file. */
export async function saveLogin({ baseUrl, steps, file, manual = false, viewport, timeouts, ready, ignoreHTTPSErrors, failureShot, signedIn, workarounds }) {
  if (!manual && !steps?.length) throw new Error('No login steps in the tour; add "login": { "steps": [...] } or use --manual');
  const browser = await chromium.launch({ headless: !manual });
  try {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors });
    const page = await context.newPage();
    await page.goto(baseUrl);
    if (manual) {
      log('Log in in the browser window (SSO, MFA…), then press Enter here.');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(r => rl.question('', () => { rl.close(); r(); }));
    } else {
      try {
        // Known issues apply off camera too (a popup on the sign-in page), but are only logged here.
        const wa = workarounds?.length ? new Workarounds(workarounds, { baseUrl, timeouts, ready, log }) : undefined;
        await runSteps(plainActor(page, { workarounds: wa }), steps, { baseUrl, unpaced: true, timeouts, ready });
        if (signedIn) await page.locator(signedIn).first().waitFor({ timeout: timeouts?.waitFor ?? 30000 });
      } catch (e) {
        if (failureShot) await page.screenshot({ path: failureShot }).catch(() => {});
        const sso = !/^https?:\/\/(localhost|127\.)/.test(page.url()) && new URL(page.url()).host !== new URL(baseUrl).host;
        throw new Failure('login', `sign-in failed at ${page.url()}: ${e.message.split('\n')[0].replace(/^SCRIPT failure: /, '')}${sso ? ' (redirected to another site: SSO? use aft login --manual)' : ''}`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await context.storageState({ path: file });
    log(`saved login: ${file}`);
    return file;
  } finally {
    await browser.close();
  }
}
