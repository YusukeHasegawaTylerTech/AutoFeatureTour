// Platforms: everything about one app that isn't a particular tour, in platforms/<name>/:
//
//   platform.json       how the app behaves, the same everywhere it runs:
//                       { "ready", "errors", "appErrors", "ignore": ["<regex>"], "mask", "pronounce", "viewport",
//                         "voice", "ignoreHTTPSErrors", "startPath", "discover", "trace", "retries", "timeouts" }
//   environments.json   where it runs: { "default": "local", "local": { "baseUrl", "launch" | "attach", "timeouts" }, "qa": {...} }
//                       "launch": start the app if nothing answers (see declarative.mjs); "attach": [{ "name", "healthUrl" }]
//                       never starts anything, an environment that isn't up is UNREACHABLE (exit 3)
//   login.json          how to sign in: { "default": "<role>", "signedIn", "checkPath", "maxAgeMinutes",
//                         "roles": { "<role>": { "steps": [...] } } }, credentials only as "{env:NAME}";
//                       saved state: auth/<platform>/<env>/<role>.json
//   fragments/          reusable steps, called from any step list as { "use": "<name>", "with": { ... } }:
//                         <name>.json  { "params": { "<p>": { "required": true } | { "default": v } }, "steps": [...] }
//                                      with "{args.<p>}" in its strings (a string that is only "{args.p}" takes the
//                                      argument's value as is, so a target object can be passed)
//                         <name>.mjs   a code step: export default async ({ page, context, args, ctx }) => { ... }
//   fixtures/           test data a tour needs: <name>.json { "data": { ... }, "setup": [hooks], "teardown": [hooks],
//                       "steps": [...] }; hooks run before the browser starts / after it closes, steps run in the
//                       signed-in browser off camera before the first scene. A tour lists them in "fixtures", and
//                       their data is "{data.<key>}" in its steps
//   requirements.mjs    extra `aft doctor` checks for this platform
//   tours/              the platform's own tours (a smoke.tour.json is what `aft platform check` runs)
//
// A tour names its platform ("platform": "rms") and may pick "env", "role" and "fixtures". It never contains a base
// URL, credentials, launch commands or app-wide settings; those keys are refused so they can't drift into tours.

import fs from 'node:fs';
import path from 'node:path';
import { assertValid, schemaRef } from './schema.mjs';
import { mergeWorkarounds, workaroundProblems } from './workarounds.mjs';

const SAFE = /^[A-Za-z0-9_-]+$/;

export class PlatformError extends Error {}

/** Keys that belong to the platform; a platform tour may not set them. */
export const PLATFORM_KEYS = ['baseUrl', 'environments', 'launch', 'attach', 'login', 'ready', 'errors', 'appErrors', 'ignore', 'mask',
  'ignoreHTTPSErrors', 'startPath', 'discover', 'target'];

/** Where platforms live: AFT_PLATFORMS, else the nearest platforms/ above `from`, else the tool's own. */
export function platformsDir(toolRoot, from) {
  if (process.env.AFT_PLATFORMS) return path.resolve(process.env.AFT_PLATFORMS);
  for (let d = from ? path.resolve(from) : null; d; ) {
    if (path.basename(d) === 'platforms' && fs.existsSync(d)) return d;
    if (fs.existsSync(path.join(d, 'platforms'))) return path.join(d, 'platforms');
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.join(toolRoot, 'platforms');
}

export function listPlatforms(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => SAFE.test(n) && fs.statSync(path.join(dir, n)).isDirectory()) : [];
}

/** Reads a JSON definition file and, with a type, checks it against schemas/<type>.schema.json. */
function readJson(file, fallback, type) {
  if (!fs.existsSync(file)) return fallback;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new PlatformError(`${file}: not valid JSON (${e.message})`); }
  if (type) assertValid(type, doc, file, PlatformError);
  return doc;
}

