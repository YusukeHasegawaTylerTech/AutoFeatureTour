import fs from 'node:fs';

/**
 * Parses a narration script. Each "## N. Title" starts a scene; lines starting with "*" are capture cues (not
 * spoken); other non-blank lines are narration. Anything before the first scene heading is presenter notes.
 */
export function parseScript(file) {
  const scenes = [];
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^##\s+(\d+)\.\s*(.+)$/);
    if (m) {
      const number = Number(m[1]);
      current = { number, id: `scene-${String(number).padStart(2, '0')}`, title: m[2].trim(), narration: '', cues: [] };
      scenes.push(current);
    } else if (current && line.trim()) {
      if (line.trimStart().startsWith('*')) current.cues.push(line.trim().replace(/^\*+|\*+$/g, ''));
      else current.narration = `${current.narration} ${line.trim()}`.trim();
    }
  }
  if (!scenes.length) throw new Error(`No "## N. Title" scenes found in ${file}`);
  return scenes;
}

/** Text for speech: markdown emphasis stripped, then the tour's pronunciation substitutions applied. */
export function spokenText(narration, pronounce = {}) {
  let text = narration.replace(/[*_`]/g, '');
  for (const [k, v] of Object.entries(pronounce)) text = text.split(k).join(v);
  return text;
}
