// `aft doctor`: checks what this machine has, says how to fix what's missing, and exits non-zero if anything the
// engine needs is missing. Targets add their own checks with an optional targets/<app>/requirements.mjs:
//
//   export default async function requirements({ add, which, run, version, toolRoot }) {
//     add('My app: Java 21', ok, detail, 'how to fix', /* required for this target */ true);
//   }
//
// Target checks are advisory unless --target <app> names that target (then its required items count).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { listVoices } from './tts.mjs';
import { run, which } from './util.mjs';

const win = process.platform === 'win32';

async function version(cmd, args = ['--version']) {
  try { return (await run(cmd, args, { capture: true })).split(/\r?\n/)[0].trim(); } catch { return null; }
}

export async function doctor({ toolRoot, target } = {}) {
  const checks = [];
  const add = (name, ok, detail, fix, required = true, group = 'engine') => checks.push({ name, ok: !!ok, detail, fix, required, group });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js 22+', major >= 22, `node ${process.version}`, 'winget install OpenJS.NodeJS.LTS (or nvm / your package manager)');
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const v = which(tool) && await version(tool, ['-version']);
    add(tool, v, v ?? 'not on PATH', win ? 'winget install Gyan.FFmpeg' : 'apt install ffmpeg / brew install ffmpeg');
  }
  add('npm packages', fs.existsSync(path.join(toolRoot, 'node_modules', 'playwright')), 'node_modules/playwright', `cd "${toolRoot}" && npm ci`);
  let browser = null;
  try { browser = chromium.executablePath(); } catch { /* not installed */ }
  add('Playwright Chromium', browser && fs.existsSync(browser), browser ?? 'missing', `npx playwright install chromium${win ? '' : ' --with-deps'}`);
  if (win) {
    let voices = [];
    try { voices = await listVoices(); } catch { /* no SAPI */ }
    add('Speech: Windows SAPI', voices.length, voices.length ? voices.join(', ') : 'no voices',
      'Settings > Time & language > Speech > add a voice; or --speech silent', false);
  } else {
    add('Speech', true, 'no voice provider on this OS yet: use --speech silent (captions carry the narration)', '', false);
  }
  const claude = which('claude') && await version('claude');
  add('claude CLI (generate/plan --llm claude)', claude, claude ?? 'not on PATH', 'install Claude Code: https://claude.com/claude-code', false);

  const targetsDir = path.join(toolRoot, 'targets');
  for (const app of fs.existsSync(targetsDir) ? fs.readdirSync(targetsDir) : []) {
    const file = path.join(targetsDir, app, 'requirements.mjs');
    if (!fs.existsSync(file) || (target && target !== app)) continue;
    const strict = target === app;
    const hook = (await import(pathToFileURL(file).href)).default;
    await hook({ add: (n, ok, d, fix, required = true) => add(`${app}: ${n}`, ok, d, fix, strict && required, app), which, run, version, toolRoot });
  }

  for (const c of checks)
    console.log(`${c.ok ? ' ok ' : c.required ? 'MISS' : 'warn'}  ${c.name.padEnd(46)} ${c.detail ?? ''}${!c.ok && c.fix ? `\n      fix: ${c.fix}` : ''}`);
  const missing = checks.filter(c => c.required && !c.ok);
  console.log(missing.length ? `\n${missing.length} required item(s) missing.` : '\nAll required items present.');
  return missing.length === 0;
}