/** Reads platforms/<name>/ into one object. */
export function loadPlatform(toolRoot, name, { from } = {}) {
  if (!SAFE.test(String(name))) throw new PlatformError(`Platform names must match ${SAFE} (got "${name}")`);
  const root = platformsDir(toolRoot, from);
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) throw new PlatformError(`No platform "${name}" in ${root} (has: ${listPlatforms(root).join(', ') || 'none'}); create one with aft platform init ${name}`);
  const { $schema: _e, ...environments } = readJson(path.join(dir, 'environments.json'), {}, 'environments');
  return {
    name, dir,
    platform: (({ $schema, ...p }) => p)(readJson(path.join(dir, 'platform.json'), {}, 'platform')),
    environments,
    defaultEnv: environments.default ?? Object.keys(environments).find(k => k !== 'default'),
    login: (l => (l ? (({ $schema, ...x }) => x)(l) : null))(readJson(path.join(dir, 'login.json'), null, 'login')),
  };
}

export const envNames = p => Object.keys(p.environments).filter(k => k !== 'default');

/**
 * The settings a run needs for one platform, environment and role, in the shape tour.json used to carry them:
 * platform.json, then the environment over it (timeouts merged), then login for the role.
 */
export function platformConfig(p, { env, role, platformRulesOnly = false } = {}) {
  const envName = env ?? p.defaultEnv;
  const e = envName ? p.environments[envName] : {};
  if (envName && !e) throw new PlatformError(`Platform ${p.name} has no environment "${envName}" (has: ${envNames(p).join(', ') || 'none'})`);
  const { ignore, ...base } = p.platform;
  const cfg = { ...base, ...e, timeouts: { ...base.timeouts, ...e?.timeouts } };
  // Data (credentials, ids): the platform's, then the environment's; a fixture's merges over it in the tour.
  cfg.data = { ...base.data, ...e?.data };
  if (!Object.keys(cfg.data).length) delete cfg.data;
  // Commands in the platform run from the platform's folder, wherever the tour file is.
  if (cfg.launch) cfg.launch = [cfg.launch].flat().map(l => ({ ...l, cwd: path.resolve(p.dir, l.cwd ?? '.') }));
  delete cfg.comment;
  if (ignore?.length) cfg.appErrors = { ...cfg.appErrors, ignore: [...(cfg.appErrors?.ignore ?? []), ...ignore] };
  // Known issues: the platform's, refined by the environment's (by name). A --base-url one-off isn't that
  // environment, so it gets the platform's rules only.
  cfg.workarounds = mergeWorkarounds(base.workarounds, platformRulesOnly ? [] : e?.workarounds, envName);
  const problems = workaroundProblems(cfg.workarounds);
  if (problems.length) throw new PlatformError(`Platform ${p.name}:\n  ${problems.join('\n  ')}`);
  if (!cfg.workarounds.length) delete cfg.workarounds;
  if (p.login) {
    const roleName = role ?? p.login.default ?? Object.keys(p.login.roles ?? {})[0];
    const r = p.login.roles?.[roleName];
    if (!r) throw new PlatformError(`Platform ${p.name} has no login role "${roleName}" (has: ${Object.keys(p.login.roles ?? {}).join(', ') || 'none'})`);
    const { roles, default: _, comment: _c, ...common } = p.login;
    cfg.login = { ...common, ...r, role: roleName };
  }
  return { cfg, env: envName };
}

/** auth/<platform>/<env>/<role>.json */
export function platformAuthFile(toolRoot, platform, env, role = 'default') {
  for (const s of [platform, env ?? 'default', role]) if (!SAFE.test(s)) throw new PlatformError(`Platform, environment and role names must match ${SAFE} (got "${s}")`);
  return path.join(toolRoot, 'auth', platform, env ?? 'default', `${role}.json`);
}

