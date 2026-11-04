// Validates definition files against the published schemas (schemas/*.schema.json) and turns schema errors into one
// line per problem with the exact path: "scenes[2].steps[0].click: expected a locator (…)".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const schemasDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const TYPES = ['tour', 'platform', 'environments', 'login', 'fragment', 'fixture', 'mocks'];

let ajv = null;
const load = name => JSON.parse(fs.readFileSync(path.join(schemasDir, `${name}.schema.json`), 'utf8'));

function compiler() {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
  ajv.addSchema(load('common'));
  for (const t of TYPES) ajv.addSchema(load(t), t);
  return ajv;
}

export const schemaFor = type => { if (![...TYPES, 'common'].includes(type)) throw new Error(`No schema "${type}" (${TYPES.join(', ')})`); return load(type); };
export const schemaTypes = () => [...TYPES];

/** "$schema" value for a file in dir: the relative path to schemas/<type>.schema.json, with forward slashes. */
export const schemaRef = (dir, type) => path.relative(dir, path.join(schemasDir, `${type}.schema.json`)).split(path.sep).join('/');

const ACTION_KEYS = () => Object.keys(load('common').$defs).filter(k => k.startsWith('action_')).map(k => k.slice(7));

function describe(e) {
  switch (e.keyword) {
    case 'required': return `missing "${e.params.missingProperty}"`;
    case 'additionalProperties': return `unknown key "${e.params.additionalProperty}"`;
    case 'enum': return `expected one of ${e.params.allowedValues.map(v => JSON.stringify(v)).join(', ')}`;
    case 'type': return `expected ${e.params.type}`;
    case 'pattern': if (e.params.pattern.startsWith('^\\{(args')) return 'expected a number (or a {args.x} / {data.x} placeholder)'; return e.message;
    default: return e.message;
  }
}

/** Errors for one step: decided by its action key, so a typo gives one precise message instead of a list of alternatives. */
function stepErrors(step, where) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return [`${where}: expected a step object`];
  const keys = ACTION_KEYS();
  const actions = keys.filter(k => k in step && !(k === 'waitForResponse' && keys.some(o => o !== k && o in step)));
  if (!actions.length) return [`${where}: no action; expected one of ${keys.join(', ')}`];
  if (actions.length > 1) return [`${where}: more than one action (${actions.join(', ')}); a step does one thing`];
  const a = actions[0];
  const v = compiler().getSchema(`https://autofeaturetour.local/schemas/v1/common.schema.json#/$defs/action_${a}`);
  if (v(step)) return [];
  return collapse(v.errors, where, step);
}

const segs = p => p.split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
const fmt = (base, p) => segs(p).reduce((acc, x) => (/^\d+$/.test(x) ? `${acc}[${x}]` : acc ? `${acc}.${x}` : x), base) || '(top level)';
const at = (doc, p) => segs(p).reduce((o, k) => o?.[k], doc);
const isLocator = s => Array.isArray(s?.anyOf) && s.anyOf.some(b => b.properties?.role && b.properties?.css);
const isNum = s => Array.isArray(s?.anyOf) && s.anyOf.length === 2 && s.anyOf[0].type === 'number' && /placeholder/.test(s.anyOf[1].$ref ?? '');
const LOCATOR ='expected a locator (a string, or an object with one of role, label, placeholder, text, testId, alt, css)';

const KINDS = ['role', 'label', 'placeholder', 'text', 'testId', 'alt', 'css'];

