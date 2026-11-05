import { simpleViews } from './simple.js';
import { mountReview } from './review.js';
import { filmedScenes, mountMarkers } from './media.js';
import { mountSchemaForm } from './form.js';
import { mountStage, stageButton } from './stage.js';
// AutoFeatureTour UI: hash-routed, no build step.
// Held while this page is open: a server started by start.cmd stops once every UI window is closed.
new EventSource('/api/alive');
const $app = document.getElementById('app');
const h = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (p, opts) => {
  const r = await fetch(p, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const fileUrl = (id, f) => `/api/file/${id.split('/').map(encodeURIComponent).join('/')}/${f.split('/').map(encodeURIComponent).join('/')}`;
const ago = t => { if (!t) return ''; const s = (Date.now() - new Date(t)) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t).toLocaleString(); };
const dur = (a, b) => a && b ? `${Math.round((new Date(b) - new Date(a)) / 1000)} s` : '';
const status = r => {
  if (r.status === 'running') return '<span class="badge warn">running</span>';
  if (r.status === 'done') return '<span class="badge ok">ok</span>';
  return `<span class="badge bad">${h(r.class ?? r.status ?? '?')}</span>`;
};
const rel = p => p ? String(p).replace(/\\/g, '/').replace(/^.*?\/(platforms|out)\//, '$1/') : '';

// ---- jobs (CLI commands run by the server) ----
async function startJob(args) {
  const job = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  location.hash = `#/job/${job.id}`;
}


// ---- views ----
/**
 * The run as a storyboard: per scene its title, narration, still (screens/scene-NN.png), a link to the scene's page in
 * the app, and its steps with results, each linking to that step in the editor. Steps come from report.json (runs) or
 * validation.json (dry runs); titles and narration from the run's tour.json, else the tour file it ran (as it is now).
 */
async function storyboard(id, d, input) {
  const has = f => d.files.some(x => x.path === f);
  const getJson = async f => { try { return await (await fetch(fileUrl(id, f))).json(); } catch { return null; } };
  const steps = d.report?.steps ?? (has('validation.json') ? (await getJson('validation.json'))?.report : null) ?? [];
  let tour = has('tour.json') ? await getJson('tour.json') : null, tourPath = null;
  const r = input ? rel(input) : '';
  if (/^platforms\/.+\.tour\.json$/.test(r)) {
    tourPath = r;
    if (!tour) try { tour = JSON.parse((await api(`/api/pfile?path=${encodeURIComponent(r)}`)).text); } catch {}
  }
  const scenes = tour?.scenes ?? [];
  const ids = [...new Set([...scenes.map((_, i) => `scene-${String(i + 1).padStart(2, '0')}`),
    ...steps.map(s => String(s.scene ?? '').replace(/\s.*$/, '')).filter(x => /^scene-\d+$/.test(x))])];
  if (!ids.length) return '';
  // Test data: what each fixture item and cleanup did (ledger.json), before scene 1 and after the last scene.
  const items = d.ledger?.items ?? d.report?.fixtures ?? [];
  const strip = which => fixtureStrip(which, items, steps.filter(x => (which === 'setup' ? /^fixtures/ : /^cleanup/).test(x.scene ?? '')));
  const base = d.timings?.baseUrl ?? null;
  const pageUrl = u => { try { return base && u ? new URL(u, base.endsWith('/') ? base : base + '/').href : null; } catch { return null; } };
  const shot = sid => has(`screens/${sid}.png`) ? fileUrl(id, `screens/${sid}.png`) : null;
  const what = sp => { if (!sp || typeof sp !== 'object') return String(sp ?? '');
    const k = Object.keys(sp).find(x => !['criterion', 'optional', 'timeout', 'retries', 'comment', 'from'].includes(x)) ?? '';
    const v = sp[k]; const t = typeof v === 'string' ? v : v && typeof v === 'object' ? (v.name ?? v.text ?? v.label ?? v.css ?? v.url ?? v.use ?? JSON.stringify(v)) : String(v);
    const extra = sp.text && k !== 'text' && typeof sp.text === 'string' ? ` "${sp.text.slice(0, 40)}"` : sp.state ? ` (${sp.state})` : '';
    return `${k} ${String(t).slice(0, 80)}${extra}`; };
  // ▶ do until here: stages the script that ran (tour.json in the run folder, else the tour file it ran)
  const stage = !!scenes.length;
  return `<div class="card"><h3>Scenes</h3>${stage ? `<div class="stage-bar" data-stage-at="setup">${stageButton({ setup: true })} <span class="muted">or ▶ on a scene or step: the app live at that point, with this run's script, to test by hand</span></div>` : ''}${strip('setup')}${ids.map(sid => {
    const n = Number(sid.slice(6)), sc = scenes[n - 1] ?? {};
    const own = steps.filter(s => String(s.scene ?? '').replace(/\s.*$/, '') === sid);
    const bad = own.some(s => s.ok === false && !s.optional);
    const offScene = sc.camera === false;
    const url = pageUrl(sc.url), img = shot(sid);
    return `<div class="board ${bad ? 'board-bad' : ''} ${offScene ? 'board-off' : ''}" id="board-${sid}" data-stage-at="s${n}">
      <div class="board-shot">${img ? `<a href="${img}" target="_blank" title="Open the full screenshot"><img src="${img}" loading="lazy" alt="${h(sid)} at its end"></a>` : '<div class="noshot muted">no screenshot</div>'}</div>
      <div class="board-body">
        <div class="board-head"><span class="board-num ${bad ? 'bad' : own.length ? 'ok' : ''}">${n}</span><b>${h(sc.title ?? sid)}</b>
          ${sc.criteria?.length ? `<span class="badge muted">AC ${h(sc.criteria.join(', '))}</span>` : ''}
          ${offScene ? '<span class="badge offcam" title="Runs and is checked, but is not in the video">🎥 off camera</span>' : ''}
          ${url ? `<a class="board-link" href="${h(url)}" target="_blank" title="${h(url)}">open in the app ↗</a>` : ''}
          ${tourPath ? `<a class="board-link" href="#/write/${encodeURIComponent(tourPath)}?scene=${n}">edit scene ✏️</a>` : ''}
          ${stage && n <= scenes.length ? stageButton({ scene: n }) : ''}</div>
        ${sc.narration ? `<p class="board-narr">“${h(sc.narration)}”</p>` : ''}
        <ol class="board-steps">${own.map(s => {
          const isUrl = /\(url\)/.test(s.scene ?? '');
          const edit = tourPath && !isUrl ? `<a href="#/write/${encodeURIComponent(tourPath)}?scene=${n}&step=${s.scriptStep ?? s.step}" title="Edit this step">✏️</a>` : '';
          const at = !isUrl && n <= scenes.length ? s.scriptStep ?? null : null;
          return `<li class="${s.ok === false ? (s.optional ? 'warn' : 'bad') : ''}"${at ? ` data-stage-at="s${n}.${at}"` : ''}><span class="${s.ok === false ? 'bad' : s.ok ? 'ok' : 'muted'}">${s.ok === false ? '✘' : s.ok ? '✔' : '·'}</span>
            <code>${h(isUrl ? `open ${s.spec?.goto ?? sc.url ?? ''}` : what(s.spec ?? s.action))}</code>${s.from ? ` <span class="muted">(${h(s.from)})</span>` : ''}${s.offCamera && !offScene ? ' <span class="badge offcam" title="Cut from the video">🎥 off camera</span>' : ''}${s.spec?.pin ? ` <span class="badge pin" title="Pinned as an artifact">📌 ${h(s.spec.pin)}</span>` : ''} ${edit}${stage && at ? stageButton({ scene: n, step: at }, { compact: true }) : ''}
            ${s.error ? `<div class="bad">${h(s.error)}</div>` : ''}${s.suggestions?.length ? `<div class="muted">did you mean: ${h(s.suggestions.join(', '))}</div>` : ''}</li>`; }).join('')
          || '<li class="muted">no steps ran</li>'}</ol></div></div>`; }).join('')}${strip('teardown')}</div>${artifactsBoard(id, d.artifacts?.length ? d.artifacts : d.report?.artifacts ?? [], tourPath)}`;
}

/** The tour a run used: its own tour.json, else the platform tour it ran (as it is now), else null. */
async function runTour(id, d, input) {
  if (d.files.some(x => x.path === 'tour.json')) try { return await (await fetch(fileUrl(id, 'tour.json'))).json(); } catch {}
  const r = input ? rel(input) : '';
  if (/^platforms\/.+\.tour\.json$/.test(r)) try { return JSON.parse((await api(`/api/pfile?path=${encodeURIComponent(r)}`)).text); } catch {}
  return null;
}

/** A run's steps: report.json (runs), else validation.json (dry runs). */
async function runSteps(id, d) {
  if (d.report?.steps) return d.report.steps;
  if (d.files.some(x => x.path === 'validation.json')) try { return (await (await fetch(fileUrl(id, 'validation.json'))).json())?.report ?? []; } catch {}
  return [];
}

const FX_SETUP = { 'in-place': ['ok', 'already in place'], done: ['ok', 'set up'], undone: ['ok', 'set up'], 'undo-failed': ['ok', 'set up'], pending: ['warn', 'started, never finished'], failed: ['bad', 'setup failed'] };
const FX_UNDO = { undone: ['ok', 'undone'], 'undo-failed': ['bad', 'undo failed: data left behind'], 'in-place': ['muted', 'nothing to undo (it was already there)'], failed: ['muted', 'not undone (its setup failed)'] };

/** Scene 0 (before scene 1, off camera) and the strip after the last scene: each fixture item and what happened to it. */
function fixtureStrip(which, items, steps) {
  const undoable = i => i.undo || i.toUndo || ['undone', 'undo-failed'].includes(i.status);
  const list = which === 'setup' ? items.filter(i => i.kind !== 'artifact') : items.filter(undoable);
  if (!list.length && !steps.length) return '';
  const row = i => {
    const [c, w] = which === 'setup' ? FX_SETUP[i.status] ?? ['muted', i.status]
      : FX_UNDO[i.status] ?? (['done', 'pending'].includes(i.status) ? ['warn', 'not undone yet (CLEAN UP)'] : ['muted', 'nothing to undo']);
    const err = which === 'setup' ? i.error : i.undoError;
    return `<li><span class="badge ${c}">${h(w)}</span> ${h(i.name)} <span class="muted">${i.kind === 'artifact' ? 'artifact cleanup' : i.kind === 'steps' ? 'browser steps' : 'hooks'}</span>${err ? `<div class="bad">${h(err)}</div>` : ''}</li>`;
  };
  const bad = list.some(i => (which === 'setup' ? i.status === 'failed' : i.status === 'undo-failed' || (undoable(i) && ['done', 'pending'].includes(i.status)))) || steps.some(x => x.ok === false);
  return `<div class="board board-strip ${bad ? 'board-bad' : ''}"><div class="board-body"><div class="board-head"><span class="board-num ${bad ? 'bad' : 'ok'}">${which === 'setup' ? '0' : '⏹'}</span>
    <b>${which === 'setup' ? 'Setup' : 'Teardown'}</b> <span class="badge offcam">🎥 off camera · ${which === 'setup' ? 'before scene 1' : 'after the last scene'}</span></div>
    <ul class="fx-items">${list.map(row).join('')}${steps.length ? `<li class="muted">${steps.length} browser step(s)${steps.some(x => x.ok === false) ? ', some failed' : ''}</li>` : ''}</ul></div></div>`;
}

/** What the run created: each pinned artifact, its fields (secrets as ●●●), where it was made, a still, its cleanup. */
function artifactsBoard(id, artifacts, tourPath) {
  if (!artifacts.length) return '';
  const CL = { undone: ['ok', 'cleaned up'], 'to undo': ['warn', 'not cleaned up yet'], 'undo-failed': ['bad', 'cleanup failed'], none: ['muted', 'no cleanup'], 'read-only': ['muted', 'read only'] };
  return `<div class="card"><h3>Artifacts <span class="muted">what this run created</span></h3><div class="artifacts">${artifacts.map(a => {
    const n = Number(String(a.scene ?? '').slice(6)) || null, at = a.scriptStep ?? a.step;
    const where = a.scene === 'setup' ? 'created by setup' : n ? `created in scene ${n}${at ? `, step ${at}` : ''}` : '';
    const link = tourPath && n ? `<a href="#/write/${encodeURIComponent(tourPath)}?scene=${n}&step=${at ?? ''}">${h(where)}</a>` : h(where);
    const [c, w] = CL[a.cleanup] ?? ['muted', a.cleanup];
    return `<div class="artifact">${a.shot ? `<a href="${fileUrl(id, a.shot)}" target="_blank"><img src="${fileUrl(id, a.shot)}" alt="where ${h(a.name)} came from"></a>` : '<div class="noshot muted">no still</div>'}
      <div><div><b>${h(a.name)}</b>${a.role ? ` <span class="badge">${h(a.role)}</span>` : ''} <span class="badge ${c}" title="${h(a.cleanupError ?? '')}">${h(w)}</span></div>
        <table class="fields">${Object.entries(a.fields ?? {}).map(([k, v]) => `<tr><td class="muted">${h(k)}</td><td>${(a.secret ?? []).includes(k) ? '●●●' : `<code>${h(v)}</code>`}</td></tr>`).join('')}</table>
        <div class="muted">${link}${a.cleanupError ? ` · <span class="bad">${h(a.cleanupError)}</span>` : ''}</div></div></div>`; }).join('')}</div></div>`;
}

const views = {
  // ---------- advanced screens ----------
  async runs() {
    const runs = await api('/api/runs');
    const names = [...new Set(runs.map(r => r.name))].sort();
    const sel = new URLSearchParams(location.hash.split('?')[1]).get('name') ?? '';
    const shown = sel ? runs.filter(r => r.name === sel) : runs;
    $app.innerHTML = `<h2>Runs</h2>
      <div class="toolbar"><select id="f"><option value="">all tours (${runs.length})</option>
        ${names.map(n => `<option ${n === sel ? 'selected' : ''}>${h(n)}</option>`).join('')}</select>
        <button id="rf">Refresh</button></div>
      <table class="runs"><tr><th>status</th><th>tour</th><th>command</th><th>started</th><th>took</th><th>video</th><th>error</th><th></th></tr>
      ${shown.map(r => `<tr class="click" data-id="${h(r.id)}"><td>${status(r)}</td><td>${h(r.name)}</td><td>${h(r.command)}</td>
        <td title="${h(r.startedAt)}">${ago(r.startedAt)}</td><td>${dur(r.startedAt, r.finishedAt)}</td>
        <td>${r.seconds ? `${Math.round(r.seconds)} s` : ''}</td><td class="muted">${h((r.error ?? '').slice(0, 140))}</td>
        <td><button class="icon-btn del" data-delrun="${h(r.id)}" title="Delete this run" aria-label="Delete this run">🗑</button></td></tr>`).join('')}
      </table>`;
    $app.querySelector('#f').onchange = e => (location.hash = `#/runs${e.target.value ? `?name=${encodeURIComponent(e.target.value)}` : ''}`);
    $app.querySelector('#rf').onclick = () => render();
    $app.querySelectorAll('tr[data-id]').forEach(tr => (tr.onclick = () => (location.hash = `#/run/${tr.dataset.id}`)));
    $app.querySelectorAll('[data-delrun]').forEach(b => (b.onclick = async e => {
      e.stopPropagation();
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'sure?'; return; }
      try { await api('/api/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'run', path: b.dataset.delrun }) }); render(); }
      catch (err) { b.textContent = '⚠'; b.title = err.message; }
    }));
    if (runs.some(r => r.status === 'running')) setTimeout(() => location.hash.startsWith('#/runs') && render(), 4000);
  },

  async run(id) {
    const d = await api(`/api/run?id=${encodeURIComponent(id)}`);
    const r = d.run ?? {}, rep = d.report, has = f => d.files.some(x => x.path === f);
    const input = r.input?.[0];
    const failedStep = rep?.steps?.find(s => s.ok === false);
    const fc = rep?.firstCause;
    const cause = fc ? (fc.kind === 'network' ? `${fc.method} ${String(fc.request).replace(/\?.*$/, '')} ${fc.status ?? fc.failure}`
      : fc.kind === 'workaround' ? `known issue "${fc.name}"` : String(fc.text ?? '').split('\n')[0]) + (fc.stepKey ? ` (during ${fc.stepKey})` : '') : '';
    $app.innerHTML = `<h2>${h(r.name)} <span class="muted">/ ${h(id.split('/')[1])}</span> ${status({ ...r, class: rep?.class ?? r.class })}</h2>
      <div class="toolbar">
        <a href="#/runs?name=${encodeURIComponent(r.name)}">← all runs of ${h(r.name)}</a>
        <a href="#/compare/${h(id)}" title="What changed since the previous run of this script">⇄ compare with the previous run</a>
        ${input && /tour\.json$/.test(input) ? `${/^(platforms|out)\//.test(rel(input)) ? `<a href="#/edit/${encodeURIComponent(rel(input))}">Edit tour</a>`
            : `<span class="muted" title="${h(input)}">tour outside this checkout</span>`}
          <button data-cmd="validate">Validate again</button><button data-cmd="run" class="primary">Run again</button>` : ''}
        ${failedStep ? `<button data-cmd="run" data-extra="--headed --pause">Replay headed (pause at failure)</button>` : ''}
      </div>
      <div class="grid"><div>
        ${has('tour.mp4') ? `<div class="card"><video controls preload="metadata" src="${fileUrl(id, 'tour.mp4')}">
            ${has('tour.vtt') ? `<track default kind="captions" src="${fileUrl(id, 'tour.vtt')}">` : ''}</video>
            <div id="markers"></div></div>`
          : has('screens/failure.png') ? `<div class="card"><img class="shot" src="${fileUrl(id, 'screens/failure.png')}"></div>` : ''}
        ${r.status !== 'done' || rep ? `<div class="card summary"><h3>Summary</h3>
          <div><b>status</b>${h(r.status)}${rep?.complete === false ? ' (incomplete)' : ''}</div>
          ${r.error ? `<div><b>what failed</b>${h(r.error)}</div>` : ''}
          ${cause ? `<div><b>first cause</b>${h(cause)}</div>` : ''}
          ${rep?.criteria ? `<div><b>criteria</b>${h(Object.entries(rep.criteria).map(([k, v]) => `${k}: ${typeof v === 'object' ? v.status ?? JSON.stringify(v) : v}`).join(' · '))}</div>` : ''}
          ${rep?.warnings?.length ? `<div><b>warnings</b>${rep.warnings.length}</div>` : ''}</div>` : ''}
        ${rep?.steps ? `<div class="card"><h3>Steps</h3><table><tr><th></th><th>scene</th><th>#</th><th>step</th><th>ms</th></tr>
          ${rep.steps.map(s => `<tr><td>${s.ok === false ? '<span class="bad">✘</span>' : s.ok ? '<span class="ok">✔</span>' : '·'}</td>
            <td>${h(s.scene)}</td><td>${h(s.step)}</td><td><code>${h(JSON.stringify(s.spec ?? s.action))}</code>
            ${s.error ? `<div class="bad">${h(s.error)}</div>` : ''}${s.suggestions?.length ? `<div class="muted">did you mean: ${h(s.suggestions.join(', '))}</div>` : ''}</td>
            <td>${s.ms ?? ''}</td></tr>`).join('')}</table></div>` : ''}
        <div id="stage-box"></div><div id="review"></div><div id="story"></div>
        ${has('validation.md') ? `<details class="card"><summary><b>validation.md</b> <span class="muted">(raw)</span></summary><pre id="val"></pre></details>` : ''}
      </div><div>
        ${has('report.md') ? `<div class="card"><h3>report.md</h3><pre id="repmd"></pre></div>` : ''}
        ${has('triage/page/aria.yml') ? `<div class="card"><h3>ARIA at failure</h3><pre id="aria"></pre></div>` : ''}
        <div class="card files"><h3>Files</h3>${d.files.map(f => `<a href="${fileUrl(id, f.path)}" target="_blank">${h(f.path)}
          <span class="muted">${f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.ceil(f.size / 1024)} KB`}</span></a>`).join('')}</div>
      </div></div>`;
    const fill = async (sel, f) => { const el = $app.querySelector(sel); if (el) el.textContent = await (await fetch(fileUrl(id, f))).text(); };
    fill('#val', 'validation.md');
    const video = $app.querySelector('video');
    if (video && has('tour.vtt')) runTour(id, d, input).then(tour => mountMarkers($app.querySelector('#markers'), video,
      { vttUrl: fileUrl(id, 'tour.vtt'), scenes: filmedScenes(d.files, tour) })).catch(() => {});
    mountReview($app.querySelector('#review'), { id, d, input, h, api, rel, fileUrl, onCheckAgain: p => startJob(['validate', p]) }).catch(e => console.error(e));
    storyboard(id, d, input).then(async html => {
      const el = $app.querySelector('#story');
      if (!el) return;
      el.innerHTML = html;
      if (!el.querySelector('[data-stage]')) return;
      const tour = await runTour(id, d, input);
      const pd = tour?.platform ? await api(`/api/platform?name=${encodeURIComponent(tour.platform)}`).catch(() => null) : null;
      await mountStage(el, $app.querySelector('#stage-box'), { source: `out/${id}`, tourName: null, envs: pd?.environments ?? [],
        defaultEnv: r.args?.target ?? r.args?.env ?? tour?.env ?? pd?.default ?? null, roles: [], defaultRole: tour?.role ?? null, runLink: x => `#/run/${x}` });
    }).catch(e => console.error(e)); fill('#repmd', 'report.md'); fill('#aria', 'triage/page/aria.yml');
    $app.querySelectorAll('button[data-cmd]').forEach(b => (b.onclick = () =>
      startJob([b.dataset.cmd, rel(input), ...(b.dataset.extra ? b.dataset.extra.split(' ') : [])])));
    if (r.status === 'running') setTimeout(() => location.hash === `#/run/${id}` && render(), 3000);
  },

  /** Two runs of the same script side by side: outcome, criteria, and every step that changed. */
  async compare(id) {
    const runs = await api('/api/runs');
    const a = runs.find(r => r.id === id);
    if (!a) throw new Error('no such run');
    const q = new URLSearchParams(location.hash.split('?')[1]);
    const same = runs.filter(r => r.name === a.name && r.id !== id && ['validate', 'run', 'render'].includes(r.command));
    const b = same.find(r => r.id === q.get('with')) ?? same.find(r => String(r.startedAt) < String(a.startedAt)) ?? same[0] ?? null;
    if (!b) { $app.innerHTML = `<h2>Compare</h2><p class="muted">${h(a.name)} has no other run to compare with.</p><a href="#/run/${h(id)}">← back to the run</a>`; return; }
    const all = q.get('all') === '1';
    const pick = `<select id="with">${same.map(r => `<option value="${h(r.id)}" ${b.id === r.id ? 'selected' : ''}>${h(r.id.split('/')[1])} · ${h(r.command)} · ${h(r.verdictLabel ?? r.status)}</option>`).join('')}</select>`;
    const [da, db] = await Promise.all([api(`/api/run?id=${encodeURIComponent(a.id)}`), api(`/api/run?id=${encodeURIComponent(b.id)}`)]);
    const [sa, sb] = await Promise.all([runSteps(a.id, da), runSteps(b.id, db)]);
    // steps match by scene and number (the script's own step number when the report has it)
    const key = s => `${String(s.scene ?? '').replace(/\s.*$/, '')} · ${/\(url\)/.test(s.scene ?? '') ? 'open page' : `step ${s.scriptStep ?? s.step}`}`;
    const ma = new Map(sa.map(s => [key(s), s])), mb = new Map(sb.map(s => [key(s), s]));
    const spec = s => (s ? JSON.stringify(s.spec ?? s.action ?? '') : '');
    const rows = [...new Set([...mb.keys(), ...ma.keys()])].map(k => {
      const x = mb.get(k), y = ma.get(k);
      const changed = !x ? 'only now' : !y ? 'only before' : x.ok !== y.ok ? (y.ok === false ? 'worse' : 'better') : spec(x) !== spec(y) ? 'edited' : '';
      return { k, x, y, changed };
    });
    const shown = all ? rows : rows.filter(r => r.changed);
    const mark = s => !s ? '<span class="muted">—</span>' : s.ok === false ? `<span class="bad">✘</span>${s.optional ? ' <span class="muted">optional</span>' : ''}` : s.ok ? '<span class="ok">✔</span>' : '·';
    const ms = s => (s?.ms != null ? ` <span class="muted">${s.ms} ms</span>` : '');
    const ca = da.report?.criteria ?? {}, cb = db.report?.criteria ?? {};
    const cv = v => (v == null ? '—' : typeof v === 'object' ? v.status ?? JSON.stringify(v) : String(v));
    const verdict = r => `${status(r)} ${h(r.verdictLabel ?? '')}`;
    const runCell = r => `<td><a href="#/run/${h(r.id)}">${h(r.id.split('/')[1])}</a><div class="muted">${h(r.command)} · ${ago(r.startedAt)}</div></td>`;
    const BADGE = { worse: 'bad', better: 'ok' };
    $app.innerHTML = `<h2>Compare <span class="muted">${h(a.name)}</span></h2>
      <div class="toolbar"><a href="#/run/${h(id)}">← back to the run</a> <span>before:</span> ${pick}
        <label><input type="checkbox" id="all" ${all ? 'checked' : ''}> every step, not just the changes</label></div>
      <div class="card"><table class="compare"><tr><th></th><th>before</th><th>now</th></tr>
        <tr><td>run</td>${runCell(b)}${runCell(a)}</tr>
        <tr><td>result</td><td>${verdict(b)}</td><td>${verdict(a)}</td></tr>
        <tr><td>took</td><td>${dur(b.startedAt, b.finishedAt)}</td><td>${dur(a.startedAt, a.finishedAt)}</td></tr>
        <tr><td>video</td><td>${b.seconds ? `${Math.round(b.seconds)} s` : '—'}</td><td>${a.seconds ? `${Math.round(a.seconds)} s` : '—'}</td></tr>
        <tr><td>open findings</td><td>${b.openFindings ?? '—'}</td><td>${a.openFindings ?? '—'}</td></tr>
        ${[...new Set([...Object.keys(cb), ...Object.keys(ca)])].map(k => `<tr class="${cv(cb[k]) !== cv(ca[k]) ? 'changed' : ''}"><td>criterion ${h(k)}</td><td>${h(cv(cb[k]))}</td><td>${h(cv(ca[k]))}</td></tr>`).join('')}
        ${a.error || b.error ? `<tr><td>what failed</td><td class="bad">${h(b.error ?? '')}</td><td class="bad">${h(a.error ?? '')}</td></tr>` : ''}</table></div>
      <div class="card"><h3>Steps <span class="muted">${rows.filter(r => r.changed).length} changed of ${rows.length}</span></h3>
        <table class="compare"><tr><th>where</th><th>before</th><th>now</th><th></th><th>step</th></tr>
        ${shown.map(({ k, x, y, changed }) => `<tr class="${changed ? 'changed' : ''}"><td>${h(k)}</td><td>${mark(x)}${ms(x)}</td><td>${mark(y)}${ms(y)}</td>
          <td>${changed ? `<span class="badge ${BADGE[changed] ?? 'warn'}">${h(changed)}</span>` : ''}</td>
          <td><code>${h(spec(y ?? x).slice(0, 120))}</code>${changed === 'edited' ? `<div class="muted">was <code>${h(spec(x).slice(0, 120))}</code></div>` : ''}
            ${y?.error ? `<div class="bad">${h(y.error)}</div>` : x?.error && y?.ok ? `<div class="muted">was: ${h(x.error)}</div>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">no step changed</td></tr>'}</table></div>`;
    const go = (w, everything) => (location.hash = `#/compare/${id}?with=${encodeURIComponent(w)}${everything ? '&all=1' : ''}`);
    $app.querySelector('#with').onchange = e => go(e.target.value, all);
    $app.querySelector('#all').onchange = e => go(b.id, e.target.checked);
  },

  /** Deleted scripts, apps, files and runs (moved under out/.trash/), each with RESTORE. */
  async trash() {
    const items = await api('/api/trash');
    const KIND = { run: 'run', platform: 'app', file: 'file' };
    const open = p => /^platforms\/[^/]+\/tours\/.+\.tour\.json$/.test(p) ? `#/tour/${encodeURIComponent(p)}` : /^platforms\/[^/]+$/.test(p) ? `#/platform/${encodeURIComponent(p.split('/')[1])}`
      : /^platforms\//.test(p) ? `#/edit/${encodeURIComponent(p)}` : /^out\//.test(p) ? `#/run/${p.slice(4)}` : null;
    $app.innerHTML = `<h2>Trash <span class="muted">deleted items wait in out/.trash/ until that folder is removed</span></h2>
      <table><tr><th>what</th><th>kind</th><th>deleted</th><th></th></tr>
      ${items.map(i => `<tr><td><code>${h(i.path)}</code></td><td>${h(KIND[i.kind] ?? i.kind)}</td><td title="${h(i.deletedAt ?? i.stamp)}">${i.deletedAt ? ago(i.deletedAt) : h(i.stamp)}</td>
        <td>${i.exists ? '<span class="muted" title="Something with that name exists again: delete or rename it first">its place is taken</span>' : `<button data-restore="${h(i.id)}">↩ restore</button>`}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">The trash is empty.</td></tr>'}</table>`;
    $app.querySelectorAll('[data-restore]').forEach(b => (b.onclick = async () => {
      try {
        const r = await api('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: b.dataset.restore }) });
        const link = open(r.restored);
        b.outerHTML = `<span class="ok">restored</span>${link ? ` <a href="${h(link)}">open</a>` : ''}`;
      } catch (e) { b.textContent = '⚠'; b.title = e.message; }
    }));
  },

  async tours() {
    const ps = await api('/api/platforms');
    $app.innerHTML = `<h2>Tours</h2>
      <div class="toolbar"><label>speech <select id="speech"><option value="">default</option><option>silent</option></select></label></div>
      ${ps.map(p => `<div class="card"><h3>${h(p.name)} <span class="muted">env: ${h(p.environments.join(', ') || '—')}${p.default ? ` (default ${h(p.default)})` : ''}</span>
        <button data-check="${h(p.name)}">platform check</button></h3>
        <table>${p.tours.map(t => `<tr><td>${h(t.file)}</td><td style="text-align:right">
          ${t.file.endsWith('.json') ? `<a href="#/edit/${encodeURIComponent(t.path)}">edit</a>` : '<span class="muted">code tour</span>'}
          <select data-env="${h(t.path)}"><option value="">${h(p.default ?? 'default')}</option>${p.environments.filter(e => e !== p.default).map(e => `<option>${h(e)}</option>`).join('')}</select>
          <button data-cmd="validate" data-tour="${h(t.path)}">validate</button>
          <button data-cmd="render" data-tour="${h(t.path)}">render</button>
          <button data-cmd="run" data-tour="${h(t.path)}" class="primary">run</button></td></tr>`).join('') || '<tr><td class="muted">no tours</td></tr>'}</table></div>`).join('')
      || '<p class="muted">No platforms. <code>aft platform init &lt;name&gt;</code></p>'}`;
    $app.querySelectorAll('button[data-tour]').forEach(b => (b.onclick = () => {
      const env = $app.querySelector(`select[data-env="${CSS.escape(b.dataset.tour)}"]`).value;
      const speech = $app.querySelector('#speech').value;
      startJob([b.dataset.cmd, b.dataset.tour, ...(env ? ['--target', env] : []), ...(speech && b.dataset.cmd !== 'validate' ? ['--speech', speech] : [])]);
    }));
    $app.querySelectorAll('button[data-check]').forEach(b => (b.onclick = () => startJob(['platform', 'check', b.dataset.check])));
  },

  async edit(p) {
    p = decodeURIComponent(p);
    const isPlatform = p.startsWith('platforms/');
    const endpoint = `${isPlatform ? '/api/pfile' : '/api/tour'}?path=${encodeURIComponent(p)}`;
    const t = await api(endpoint);
    const isJson = p.endsWith('.json'), isTour = /(^|[./])tour\.json$/.test(p);
    const platform = isPlatform ? p.split('/')[1] : null;
    // platform.json and environments.json also get a form built from their schema
    const formType = isPlatform && /^platforms\/[^/]+\/(platform|environments)\.json$/.exec(p)?.[1];
    $app.innerHTML = `<h2>${h(p)}</h2>
      <div class="toolbar">${platform && isTour ? `<a class="back" href="#/tour/${encodeURIComponent(p)}">← back</a>` : platform ? `<a href="#/platform/${encodeURIComponent(platform)}">← ${h(platform)}</a>` : ''}
        <button id="save" class="primary">Save</button>
        ${isTour ? '<button id="saveval">Save + validate (dry run)</button>' : ''}
        ${isJson ? '<button id="schema">Save + schema check</button><button id="fmt">Format</button>' : ''}
        ${formType ? '<span class="tabs"><button id="tab-form" class="tab on">Form</button><button id="tab-raw" class="tab">Raw</button></span>' : ''}
        <span id="msg" class="muted"></span></div>
      <div class="${isTour ? 'grid' : ''}"><div>${formType ? '<div id="form" class="card"></div>' : ''}<textarea id="src" spellcheck="false" ${formType ? 'hidden' : ''}></textarea></div>
      ${isTour ? '<div><div class="card"><h3>Scenes</h3><div id="outline"></div></div></div>' : ''}</div>`;
    const src = $app.querySelector('#src'), msg = $app.querySelector('#msg');
    src.value = t.text;
    let dirty = false;
    const outline = () => {
      if (!isJson) { msg.textContent = dirty ? 'unsaved changes' : ''; return; }
      let doc; try { doc = JSON.parse(src.value); msg.textContent = dirty ? 'unsaved changes' : ''; } catch (e) { msg.innerHTML = `<span class="bad">${h(e.message)}</span>`; return; }
      const o = $app.querySelector('#outline');
      if (o) o.innerHTML = (doc.scenes ?? []).map((s, i) => `<div style="margin-bottom:10px">
        <b>${i + 1}. ${h(s.title ?? s.id ?? '')}</b> ${(s.criteria ?? []).map(c => `<span class="badge">AC${h(c)}</span>`).join(' ')}
        <div class="muted">${h(s.narration ?? '')}</div><div class="muted">${(s.steps ?? []).length} steps</div></div>`).join('') || '<span class="muted">no scenes</span>';
    };
    src.oninput = () => { dirty = true; outline(); };
    outline();
    if (formType) {
      const { schema, common } = await api(`/api/schema?type=${formType}`);
      const box = $app.querySelector('#form');
      let form = null;
      // the form edits a parsed copy of the text; every change writes the whole document back into the text
      const showForm = () => {
        let doc; try { doc = JSON.parse(src.value); } catch (e) { msg.innerHTML = `<span class="bad">fix the JSON first (Raw): ${h(e.message)}</span>`; return false; }
        if (form) form.redraw(doc);
        else form = mountSchemaForm(box, { schema, common, doc, onChange: d => { src.value = JSON.stringify(d, null, 2) + '\n'; dirty = true; outline(); } });
        return true;
      };
      const tab = which => {
        if (which === 'form' && !showForm()) return;
        box.hidden = which !== 'form'; src.hidden = which === 'form';
        $app.querySelector('#tab-form').classList.toggle('on', which === 'form');
        $app.querySelector('#tab-raw').classList.toggle('on', which !== 'form');
      };
      $app.querySelector('#tab-form').onclick = () => tab('form');
      $app.querySelector('#tab-raw').onclick = () => tab('raw');
      if (!showForm()) tab('raw');
    }
    const save = async () => {
      await api(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: src.value }) });
      dirty = false;
      msg.innerHTML = `<span class="ok">saved ${new Date().toLocaleTimeString()}</span>`;
    };
    const guard = fn => async () => { try { await fn(); } catch (e) { msg.innerHTML = `<span class="bad">${h(e.message)}</span>`; } };
    src.onkeydown = e => { if (e.key === 'Tab') { e.preventDefault(); src.setRangeText('  ', src.selectionStart, src.selectionEnd, 'end'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); guard(save)(); } };
    $app.querySelector('#save').onclick = guard(save);
    $app.querySelector('#saveval')?.addEventListener('click', guard(async () => { await save(); await startJob(['validate', p]); }));
    $app.querySelector('#schema')?.addEventListener('click', guard(async () => { await save(); await startJob(['validate', p, '--schema-only']); }));
    $app.querySelector('#fmt')?.addEventListener('click', () => { try { src.value = JSON.stringify(JSON.parse(src.value), null, 2) + '\n'; dirty = true; outline(); } catch {} });
    const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  },

  async platforms() {
    const ps = await api('/api/platforms');
    $app.innerHTML = `<h2>Platforms</h2>
      <div class="card"><h3>New platform</h3><div class="toolbar">
        <input id="nname" placeholder="name" size="16"><input id="nurl" placeholder="base URL, e.g. http://localhost:3000/" size="40">
        <label><input type="checkbox" id="nnologin"> no login</label><button id="ninit" class="primary">aft platform init</button></div></div>
      <table><tr><th>platform</th><th>environments</th><th>tours</th></tr>
      ${ps.map(p => `<tr class="click" data-p="${h(p.name)}"><td><b>${h(p.name)}</b></td>
        <td>${p.environments.map(e => e === p.default ? `<b>${h(e)}</b>` : h(e)).join(', ') || '<span class="muted">none (code tours)</span>'}</td>
        <td>${p.tours.length}</td></tr>`).join('')}</table>`;
    $app.querySelectorAll('tr[data-p]').forEach(tr => (tr.onclick = () => (location.hash = `#/platform/${encodeURIComponent(tr.dataset.p)}`)));
    $app.querySelector('#ninit').onclick = () => {
      const name = $app.querySelector('#nname').value.trim(), url = $app.querySelector('#nurl').value.trim();
      if (!/^[\w-]+$/.test(name)) return alertInline('#ninit', 'name: letters, digits, - and _');
      startJob(['platform', 'init', name, ...(url ? ['--base-url', url] : []), ...($app.querySelector('#nnologin').checked ? ['--no-login'] : [])]);
    };
  },

  async platform(name) {
    name = decodeURIComponent(name);
    const d = await api(`/api/platform?name=${encodeURIComponent(name)}`);
    const hasLogin = d.files.some(f => f.rel === 'login.json');
    let roles = [];
    if (hasLogin) {
      try { roles = Object.keys(JSON.parse((await api(`/api/pfile?path=${encodeURIComponent(`platforms/${name}/login.json`)}`)).text).roles ?? {}); } catch {}
    }
    const groups = [['platform', 'Platform'], ['environments', 'Environments'], ['login', 'Login'], ['tour', 'Tours'],
      ['fragment', 'Fragments'], ['fixture', 'Fixtures'], ['mocks', 'Mocks'], ['other', 'Other files']];
    const core = { platform: 'platform.json', environments: 'environments.json', login: 'login.json' };
    const multi = ['tour', 'fragment', 'fixture', 'mocks'];
    const envOpts = `<option value="">${h(d.default ?? 'default')}</option>${d.environments.filter(e => e !== d.default).map(e => `<option>${h(e)}</option>`).join('')}`;
    $app.innerHTML = `<h2>${h(name)}</h2>
      <div class="toolbar"><a href="#/platforms">← platforms</a>
        <label>environment <select id="env">${envOpts}</select></label>
        ${roles.length ? `<label>role <select id="role"><option value="">default</option>${roles.map(r => `<option>${h(r)}</option>`).join('')}</select></label>` : ''}
        <button data-a="check" class="primary">platform check</button>
        <button data-a="doctor">doctor --platform</button>
        ${hasLogin ? '<button data-a="login">login</button><button data-a="loginFresh">login (fresh)</button><button data-a="loginManual">login --manual</button>' : ''}
        <button data-a="discover">discover</button>
        <button data-a="cleanup" title="aft cleanup --platform ${h(name)}: finish the undo of runs that left test data behind">🧹 CLEAN UP${d.cleanup?.items ? ` (${d.cleanup.items})` : ''}</button>
        ${Object.values(d.envInfo ?? {}).some(e => e.reset) ? '<button data-a="reset" title="aft reset: the environment\'s reset hooks (never a shared environment)">↺ reset environment</button>' : ''}
      </div>
      <div class="card"><h3>Environments</h3><table>${Object.entries(d.envInfo ?? {}).map(([e, i]) => `<tr><td><b>${h(e)}</b>${e === d.default ? ' <span class="muted">(default)</span>' : ''}</td>
        <td class="muted">${h(i.baseUrl ?? '')}</td>
        <td>${i.shared ? '<span class="badge warn" title="Other people and runs use it: data a run creates must carry {run.tag}; never reset">shared</span>' : '<span class="badge muted">own</span>'}</td>
        <td>${i.reset ? (i.shared ? '<span class="badge bad">reset (refused: shared)</span>' : '<span class="badge ok" title="aft reset / --reset runs its hooks">can be reset</span>') : '<span class="muted">no reset</span>'}</td></tr>`).join('')}</table></div>
      ${d.cleanup?.runs?.length ? `<div class="card"><h3>Test data left behind <span class="muted">${d.cleanup.items} item(s) in ${d.cleanup.runs.length} run(s)</span></h3>
        <table>${d.cleanup.runs.map(r => `<tr><td><a href="#/run/${h(r.id)}">${h(r.id)}</a> <span class="muted">${h(r.env ?? '')} ${h(r.tag ?? '')}</span></td>
          <td>${r.items.map(i => `<div>${i.status === 'undo-failed' ? '<span class="bad">undo failed</span>' : '<span class="badge warn">not undone</span>'} ${h(i.name)}${i.error ? ` <span class="muted">${h(i.error)}</span>` : ''}</div>`).join('')}</td></tr>`).join('')}</table>
        <p class="muted">CLEAN UP runs each item's undo again (hooks, or browser steps in a signed-in session).</p></div>` : ''}
      <div class="grid"><div>
        ${groups.map(([k, title]) => {
          const list = d.files.filter(f => f.kind === k);
          const missing = core[k] && !list.length ? core[k] : null;
          if (!list.length && !missing && !multi.includes(k)) return '';
          return `<div class="card files"><h3>${title} ${multi.includes(k) ? `<button data-new="${k}">+ new</button>` : ''}</h3>
            ${list.map(f => `<a href="#/edit/${encodeURIComponent(f.path)}">${h(f.rel)} <span class="muted">${Math.ceil(f.size / 1024)} KB</span></a>`).join('')}
            ${missing ? `<a href="#" data-create="${missing}" data-kind="${k}">+ create ${missing}</a>` : ''}
            ${!list.length && !missing ? '<span class="muted">none</span>' : ''}</div>`;
        }).join('')}
      </div><div>
        <div class="card"><h3>Credentials referenced ({env:…})</h3>
          ${d.env.length ? `<table>${d.env.map(e => `<tr><td><code>${h(e.name)}</code></td><td>${e.source ? `<span class="ok">set</span> <span class="muted">(${e.source})</span>` : '<span class="bad">not set</span>'}</td></tr>`).join('')}</table>
            <p class="muted">Values live in the environment or the checkout's <code>.env</code>; the UI never reads or writes them.</p>` : '<span class="muted">none</span>'}</div>
        <div class="card"><h3>Saved sign-ins</h3>${d.logins.length ? `<table>${d.logins.map(l => `<tr><td>${l.legacy ? '<span class="muted">(old layout, not used)</span>' : h(l.env)}</td><td>${h(l.role)}</td><td>${ago(l.savedAt)}</td></tr>`).join('')}</table>` : '<span class="muted">none</span>'}</div>
      </div></div>`;
    const env = () => $app.querySelector('#env').value, role = () => $app.querySelector('#role')?.value ?? '';
    const t = () => [...(env() ? ['--target', env()] : []), ...(role() ? ['--role', role()] : [])];
    const actions = {
      check: () => ['platform', 'check', name, ...(env() ? ['--target', env()] : [])],
      doctor: () => ['doctor', '--platform', name],
      login: () => ['login', '--platform', name, ...t()],
      loginFresh: () => ['login', '--platform', name, ...t(), '--fresh-login'],
      loginManual: () => ['login', '--platform', name, ...t(), '--manual'],
      discover: () => ['platform', 'discover', name, ...t()],
      cleanup: () => ['cleanup', '--platform', name, ...(env() ? ['--target', env()] : [])],
      reset: () => ['reset', '--platform', name, ...(env() ? ['--target', env()] : [])],
    };
    $app.querySelectorAll('button[data-a]').forEach(b => (b.onclick = () => startJob(actions[b.dataset.a]())));
    $app.querySelectorAll('button[data-new]').forEach(b => (b.onclick = () => newFile(name, b.dataset.new, b)));
    $app.querySelectorAll('a[data-create]').forEach(a => (a.onclick = e => { e.preventDefault(); createFile(name, a.dataset.create, a.dataset.kind, a); }));
  },

  async jobs() {
    const js = await api('/api/jobs');
    $app.innerHTML = `<h2>Jobs <span class="muted">(this UI session)</span></h2>
      <table><tr><th>status</th><th>command</th><th>started</th></tr>${js.map(j => `<tr class="click" data-id="${j.id}">
        <td>${!j.done ? '<span class="badge warn">running</span>' : j.exitCode === 0 ? '<span class="badge ok">ok</span>' : `<span class="badge bad">${h(j.result?.class ?? `exit ${j.exitCode}`)}</span>`}</td>
        <td><code>aft ${h(j.args.join(' '))}</code></td><td>${ago(j.startedAt)}</td></tr>`).join('') || '<tr><td class="muted" colspan="3">none yet</td></tr>'}</table>`;
    $app.querySelectorAll('tr[data-id]').forEach(tr => (tr.onclick = () => (location.hash = `#/job/${tr.dataset.id}`)));
  },

  async job(id) {
    const j = await api(`/api/jobs/${id}`);
    $app.innerHTML = `<h2><code>aft ${h(j.args.join(' '))}</code> <span id="st"></span></h2>
      <div class="toolbar"><button id="stop">Stop (Ctrl+C)</button><span id="links"></span></div>
      <pre class="log" id="log"></pre><div id="res"></div>`;
    const log = $app.querySelector('#log'), st = $app.querySelector('#st');
    st.innerHTML = '<span class="badge warn">running</span>';
    const es = new EventSource(`/api/jobs/${id}/events`);
    const runLink = dir => { const m = /[\\/]out[\\/](.+)$/.exec(dir ?? ''); return m ? m[1].replace(/\\/g, '/') : null; };
    es.addEventListener('line', e => {
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
      log.textContent += JSON.parse(e.data) + '\n';
      if (stick) log.scrollTop = log.scrollHeight;
      const m = /out[\\/][^\s]+[\\/]\d{8}-\d{6}-\w+/.exec(JSON.parse(e.data));
      if (m && !$app.querySelector('#links').innerHTML) $app.querySelector('#links').innerHTML = `<a href="#/run/${h(m[0].replace(/\\/g, '/').replace(/^out\//, ''))}">open run folder</a>`;
    });
    es.addEventListener('done', e => {
      es.close();
      const r = JSON.parse(e.data);
      st.innerHTML = r.ok ? '<span class="badge ok">ok</span>' : `<span class="badge bad">${h(r.class ?? `exit ${r.exitCode}`)}</span>`;
      const run = runLink(r.runDir);
      if (run) $app.querySelector('#links').innerHTML = `<a href="#/run/${h(run)}">open run →</a>`;
      $app.querySelector('#res').innerHTML = `<div class="card">${r.error?.message ? `<div class="bad">${h(r.error.message)}</div>` : ''}
        <pre>${h(JSON.stringify(r.data ?? r, null, 2).slice(0, 20000))}</pre></div>`;
    });
    $app.querySelector('#stop').onclick = () => api(`/api/jobs/${id}/stop`, { method: 'POST' });
    return () => es.close();
  },

  async doctor() {
    $app.innerHTML = '<h2>Doctor</h2><p class="muted">checking…</p>';
    const job = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: ['doctor'] }) });
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    es.addEventListener('done', e => {
      es.close();
      const r = JSON.parse(e.data), checks = r.data?.checks ?? [];
      $app.innerHTML = `<h2>Doctor ${r.ok ? '<span class="badge ok">ok</span>' : '<span class="badge bad">problems</span>'}</h2>
        <table>${checks.map(c => `<tr><td>${c.ok ? '<span class="ok">✔</span>' : c.level === 'warn' || c.warn ? '<span class="warn">!</span>' : '<span class="bad">✘</span>'}</td>
          <td>${h(c.name ?? c.check)}</td><td class="muted">${h(c.detail ?? c.message ?? c.fix ?? '')}</td></tr>`).join('')}</table>
        ${checks.length ? '' : `<pre>${h(JSON.stringify(r, null, 2))}</pre>`}`;
    });
  },
};