/** Refuses platform settings in a tour that names a platform; absolute URLs anywhere in it too. */
export function checkTour(raw, file) {
  const bad = PLATFORM_KEYS.filter(k => k in raw);
  const problems = bad.map(k => `"${k}" belongs in the platform (platforms/${raw.platform}/), not in a tour`);
  const urls = JSON.stringify(raw.scenes ?? []).match(/https?:\/\/[^"\s]+/g) ?? [];
  if (urls.length) problems.push(`absolute URLs in scenes (${[...new Set(urls)].slice(0, 3).join(', ')}): use paths relative to the environment's baseUrl`);
  if (problems.length) throw new PlatformError(`${file}:\n  ${problems.join('\n  ')}`);
}

// ---- Fragments and fixtures --------------------------------------------------------------------------------------

/** A dotted lookup in vars ("args.target", "data.task"), or undefined. */
const lookup = (vars, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : undefined), vars);

/** Replaces {args.x} / {data.x} in strings. A string that is exactly one placeholder takes its value as is. */
export function substitute(value, vars, prefixes = ['args', 'data']) {
  const re = new RegExp(`\\{((?:${prefixes.join('|')})\\.[A-Za-z0-9_.-]+)\\}`, 'g');
  if (typeof value === 'string') {
    const whole = value.match(new RegExp(`^\\{((?:${prefixes.join('|')})\\.[A-Za-z0-9_.-]+)\\}$`));
    if (whole) { const v = lookup(vars, whole[1]); return v === undefined ? value : v; }
    return value.replace(re, (m, k) => { const v = lookup(vars, k); return v === undefined ? m : typeof v === 'object' ? JSON.stringify(v) : String(v); });
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, vars, prefixes));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars, prefixes)]));
  return value;
}

function fragmentFile(dirs, name) {
  if (!/^[A-Za-z0-9_/-]+(\.(json|mjs))?$/.test(name) || name.includes('..')) throw new PlatformError(`Fragment names must be plain names (got "${name}")`);
  for (const d of dirs) for (const f of /\.(json|mjs)$/.test(name) ? [name] : [`${name}.json`, `${name}.mjs`]) {
    const file = path.join(d, f);
    if (fs.existsSync(file)) return file;
  }
  throw new PlatformError(`No fragment "${name}" (looked in ${dirs.join(', ')})`);
}

/**
 * Expands { "use": name } steps in place (recursively, with a cycle check). JSON fragments become their steps, each
 * marked with "from": "<fragment>"; code fragments become { "code": file, "with": args }. { "code": "x.mjs" } steps
 * are resolved to a file in the same folders. `dirs`: the platform's fragments/, then the tour's own folder.
 */
/**
 * A scene's steps for a run: expanded, each remembering its place in the script ("scriptStep", 1-based; a fragment's
 * steps all point at the step that called it), so reports can link a step back to the line a person edits.
 */
export function expandSceneSteps(steps = [], opts) {
  return steps.flatMap((step, i) => expandSteps([step], opts).map(s => ({ ...s, scriptStep: i + 1 })));
}

export function expandSteps(steps = [], { dirs, data = {}, stack = [] } = {}) {
  const out = [];
  for (const step of steps) {
    if (step && typeof step === 'object' && 'use' in step) {
      const file = fragmentFile(dirs, step.use);
      if (stack.includes(file)) throw new PlatformError(`Fragment cycle: ${[...stack, file].map(f => path.basename(f)).join(' → ')}`);
      if (file.endsWith('.mjs')) { out.push({ ...omit(step, ['use']), code: file, with: substitute(step.with ?? {}, { data }), from: step.use }); continue; }
      const frag = readJson(file, undefined, 'fragment');
      const args = { ...step.with };
      for (const [k, spec] of Object.entries(frag.params ?? {})) {
        if (!(k in args) && spec && 'default' in spec) args[k] = spec.default;
        if (!(k in args) && spec?.required) throw new PlatformError(`Fragment "${step.use}" needs "with": { "${k}": … }`);
      }
      const unknown = Object.keys(step.with ?? {}).filter(k => frag.params && !(k in frag.params));
      if (unknown.length) throw new PlatformError(`Fragment "${step.use}" has no parameter ${unknown.map(k => `"${k}"`).join(', ')} (has: ${Object.keys(frag.params).join(', ')})`);
      const inner = substitute(frag.steps ?? [], { args: substitute(args, { data }), data });
      const extra = omit(step, ['use', 'with']); // "optional", "timeout"… on the call apply to each of its steps
      for (const s of expandSteps(inner, { dirs, data, stack: [...stack, file] })) out.push({ ...s, ...extra, from: s.from ? `${step.use} › ${s.from}` : step.use });
    } else if (step && typeof step === 'object' && 'code' in step) {
      out.push({ ...step, code: path.isAbsolute(step.code) ? step.code : fragmentFile(dirs, step.code), with: substitute(step.with ?? {}, { data }) });
    } else out.push(substitute(step, { data }));
  }
  return out;
}