/** A locator object's problems, nested ones (within, has, hasNot) included. */
function locatorProblems(v, where, objSchema) {
  if (typeof v === 'string') return v ? [] : [`${where}: an empty locator`];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${where}: ${LOCATOR}`];
  const out = [];
  const kinds = KINDS.filter(k => k in v);
  if (kinds.length !== 1) out.push(`${where}: a locator object needs exactly one of ${KINDS.join(', ')}${kinds.length ? ` (has ${kinds.join(' and ')})` : ''}`);
  for (const k of Object.keys(v)) if (!(k in objSchema.properties)) out.push(`${where}: unknown key "${k}" (a locator has ${Object.keys(objSchema.properties).join(', ')})`);
  if ('nth' in v && !(Number.isInteger(v.nth) && v.nth >= 0) && !/^\{(args|data)\./.test(String(v.nth))) out.push(`${where}.nth: expected a whole number ≥ 0 (or a {args.x} / {data.x} placeholder)`);
  for (const k of ['name', 'label', 'placeholder', 'text', 'testId', 'alt', 'css', 'role', 'hasText', 'hasNotText']) if (k in v && typeof v[k] !== 'string') out.push(`${where}.${k}: expected string`);
  if ('exact' in v && typeof v.exact !== 'boolean') out.push(`${where}.exact: expected boolean`);
  for (const k of ['within', 'has', 'hasNot']) if (k in v) out.push(...locatorProblems(v[k], `${where}.${k}`, objSchema));
  return out;
}

/** One message per problem: a failing union (locator, "one of these forms") is reported once, at its own path. */
function collapse(errors, base = '', doc) {
  const out = new Set();
  const unions = new Map();
  for (const e of errors) if ((e.keyword === 'anyOf' || e.keyword === 'oneOf') && (!unions.has(e.instancePath) || e.schemaPath.length < unions.get(e.instancePath).schemaPath.length)) unions.set(e.instancePath, e);
  const covering = e => [...unions.values()].find(u => u !== e && (e.instancePath === u.instancePath || e.instancePath.startsWith(u.instancePath + '/')) && e.schemaPath.startsWith(u.schemaPath));
  for (const u of [...unions.values()].filter(u => !covering(u))) {
    const where = fmt(base, u.instancePath);
    const value = at(doc, u.instancePath);
    if (isLocator(u.parentSchema)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // A locator object is checked directly (kinds, keys, value types, nested locators): ajv's own errors for it are
        // one per alternative and say little.
        locatorProblems(value, where, u.parentSchema.anyOf.find(b => b.properties?.role)).forEach(m => out.add(m));
      } else out.add(`${where}: ${LOCATOR}`);
    } else if (isNum(u.parentSchema)) {
      // number | placeholder: a number out of range says so; anything else isn't a number.
      const range = typeof value === 'number' ? errors.filter(e => e.instancePath === u.instancePath && ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(e.keyword)) : [];
      out.add(`${where}: ${range.length ? range.map(e => `must be ${e.params.comparison} ${e.params.limit}`).join(', ') : 'expected a number (or a {args.x} / {data.x} placeholder)'}`);
    } else out.add(`${where}: expected ${u.parentSchema?.description ? u.parentSchema.description.replace(/\.$/, '').replace(/^./, c => c.toLowerCase()) : 'one of the allowed forms'}`);
  }
  // Errors that belong to a reported union (its branches, at its path or inside it) aren't repeated.
  const inReported = e => [...unions.values()].some(u => e.instancePath === u.instancePath || e.instancePath.startsWith(u.instancePath + '/'));
  for (const e of errors) if (e.keyword !== 'anyOf' && e.keyword !== 'oneOf' && !inReported(e)) out.add(`${fmt(base, e.instancePath)}: ${describe(e)}`);
  return [...out];
}

/** Validates a parsed file; returns a list of "path: problem" strings (empty when valid). */
export function check(type, doc) {
  const v = compiler().getSchema(type);
  if (v(doc)) return [];
  const problems = [];
  const stepPath = /^(.*\/steps)\/(\d+)(\/|$)/;
  const seen = new Set();
  for (const e of v.errors) {
    const m = e.instancePath.match(stepPath);
    if (m) {
      // Inside a step: re-check that step by its action for one precise message.
      const key = `${m[1]}/${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const step = key.split('/').slice(1).reduce((o, k) => o?.[k], doc);
      problems.push(...stepErrors(step, fmt('', key)));
    } else if (e.schemaPath.includes('/steps/') || /\/action_/.test(e.schemaPath)) continue;
    else problems.push(...collapse(v.errors.filter(x => x.instancePath === e.instancePath || x.instancePath.startsWith(e.instancePath + '/')), '', doc));
  }
  return [...new Set(problems)];
}

/** Throws (with every problem, one per line) if the file doesn't match its schema. */
export function assertValid(type, doc, file, ErrorClass = Error) {
  const problems = check(type, doc);
  if (problems.length) throw new ErrorClass(`${file} doesn't match the ${type} schema (schemas/${type}.schema.json):\n  ${problems.join('\n  ')}`);
}
