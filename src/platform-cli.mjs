// `aft platform <list|init|discover|check> [name]`: onboarding a platform (see AGENTS.md, "Platforms").
//
//   aft platform list                              the platforms and their environments
//   aft platform init <name> [--base-url <url>]    scaffold platforms/<name>/ (never overwrites)
//   aft platform discover <name> [--target <env>]  crawl the app as the platform's role sees it → discovery.json
//   aft platform check <name> [--target <env>]     doctor + settings + reachability + login + smoke tour, in that
//                                                  order; passing in an environment means the platform is ready there

import fs from 'node:fs';
import path from 'node:path';
import { doctor } from './doctor.mjs';
import { envNames, initPlatform, listPlatforms, loadPlatform, platformsDir } from './platform.mjs';
import { probe } from './recorder.mjs';
import { log } from './util.mjs';

export async function platformCommand(args, { toolRoot, commands, appSettings, UsageError, envOf }) {
  const [, sub, name] = args._;
  const root = platformsDir(toolRoot, process.cwd());
  const need = () => { if (!name) throw new UsageError(`Usage: aft platform ${sub} <name>  (platforms: ${listPlatforms(root).join(', ') || 'none'})`); };
  switch (sub) {
    case 'list':
    case undefined: {
      const list = [];
      for (const n of listPlatforms(root)) {
        let p;
        try { p = loadPlatform(toolRoot, n, { from: root }); } catch (e) {
          list.push({ name: n, error: e.message.split('\n')[0] });
          console.log(`${n.padEnd(16)} (broken: ${e.message.split('\n')[0]})`);
          continue;
        }
        const envs = envNames(p).map(e => (e === p.defaultEnv ? `${e}*` : e)).join(', ') || '-';
        const roles = Object.keys(p.login?.roles ?? {}).join(', ') || '-';
        const tours = fs.existsSync(path.join(p.dir, 'tours')) ? fs.readdirSync(path.join(p.dir, 'tours')).filter(f => /\.tour\.(json|mjs)$/.test(f)).length : 0;
        console.log(`${n.padEnd(16)} environments: ${envs.padEnd(18)} roles: ${roles.padEnd(12)} tours: ${tours}`);
        list.push({ name: n, dir: p.dir, environments: envNames(p), defaultEnv: p.defaultEnv ?? null, roles: Object.keys(p.login?.roles ?? {}), tours });
      }
      console.log(`\n(${root}; * = default environment)`);
      return { root, platforms: list };
    }
    case 'init': {
      need();
      const dir = initPlatform(root, name, { baseUrl: args.baseUrl });
      log(`created ${dir}`);
      log(`next: edit environments.json (baseUrl) and login.json, then  aft platform check ${name}`);
      return { dir };
    }
    case 'discover': {
      need();
      const app = appSettings({ ...args, platform: name });
      if (!app.cfg.baseUrl) throw new UsageError(`${name}: no baseUrl for environment ${app.env ?? '(none)'}`);
      const url = new URL(app.cfg.startPath ?? '', app.cfg.baseUrl.replace(/\/?$/, '/')).href;
      return commands.discover({ ...args, platform: name, name: args.name ?? `${name}-discover`, _: ['discover', url] });
    }
    case 'check': return check(name, args, { toolRoot, commands, appSettings, UsageError, envOf, need });
    default: throw new UsageError(`Unknown: aft platform ${sub} (list, init, discover, check)`);
  }
}

/** Each stage in order; stops at the first that fails, with the fix. */
async function check(name, args, { toolRoot, commands, appSettings, UsageError, envOf, need }) {
  need();
  const results = [];
  let lastError = null;
  const stage = async (label, fn) => {
    try {
      const detail = await fn();
      results.push({ label, ok: true, detail });
      console.log(` ok   ${label.padEnd(14)} ${detail ?? ''}`);
      return true;
    } catch (e) {
      lastError = e;
      results.push({ label, ok: false, detail: e.message.split('\n')[0] });
      console.log(`FAIL  ${label.padEnd(14)} ${e.message.split('\n').join('\n      ')}`);
      return false;
    }
  };
  let app;
  const steps = [
    ['machine', async () => { if (!(await doctor({ toolRoot, platform: name, quiet: true })).ok) throw new Error(`aft doctor --platform ${name} lists what's missing`); return 'aft doctor passes'; }],
    ['settings', async () => { app = appSettings({ ...args, platform: name }); return `environment ${app.env ?? '(none)'}, role ${app.cfg.login?.role ?? '(no login)'}`; }],
    ['reachable', async () => {
      if (!app.cfg.baseUrl) throw new Error('no baseUrl in environments.json');
      if (app.cfg.launch) return 'has a launch command: the smoke tour starts it if needed';
      if (!(await probe(app.cfg.baseUrl, { any: true }))) throw new Error(`nothing answers at ${app.cfg.baseUrl}; start the app`);
      return app.cfg.baseUrl;
    }],
    ['smoke tour', async () => {
      const smoke = path.join(app.platform.dir, 'tours', 'smoke.tour.json');
      if (!fs.existsSync(smoke)) throw new Error(`no ${smoke}: add a one-scene tour that signs in and shows the home page`);
      // validate signs in first (login stages: saved state, re-login, credentials) and dry-runs every step.
      await commands.validate({ ...args, _: ['validate', smoke], name: `${name}-check` });
      return 'signed in (if the platform has a login) and every step resolved';
    }],
  ];
  for (const [label, fn] of steps) if (!(await stage(label, fn))) break;
  const ok = results.length === steps.length && results.every(r => r.ok);
  console.log(ok ? `\n${name} is ready${envOf(args) ? ` in ${envOf(args)}` : app?.env ? ` in ${app.env}` : ''}.` : `\n${name} is not ready.`);
  // A failed smoke run keeps its own class and exit code (LOGIN 6, UNREACHABLE 3, SCRIPT 2...).
  if (!ok && lastError && lastError.constructor !== Error) throw lastError;
  if (!ok) process.exitCode = process.exitCode || 1;
  return { ok, results };
}