const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Steps of the platform's mock sets (mocks/<name>.json), in order. */
export function loadMocks(p, names = []) {
  const steps = [];
  for (const n of names) {
    if (!SAFE.test(n)) throw new PlatformError(`Mock set names must match ${SAFE} (got "${n}")`);
    const file = path.join(p.dir, 'mocks', `${n}.json`);
    if (!fs.existsSync(file)) throw new PlatformError(`Platform ${p.name} has no mock set "${n}" (${file})`);
    steps.push(...readJson(file, undefined, 'mocks').mocks.map(m => ({ ...m, from: `mocks/${n}` })));
  }
  return steps;
}

/** Reads the tour's fixtures: their data (merged, later wins) and setup/teardown hooks (run in the fixture's folder). */
export function loadFixtures(p, names = []) {
  const data = {}, setup = [], teardown = [], steps = [], items = [], browser = [];
  for (const n of names) {
    if (!SAFE.test(n)) throw new PlatformError(`Fixture names must match ${SAFE} (got "${n}")`);
    const file = path.join(p.dir, 'fixtures', `${n}.json`);
    if (!fs.existsSync(file)) throw new PlatformError(`Platform ${p.name} has no fixture "${n}" (${file})`);
    const f = readJson(file, undefined, 'fixture');
    Object.assign(data, f.data);
    const dir = path.join(p.dir, 'fixtures');
    const at = h => (h ? [h].flat().map(x => ({ ...x, dir })) : undefined);
    setup.push(...(f.setup ?? []).map(h => ({ ...h, dir })));
    teardown.unshift(...(f.teardown ?? []).map(h => ({ ...h, dir })));
    steps.push(...(f.steps ?? []));
    items.push(...fixtureItems({ items: f.items, setup: at(f.setup), teardown: at(f.teardown), readOnly: f.readOnly }, n)
      .map(i => ({ ...i, check: i.check ? { ...i.check, dir } : undefined, setup: at(i.setup), teardown: at(i.teardown) })));
    if (f.steps?.length || f.checkSteps?.length || f.cleanupSteps?.length)
      browser.push({ fixture: n, steps: f.steps ?? [], checkSteps: f.checkSteps ?? [], cleanupSteps: f.cleanupSteps ?? [], readOnly: !!f.readOnly });
  }
  return { data, setup, teardown, steps, items, browser };
}

/**
 * A fixture's (or a tour's "hooks") setup as paired items, in order. "items" as written; the older "setup" /
 * "teardown" lists become one item per setup hook (nothing to undo) and a last item whose undo is the teardown list,
 * so the teardown runs only when every setup hook ran, as before.
 */
export function fixtureItems({ items = [], setup = [], teardown = [], readOnly = false }, fixture) {
  const out = items.map(i => ({ ...i, fixture, readOnly: !!(i.readOnly || readOnly) }));
  (setup ?? []).forEach((h, k) => out.push({ name: `${fixture} setup ${k + 1}`, fixture, setup: [h], readOnly, legacy: true }));
  if (teardown?.length) out.push({ name: `${fixture} teardown`, fixture, teardown, readOnly, legacy: true });
  return out;
}

