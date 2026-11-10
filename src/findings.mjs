// Findings: what a spike or investigation concluded, kept with the run that showed it. A tour names its findings
// document ("findings": "findings.md", the spike's write-up; `aft scratch --from` sets it to the document the deck
// came from). Every run of the tour writes <run>/findings/:
//
//   findings.md     the summary: the question, the verdict, each finding (status, severity, evidence), what the
//                   run showed and where to look (video, captions, slides, screens, report), then the write-up as is
//   findings.json   the same as data (schema aft-findings/1)
//   source.md       the findings document as it was when the run started
//
// Findings in the document use the platform-notes format (src/notes.mjs): a heading "### F-1 · Title" (any
// "<letters>-<number>" id) followed by "- key: value" lines: status (confirmed | refuted | open | partial | fixed),
// severity (high | medium | low | info), area, evidence (scene numbers, files, links), suggested (the next step).
// A document without them still gets a summary: its sections are the findings' context. Nothing here changes how a
// run executes.

import fs from 'node:fs';
import path from 'node:path';
import { parseFindings, parseFrontmatter } from './notes.mjs';

export const FINDINGS_SCHEMA = 'aft-findings/1';
const STATUS = ['confirmed', 'refuted', 'partial', 'open', 'fixed', 'wontfix'];
const SEVERITY = ['high', 'medium', 'low', 'info'];

