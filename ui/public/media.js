// Scene markers under a tour video: one button per filmed scene, at the second it starts in tour.mp4.
// The video is the filmed scenes back to back; tour.vtt has one narration cue per filmed scene, starting where that
// scene starts (mock and known-issue notes are extra cues placed "line:5%", skipped here). So the markers need nothing
// beyond the run's own files.

const h = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const secs = t => { const [hh, mm, ss] = t.split(':'); return Number(hh) * 3600 + Number(mm) * 60 + Number(ss); };

/** Scene start times (seconds into the video) from tour.vtt text. */
export function sceneStarts(vtt) {
  const starts = [];
  for (const block of String(vtt).replace(/\r/g, '').split(/\n\n+/)) {
    const m = /^(\d\d:\d\d:\d\d\.\d+) --> (\d\d:\d\d:\d\d\.\d+)(.*)$/m.exec(block);
    if (m && !/line:/.test(m[3])) starts.push(secs(m[1]));
  }
  return starts;
}

/**
 * Fills box with markers for video. scenes: [{ n, title }] for the filmed scenes in order (from the scene-NN.mp4 files
 * in the run folder and the tour's titles). Clicking one jumps there; the one playing is highlighted.
 */
export async function mountMarkers(box, video, { vttUrl, scenes }) {
  if (!box || !video || !vttUrl) return;
  let starts;
  try { starts = sceneStarts(await (await fetch(vttUrl)).text()); } catch { return; }
  if (!starts.length) return;
  const list = starts.map((t, i) => ({ t, ...(scenes[i] ?? { n: i + 1 }) }));
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  box.innerHTML = `<div class="markers" role="list" aria-label="Scenes in the video">${list.map((s, i) =>
    `<button class="marker" role="listitem" data-i="${i}" title="Jump to scene ${s.n}${s.title ? `: ${h(s.title)}` : ''}">
      <b>${s.n}</b> ${h(s.title ?? '')} <span class="muted">${mmss(s.t)}</span></button>`).join('')}</div>`;
  const buttons = [...box.querySelectorAll('.marker')];
  buttons.forEach(b => (b.onclick = () => { video.currentTime = list[b.dataset.i].t + 0.01; video.play().catch(() => {}); }));
  const mark = () => {
    const t = video.currentTime;
    let cur = 0; for (let i = 0; i < list.length; i++) if (t >= list[i].t) cur = i;
    buttons.forEach((b, i) => b.classList.toggle('now', i === cur));
  };
  video.addEventListener('timeupdate', mark);
  mark();
}

/** The filmed scenes of a run, in order: scene-NN.mp4 at the run folder's top level, titled from the tour if known. */
export function filmedScenes(files, tour) {
  const ids = files.map(f => /^scene-(\d+)\.mp4$/.exec(f.path)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const all = tour?.scenes ?? [];
  if (ids.length) return ids.map(n => ({ n, title: all[n - 1]?.title }));
  // no per-scene files (an older run): the tour's on-camera scenes
  return all.map((s, i) => ({ n: i + 1, title: s.title, off: s.camera === false })).filter(s => !s.off);
}
