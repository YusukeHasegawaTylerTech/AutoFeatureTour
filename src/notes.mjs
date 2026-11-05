// Platform notes: what was learned about an app (accounts, setup recipes, findings), kept as markdown in
// platforms/<p>/notes/*.md (and notes/imported/<source>/*.md from other platforms' exports). Optional frontmatter
// (`schema: aft-platform-notes/1`, platform, …); unknown markdown is read as is. Findings are `### <ID> · <title>`
// headings (also `-`, `:` or `—` as separator) followed by `- key: value` lines (area, type, status, seen, evidence,
// suggested). Notes are data for people and planners: nothing here changes how a run executes.
import fs from 'node:fs';
import path from 'node:path';

export const NOTES_SCHEMA = 'aft-platform-notes/1';

/** `---\nkey: value\n---` at the top: { meta, body }. Values stay strings (lists `[a, b]` become arrays). */
export function parseFrontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    meta[kv[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : v;
  }
  return { meta, body: text.slice(m[0].length) };
}

const FINDING = /^#{2,4}\s+([A-Za-z][A-Za-z0-9]*-\d+[A-Za-z0-9]*)\s*(?:[·:—–-]\s*)?(.*)$/;

/** Findings with ids from a notes body: [{ id, title, area?, type?, status?, … }]. */
export function parseFindings(body) {
  const out = [];
  let cur = null, key = null;
  for (const line of String(body).split(/\r?\n/)) {
    const h = line.match(FINDING);
    if (h) { cur = { id: h[1], title: h[2].trim() }; key = null; out.push(cur); continue; }
    if (/^#{1,4}\s/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s*[-*]\s+([a-z][\w-]*)\s*:\s*(.*)$/i);
    if (kv) { key = kv[1].toLowerCase(); cur[key] = kv[2].trim(); continue; }
    if (key && /^\s{2,}\S/.test(line)) cur[key] += ' ' + line.trim(); // a wrapped value
  }
  return out;
}

/** One notes file: { file (relative to notes/), meta, findings, text }. */
export function readNote(file, base = path.dirname(file)) {
  const text = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  return { file: path.relative(base, file).replace(/\\/g, '/'), meta, findings: parseFindings(body), text };
}

/** Every *.md under <platformDir>/notes (own notes first, then imported/…), sorted. [] when there are none. */
export function readNotes(platformDir) {
  const base = path.join(platformDir, 'notes');
  if (!fs.existsSync(base)) return [];
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.md$/i.test(e.name)) files.push(f);
    }
  };
  walk(base);
  const rel = f => path.relative(base, f).replace(/\\/g, '/');
  files.sort((a, b) => (rel(a).startsWith('imported/') - rel(b).startsWith('imported/')) || rel(a).localeCompare(rel(b)));
  return files.map(f => { try { return readNote(f, base); } catch { return null; } }).filter(Boolean);
}

/** All finding ids in a set of notes. */
export const findingIds = notes => new Set(notes.flatMap(n => n.findings.map(f => f.id)));

/** The notes as one markdown document (a run's notes.md), or null when there are none. */
export function notesMarkdown(notes, { platform, at = new Date().toISOString() } = {}) {
  if (!notes.length) return null;
  const head = `<!-- Platform notes${platform ? ` of "${platform}"` : ''} as they were at ${at}: ${notes.length} file(s), ${notes.reduce((n, x) => n + x.findings.length, 0)} finding(s). A snapshot: edit platforms/${platform ?? '<p>'}/notes/, not this. -->\n`;
  return head + notes.map(n => `\n<!-- notes/${n.file} -->\n\n${n.text.trim()}\n`).join('');
}

/** Notes for an LLM prompt: each file's text, trimmed to a total budget. */
export function notesForPrompt(notes, { max = 20000 } = {}) {
  let left = max;
  const out = [];
  for (const n of notes) {
    if (left <= 0) break;
    const text = n.text.length > left ? n.text.slice(0, left) + '\n…(truncated)' : n.text;
    left -= text.length;
    out.push({ file: n.file, findings: n.findings.map(f => f.id), text });
  }
  return out;
}

/** Writes <runDir>/notes.md from a platform folder. Returns the file, or null (no notes). Never throws. */
export function snapshotNotes(runDir, platformDir, platform) {
  try {
    const md = notesMarkdown(readNotes(platformDir), { platform });
    if (!md) return null;
    const file = path.join(runDir, 'notes.md');
    fs.writeFileSync(file, md);
    return file;
  } catch { return null; }
}