const rel = (from, f) => path.relative(from, f).split(path.sep).join('/');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * The write-up for reading: deck directives (Reveal:, Hold:, Use:, Layout:, Theme:, Accent:, Url:, Voice:, Rate:,
 * Platform:) and ```steps blocks are how the video is made, not what was found, so they go; "Say:" lines read as
 * the narration they are.
 */
export function readable(body) {
  const out = [];
  let inSteps = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (/^\s*```\s*steps\b/i.test(line)) { inSteps = true; continue; }
    if (inSteps) { if (/^\s*```/.test(line)) inSteps = false; continue; }
    if (/^\s*(reveal|hold|use|layout|theme|accent|url|voice|rate|platform)\s*:/i.test(line)) continue;
    const say = line.match(/^\s*(?:say|narration)\s*:\s*(.*)$/i);
    out.push(say ? `> 🗣 *${say[1]}*` : line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The document's title (front matter title:/name:, else its first heading) and its findings. */
export function readFindingsDoc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const title = meta.title ?? body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? meta.name ?? path.basename(file, path.extname(file));
  const question = meta.question ?? null;
  const findings = parseFindings(body).map(f => ({
    ...f,
    status: STATUS.includes(String(f.status ?? '').toLowerCase()) ? f.status.toLowerCase() : f.status ? String(f.status) : 'open',
    ...(f.severity ? { severity: SEVERITY.includes(f.severity.toLowerCase()) ? f.severity.toLowerCase() : f.severity } : {}),
  }));
  return { title, question, meta, findings, text };
}

/**
 * Writes <outDir>/findings/ for a run of a tour with a findings document. def: the loaded tour (def.findingsFile,
 * def.name, def.story, def.scenes); result: what the run reported ({ status: passed | failed | rendered | validated,
 * video, seconds, verdict, error }). Returns the findings.md path, or null when the tour has no findings document.
 */
export function writeFindings(def, outDir, result = {}) {
  if (!def?.findingsFile || !fs.existsSync(def.findingsFile)) return null;
  const doc = readFindingsDoc(def.findingsFile);
  const dir = path.join(outDir, 'findings');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(def.findingsFile, path.join(dir, 'source.md'));
  const has = f => fs.existsSync(path.join(outDir, f));
  const list = (sub, re) => (fs.existsSync(path.join(outDir, sub)) ? fs.readdirSync(path.join(outDir, sub)).filter(f => re.test(f)).sort().map(f => `${sub}/${f}`) : []);
  const report = readJson(path.join(outDir, 'report.json'));
  const validation = readJson(path.join(outDir, 'validation.json'));
  const review = report?.review ?? validation?.review ?? null;
  const artifacts = {
    ...(has('tour.mp4') ? { video: 'tour.mp4' } : {}), ...(has('tour.vtt') ? { captions: 'tour.vtt' } : {}),
    slides: list('slides', /^scene-\d+\.png$/), screens: list('screens', /\.png$/i),
    ...(has('slides/index.html') ? { deck: 'slides/index.html' } : {}),
    ...(has('report.md') ? { report: 'report.md' } : has('validation.md') ? { report: 'validation.md' } : {}),
    ...(has('source') ? { tour: rel(outDir, fs.readdirSync(path.join(outDir, 'source')).filter(f => /\.json$/.test(f)).map(f => path.join(outDir, 'source', f))[0] ?? path.join(outDir, 'source')) } : {}),
    source: 'findings/source.md',
  };
  // Findings the run itself found (a failing step, weak evidence) sit beside the document's.
  const runFindings = (review?.findings ?? []).filter(f => !f.decision).map(f => ({ id: f.id, title: f.title, kind: f.kind, ...(f.detail ? { detail: String(f.detail).slice(0, 300) } : {}) }));
  const count = s => doc.findings.filter(f => f.status === s).length;
  const data = {
    schema: FINDINGS_SCHEMA,
    title: doc.title,
    ...(doc.question ? { question: doc.question } : {}),
    tour: def.name, ...(def.story?.id ? { story: def.story.id } : {}),
    at: new Date().toISOString(),
    run: { dir: outDir, ...result, ...(review ? { verdict: review.verdict, label: review.label } : {}) },
    summary: { findings: doc.findings.length, ...Object.fromEntries(STATUS.map(s => [s, count(s)]).filter(([, n]) => n)) },
    findings: doc.findings,
    runFindings,
    scenes: (def.scenes ?? []).filter(s => !s.offCamera).map((s, i) => ({ n: i + 1, title: s.title, ...(s.slide ? { slide: true } : {}), ...(s.platform ? { platform: s.platform } : {}) })),
    artifacts,
  };
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(data, null, 2) + '\n');

  const link = f => `[${f}](../${f})`;
  const status = result.status ?? (has('tour.mp4') ? 'rendered' : 'checked');
  const lines = [
    `# Findings: ${doc.title}`, '',
    ...(doc.question ? [`**Question:** ${doc.question}`, ''] : []),
    `- **Tour:** ${def.name}${def.story?.id ? ` (${def.story.id})` : ''}`,
    `- **Run:** ${status}${result.seconds ? `, ${Math.round(result.seconds)} s` : ''}${review ? ` · review: ${review.label}` : ''}${result.error ? ` · ${result.error}` : ''} · ${data.at.slice(0, 16).replace('T', ' ')}`,
    `- **Findings:** ${doc.findings.length ? Object.entries(data.summary).filter(([k]) => k !== 'findings').map(([k, n]) => `${n} ${k}`).join(', ') : 'none written as "### F-1 · Title" in the document (its sections are below)'}`,
    '',
  ];
  if (doc.findings.length) {
    lines.push('| id | finding | status | severity | evidence |', '|---|---|---|---|---|',
      ...doc.findings.map(f => `| ${esc(f.id)} | ${esc(f.title)} | ${esc(f.status)} | ${esc(f.severity ?? '')} | ${esc(f.evidence ?? '')} |`), '');
    for (const f of doc.findings) {
      lines.push(`## ${f.id} · ${f.title}`, '');
      for (const [k, v] of Object.entries(f)) if (!['id', 'title'].includes(k)) lines.push(`- **${k}:** ${v}`);
      lines.push('');
    }
  }
  if (runFindings.length) lines.push('## Found by the run', '', ...runFindings.map(f => `- ${f.title}${f.detail ? `: ${f.detail}` : ''} (\`${f.id}\`)`), '');
  lines.push('## Evidence', '',
    ...(artifacts.video ? [`- Video: ${link(artifacts.video)}${artifacts.captions ? ` · captions ${link(artifacts.captions)}` : ''}`] : []),
    ...(artifacts.deck ? [`- Slides: ${link(artifacts.deck)} (${artifacts.slides.length})`] : []),
    ...(artifacts.screens.length ? [`- Screens: ${artifacts.screens.map(link).join(', ')}`] : []),
    ...(artifacts.report ? [`- Report: ${link(artifacts.report)}`] : []),
    ...(artifacts.tour ? [`- The tour as it ran: ${link(artifacts.tour)}`] : []),
    `- Scenes: ${data.scenes.map(s => `${s.n}. ${s.title}${s.platform ? ` (${s.platform})` : ''}`).join(' · ')}`, '',
    '## The write-up', '', `<!-- ${path.basename(def.findingsFile)} as it was at the run (findings/source.md has it exactly) -->`, '', readable(parseFrontmatter(doc.text).body), '');
  const md = path.join(dir, 'findings.md');
  fs.writeFileSync(md, lines.join('\n'));
  return md;
}