// ---- aft platform init -------------------------------------------------------------------------------------------

/** The smoke tour's checks: the start page's heading and title when known, else any visible heading. */
function smokeSteps(home) {
  const steps = [];
  if (home?.heading) steps.push({ verify: { role: 'heading', name: home.heading } });
  if (home?.title) steps.push({ verify: { title: home.title } });
  return steps.length ? steps : [{ verify: { role: 'heading', nth: 0 }, comment: 'any heading: name the one the start page shows, e.g. { "role": "heading", "name": "Welcome" }' }];
}

/** What a start page's HTML shows: its <title> and first <h1> (text only), or null if nothing answers. */
export async function homeOf(url, { timeout = 5000 } = {}) {
  const html = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' }).then(r => (r.ok ? r.text() : null), () => null);
  if (!html) return null;
  const clean = s => s?.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim() || null;
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const heading = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  return title || heading ? { title, heading } : null;
}

/**
 * Scaffolds platforms/<name>/ with every file, mostly empty, and a smoke tour. Never overwrites. login: false leaves out
 * login.json (an app without sign-in). home: what the app's start page showed ({ title, heading }, see homeOf), so the
 * smoke tour checks something real; without it, the smoke tour checks that some heading is visible.
 */
export function initPlatform(root, name, { baseUrl = 'http://localhost:3000/', login = true, home = null } = {}) {
  if (!SAFE.test(name)) throw new PlatformError(`Platform names must match ${SAFE} (got "${name}")`);
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) throw new PlatformError(`${dir} already exists; edit it instead`);
  const ENV = name.toUpperCase().replace(/-/g, '_');
  const files = {
    'platform.json': { comment: 'Fill in ready (busy indicators), errors (the app\'s error UI) and ignore (noisy requests) once discovery and the smoke tour show them.',
      appErrors: { network: 'warn', console: 'warn', pageErrors: 'warn' }, ignore: [], mask: { selectors: [], patterns: [] }, pronounce: {} },
    'environments.json': { default: 'local', local: { baseUrl, timeouts: {} } },
    'login.json': { comment: `Set signedIn to a CSS selector only signed-in pages show. Credentials: AFT_${ENV}_USERNAME / AFT_${ENV}_PASSWORD in .env.`,
      default: 'user', checkPath: '/', roles: { user: { steps: [
      { goto: '/login' }, { fill: 'Username', text: `{env:AFT_${name.toUpperCase().replace(/-/g, '_')}_USERNAME}` },
      { fill: 'Password', text: `{env:AFT_${name.toUpperCase().replace(/-/g, '_')}_PASSWORD}`, secret: true }, { click: { role: 'button', name: 'Sign in' } }] } } },
    'tours/smoke.tour.json': { name: `${name}-smoke`, platform: name, scenes: [{ title: 'Home', url: '/', narration: `The ${name} home page.`, steps: smokeSteps(home) }] },
  };
  if (!login) delete files['login.json'];
  const TYPE = { 'platform.json': 'platform', 'environments.json': 'environments', 'login.json': 'login', 'tours/smoke.tour.json': 'tour' };
  for (const [f, v] of Object.entries(files)) {
    const file = path.join(dir, f);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // "$schema" first, so editors validate and autocomplete the file with no setup.
    fs.writeFileSync(file, JSON.stringify({ $schema: schemaRef(path.dirname(file), TYPE[f]), ...v }, null, 2) + '\n');
  }
  for (const d of ['fragments', 'fixtures']) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, '.gitkeep'), ''); }
  fs.writeFileSync(path.join(dir, 'requirements.mjs'),
    `// ${name}: extra checks for \`aft doctor --platform ${name}\` (see src/doctor.mjs).\nexport default async function requirements({ add }) {\n}\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), `# Platform: ${name}\n\nWhat it is, where it runs, how to sign in, what data tours may touch.\n`);
  return dir;
}