// ---- new platform files from templates ----
const TEMPLATES = {
  platform: () => ({ $schema: '../../schemas/platform.schema.json' }),
  environments: () => ({ $schema: '../../schemas/environments.schema.json', default: 'local', local: { baseUrl: 'http://localhost:3000/' } }),
  login: () => ({ $schema: '../../schemas/login.schema.json', default: 'user', roles: { user: { steps: [] } } }),
  fragment: () => ({ $schema: '../../../schemas/fragment.schema.json', params: {}, steps: [] }),
  fixture: () => ({ $schema: '../../../schemas/fixture.schema.json', data: {} }),
  mocks: () => ({ $schema: '../../../schemas/mocks.schema.json', mocks: [{ mock: '/api/example', json: { ok: true } }] }),
  tour: (platform, n) => ({ $schema: '../../../schemas/tour.schema.json', name: n, platform,
    scenes: [{ title: 'First scene', narration: '', steps: [] }] }),
};
const DIRS = { fragment: 'fragments', fixture: 'fixtures', mocks: 'mocks', tour: 'tours' };
function alertInline(sel, text) {
  const el = typeof sel === 'string' ? $app.querySelector(sel) : sel;
  let m = el.parentElement.querySelector('.inline-msg');
  if (!m) { m = document.createElement('span'); m.className = 'inline-msg bad'; el.after(m); }
  m.textContent = ` ${text}`;
}
async function createFile(platform, file, kind, anchor, name) {
  const p = `platforms/${platform}/${file}`;
  try {
    await api(`/api/pfile?path=${encodeURIComponent(p)}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create: true, text: JSON.stringify(TEMPLATES[kind](platform, name), null, 2) + '\n' }) });
    location.hash = `#/edit/${encodeURIComponent(p)}`;
  } catch (e) { alertInline(anchor, e.message); }
}
function newFile(platform, kind, button) {
  if (button.nextElementSibling?.classList.contains('newname')) return;
  const box = document.createElement('span');
  box.className = 'newname';
  box.innerHTML = ' <input placeholder="name" size="18"> <button>create</button>';
  button.after(box);
  const input = box.querySelector('input'), go = box.querySelector('button');
  input.focus();
  const create = () => {
    const n = input.value.trim().replace(/\.(tour\.)?json$/, '');
    if (!/^[\w.-]+$/.test(n)) return alertInline(go, 'letters, digits, - _ .');
    createFile(platform, `${DIRS[kind]}/${n}${kind === 'tour' ? '.tour.json' : '.json'}`, kind, go, n);
  };
  go.onclick = create;
  input.onkeydown = e => { if (e.key === 'Enter') create(); };
}

Object.assign(views, simpleViews({ $app, h, api, fileUrl, ago, rel, render: () => render(), TEMPLATES }));

let cleanup = null;
async function render() {
  cleanup?.(); cleanup = null;
  const [route, ...rest] = (location.hash.replace(/^#\//, '').split('?')[0] || 'home').split('/');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#/${({ platform: 'platforms', run: 'runs', compare: 'runs', job: 'jobs', edit: 'platforms', write: '', tour: '', browse: '', new: '' })[route] ?? route}`));
  const view = views[route] ?? views.home;
  try { cleanup = await view(rest.join('/')); } catch (e) { $app.innerHTML = `<p class="bad">${h(e.message)}</p>`; }
}
addEventListener('hashchange', () => { document.querySelector('.burger')?.removeAttribute('open'); render(); });
document.addEventListener('click', e => { const b = document.querySelector('.burger'); if (b?.open && !b.contains(e.target)) b.removeAttribute('open'); });
render();
