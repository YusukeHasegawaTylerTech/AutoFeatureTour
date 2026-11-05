// How long a scene takes: the voice (words / 2.5 s, at least 2 s, as src/tts.mjs estimates it) against its steps
// (rough per kind: what a paced run spends on a cursor move and a click, typing, a page load). Shared by the UI's
// scene timing (ui/public/simple.js keeps a copy: it runs in the browser) and the conversation (src/converse.mjs),
// which fits a recorded scene's narration to its steps.

export const spokenSeconds = text => { const w = String(text ?? '').split(/\s+/).filter(Boolean).length; return w ? Math.max(2, w / 2.5) : 0; };

export function stepSeconds(st) {
  if (st.camera === false) return 0;   // cut from the video
  if (typeof st.wait === 'number') return st.wait;
  if (st.goto != null) return 2.5;
  if (st.fill != null || st.type != null) return 1.2 + String(st.text ?? '').length * 0.06;
  if (st.verify != null || st.waitFor != null || st.pin != null || st.capture != null || st.at != null) return 0.4;
  if (st.press != null) return 0.6;
  if (st.use != null || st.code != null) return 3;
  return 1.4;   // click, hover, check, select…
}

export const sceneTiming = s => ({ spoken: spokenSeconds(s.narration), steps: (s.steps ?? []).reduce((n, st) => n + stepSeconds(st), s.url ? 2.5 : 0) });

/** Words a narration should have to last about as long as the steps (2.5 words a second). */
export const wordsFor = steps => Math.max(8, Math.round(sceneTiming({ steps }).steps * 2.5));
