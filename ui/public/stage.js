// "Do / redo until here" (aft stage): the ▶ buttons on scenes and steps, the options popover, the stage card and the
// "Live stages" list. A stage runs the tour without recording up to a point and leaves the app live in a headed
// browser, data in place, for testing by hand; ending it undoes that data (or keeps it).
//
// Callers put buttons in their HTML with stageButton(point) and mark the elements a point refers to with
// data-stage-at="setup" | "s<N>" | "s<N>.<J>" (for the highlight), then call mountStage(root, box, opts).

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (url, data) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? r.statusText); return j; });
const getStages = () => fetch('/api/stages').then(r => r.json()).catch(() => []);
const norm = p => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** point: { setup: true } | { scene: n } | { scene: n, step: j } (1-based, as the script reads) */
export const pointArgs = pt => (pt.setup ? ['--setup-only'] : pt.step ? ['--until-scene', String(pt.scene), '--step', String(pt.step)] : pt.scene ? ['--until-scene', String(pt.scene)] : []);
export const pointLabel = pt => (pt.setup ? 'setup only' : pt.step ? `scene ${pt.scene} · step ${pt.step}` : pt.scene ? `the end of scene ${pt.scene}` : 'the whole tour');
const pointKey = pt => (pt.setup ? 'setup' : pt.step ? `s${pt.scene}.${pt.step}` : pt.scene ? `s${pt.scene}` : 'all');
/** The stage's own point (from aft stage's state) in the same shape. */
const fromStage = p => (p?.setupOnly ? { setup: true } : p?.untilScene ? { scene: p.untilScene, ...(p.step ? { step: p.step } : {}) } : {});

/** A ▶ button for a point; compact for step rows (shown on hover). */
export function stageButton(pt, { compact = false } = {}) {
  const label = pt.setup ? '▶ Setup only' : compact ? '▶' : pt.scene ? '▶ Do until here' : '▶ Do it all (no video)';
  return `<button type="button" class="stage-btn ${compact ? 'compact' : ''}" data-stage='${esc(JSON.stringify(pt))}' title="Do until here: run the script up to ${esc(pointLabel(pt))} without recording, then test by hand from there">${label}</button>`;
}

// A stage job keeps running when the page redraws: its log is kept here, per source.
const jobs = new Map();   // source → { lines, done, result, args, listeners }

function runStageJob(source, args, onEvent) {
  const j = { lines: [], done: false, result: null, args, listeners: new Set([onEvent]) };
  jobs.set(source, j);
  post('/api/jobs', { args }).then(job => {
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    es.addEventListener('line', e => { j.lines.push(JSON.parse(e.data)); j.listeners.forEach(l => l('line')); });
    es.addEventListener('done', e => { es.close(); j.done = true; j.result = JSON.parse(e.data); j.listeners.forEach(l => l('done')); });
  }).catch(e => { j.done = true; j.result = { ok: false, error: { message: e.message } }; j.listeners.forEach(l => l('done')); });
  return j;
}

/**
 * Wires the ▶ buttons under root and keeps the stage card in box.
 * opts: source (tour path or run folder, as `aft stage` takes it), tourFile (platforms/…/x.tour.json, to find its
 * stage), tourName, envs [names], defaultEnv, roles [names], defaultRole, runLink(id) → href.
 */
export async function mountStage(root, box, opts) {
  const { source, envs = [], roles = [] } = opts;
  let stages = [], popover = null, pendingForce = null;
  const mine = () => stages.filter(s => (opts.tourFile && norm(s.tourFile) === norm(opts.tourFile)) || (opts.tourName && s.tour === opts.tourName) || (s.sourceRun && norm(`out/${s.sourceRun}`) === norm(source)));
  const live = () => mine().find(s => s.alive);
  const highlight = () => {
    root.querySelectorAll('.stage-here,.stage-before').forEach(el => el.classList.remove('stage-here', 'stage-before'));
    const s = live();
    if (!s) return;
    const pt = fromStage(s.point), key = pointKey(pt);
    const here = root.querySelector(`[data-stage-at="${key}"]`);
    here?.classList.add('stage-here');
    // Everything before the point ran: scenes before it, and the steps before it in its scene.
    root.querySelectorAll('[data-stage-at]').forEach(el => {
      const m = /^s(\d+)(?:\.(\d+))?$/.exec(el.dataset.stageAt);
      if (!m || el === here) return;
      const [n, j] = [Number(m[1]), m[2] ? Number(m[2]) : null];
      if (pt.setup) return;
      if (!pt.scene ? true : n < pt.scene || (n === pt.scene && j !== null && (!pt.step || j <= pt.step))) el.classList.add('stage-before');
    });
  };
  const job = () => jobs.get(source);
  const logHtml = () => {
    const j = job();
    if (!j) return '';
    const last = j.lines.slice(-14).map(l => l.replace(/^\d\d:\d\d:\d\d /, '')).join('\n');
    const err = j.done && !j.result?.ok ? (j.result?.error?.message ?? 'it failed') : '';
    const undoFail = /undo step\(s\) failed.*--force/.test(err);
    return `<div class="stage-log ${j.done ? '' : 'running'}"><div class="stage-log-head">${j.done ? (j.result?.ok ? '✔ done' : '✘ ' + esc(err.slice(0, 300))) : '⏳ working…'}
        <code>aft ${esc(j.args.join(' '))}</code>${j.done ? ' <button type="button" class="link" data-stage-act="hidelog">hide</button>' : ''}</div>
      ${undoFail ? `<div>The current stage's data couldn't all be undone (it stays in its ledger for CLEAN UP). <button type="button" class="stage-act" data-stage-act="force">Stage anyway</button></div>` : ''}
      <pre>${esc(last)}</pre></div>`;
  };
  const card = s => {
    const STATE = { staging: ['warn', '⏳ staging'], staged: ['ok', '● live'], failed: ['bad', '✘ failed'], ended: ['muted', 'ended'], dead: ['bad', 'process gone'], starting: ['warn', '⏳ starting'] };
    const [c, w] = STATE[s.state] ?? ['muted', s.state];
    const runHref = s.run && opts.runLink ? opts.runLink(s.run) : null;
    return `<div class="stage-card ${c}">
      <div class="stage-head"><span class="badge ${c}">${esc(w)}</span> <b>Live stage</b> <span class="muted">${esc(s.reached ?? pointLabel(fromStage(s.point)))}</span>
        ${s.env ? `<span class="badge">${esc(s.env)}</span>` : ''}${s.as ? `<span class="badge" title="The browser is signed in as this role">as ${esc(s.as)}</span>` : ''}
        ${s.tag ? `<span class="badge muted" title="Run tag: {run.tag} in what this stage created">${esc(s.tag)}</span>` : ''}</div>
      ${s.note ? `<div class="stage-note">📝 ${esc(s.note)}</div>` : ''}
      ${s.state === 'failed' ? `<div class="bad">What failed: ${esc(s.error ?? '')}</div><div class="muted">The browser stays open at the failure.${runHref ? ` <a href="${runHref}">See what happened (review, suggest a fix) →</a>` : ''}</div>` : ''}
      ${s.state === 'dead' ? '<div class="bad">Its process is gone (closed or crashed). End it to undo its data.</div>' : ''}
      ${s.url ? `<div>at <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>` : ''}
      ${s.artifacts?.length ? `<div><b>Created:</b> ${s.artifacts.map(a => `<span class="badge pin">📌 ${esc(a.name)}</span> ${Object.entries(a.fields ?? {}).map(([k, v]) => `<span class="muted">${esc(k)}</span> <code>${esc(v)}</code>`).join(' ')}`).join(' · ')}</div>` : ''}
      ${s.toUndo?.length ? `<div><b>Ending undoes</b> (newest first): ${s.toUndo.slice().reverse().map(i => esc(i.name)).join(', ')}</div>` : '<div class="muted">Nothing to undo when it ends.</div>'}
      ${s.warnings?.length ? `<div class="warn">${s.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="stage-actions">
        ${s.alive && s.state !== 'failed' && s.url ? '<button type="button" class="stage-act" data-stage-act="open" title="Bring the browser window to the front">↗ Open</button>' : ''}
        <button type="button" class="stage-act primary" data-stage-act="redo" title="Undo what it created, then do it again up to the same point">↻ Redo until here</button>
        <button type="button" class="stage-act" data-stage-act="move" title="Pick ▶ on another scene or step: the current stage is undone first">⇢ Move to…</button>
        <button type="button" class="stage-act" data-stage-act="end" title="Close the browser and undo what it created">■ End &amp; clean up</button>
        <button type="button" class="stage-act" data-stage-act="keep" title="Close the browser and leave the data (CLEAN UP undoes it later)">■ End, keep data</button>
        ${runHref ? `<a href="${runHref}">run folder</a>` : ''}</div></div>`;
  };
  const draw = () => {
    const s = mine().find(x => x.alive) ?? mine()[0];
    box.innerHTML = `${s ? card(s) : ''}${logHtml()}`;
    highlight();
    box.querySelectorAll('[data-stage-act]').forEach(b => (b.onclick = () => act(b.dataset.stageAct, s)));
  };
  const refresh = async () => { stages = await getStages(); if (box.isConnected) draw(); };
  const listen = ev => { if (!box.isConnected) return; if (ev === 'done') refresh(); else draw(); };
  const start = (pt, extra = {}) => {
    const cur = live() ?? mine()[0];
    const args = ['stage', source, ...pointArgs(pt), ...(extra.env ? ['--target', extra.env] : []), ...(extra.as ? ['--as', extra.as] : []),
      ...(extra.keep ? ['--keep'] : []), ...(cur ? ['--redo'] : []), ...(extra.force ? ['--force'] : [])];
    pendingForce = { pt, extra };
    runStageJob(source, args, listen);
    draw();
  };
  async function act(what, s) {
    if (what === 'hidelog') { jobs.delete(source); return draw(); }
    if (what === 'force' && pendingForce) return start(pendingForce.pt, { ...pendingForce.extra, force: true });
    if (!s) return;
    if (what === 'open') { await post('/api/stage-open', { name: s.name }).catch(e => alert(e.message)); return; }
    if (what === 'redo') return start(fromStage(s.point), { env: s.env, as: s.as && s.as !== s.role ? s.as : '', keep: s.keep });
    if (what === 'move') { root.classList.add('stage-moving'); box.querySelector('.stage-card')?.insertAdjacentHTML('beforeend', '<div class="hint">Now pick ▶ on the scene or step to move to.</div>'); return; }
    if (what === 'end' || what === 'keep') {
      runStageJob(source, ['stage', 'end', s.name, ...(what === 'keep' ? ['--keep'] : [])], listen);
      return draw();
    }
  }
  // The options popover: where (environment), as whom (role), keep the data when it ends.
  const openPopover = (btn, pt) => {
    popover?.remove();
    const s = live();
    popover = document.createElement('div');
    popover.className = 'stage-pop';
    popover.innerHTML = `<b>Do until ${esc(pointLabel(pt))}</b>
      <div class="muted">Runs the script without recording, then leaves the app open in a browser for you, with its test data in place.</div>
      ${envs.length > 1 ? `<label>environment <select data-o="env">${envs.map(e => `<option ${e === (s?.env ?? opts.defaultEnv) ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></label>` : ''}
      ${roles.length > 1 ? `<label>hand off as <select data-o="as">${roles.map(r => `<option ${r === (s?.as ?? opts.defaultRole) ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>` : ''}
      ${opts.warn?.() ? `<div class="warn">${esc(opts.warn())}</div>` : ''}
      <label><input type="checkbox" data-o="keep" ${s?.keep ? 'checked' : ''}> keep the data when I end</label>
      ${s ? '<div class="warn">The current stage is undone first (redo).</div>' : ''}
      <div class="stage-actions"><button type="button" class="stage-act primary" data-o="go">▶ Go</button><button type="button" class="stage-act" data-o="cancel">Cancel</button></div>`;
    btn.after(popover);
    popover.querySelector('[data-o="cancel"]').onclick = () => { popover.remove(); popover = null; };
    popover.querySelector('[data-o="go"]').onclick = () => {
      const v = k => popover.querySelector(`[data-o="${k}"]`);
      const env = v('env')?.value ?? '', as = v('as')?.value ?? '';
      start(pt, { env: env && env !== opts.defaultEnv ? env : '', as: as && as !== opts.defaultRole ? as : '', keep: v('keep').checked });
      popover.remove(); popover = null;
      root.classList.remove('stage-moving');
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
  };
  root.querySelectorAll('[data-stage]').forEach(b => (b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    let pt; try { pt = JSON.parse(b.dataset.stage); } catch { return; }
    openPopover(b, pt);
  }));
  const j = job();
  if (j && !j.done) j.listeners.add(listen);
  await refresh();
  // While a stage is staging (or a job runs), poll so the card follows.
  const timer = setInterval(() => { if (!box.isConnected) return clearInterval(timer); if (mine().some(s => s.state === 'staging') || (job() && !job().done)) refresh(); }, 3000);
  return () => clearInterval(timer);
}

/** The start page's "Live stages": every stage, with a link to its script and End. */
export async function mountLiveStages(box, { tourLink = () => null } = {}) {
  const stages = await getStages();
  if (!stages.length) { box.innerHTML = ''; return; }
  const STATE = { staging: 'warn', staged: 'ok', failed: 'bad', dead: 'bad' };
  box.innerHTML = `<div class="group-title">Live stages</div><div class="stage-list">${stages.map(s => `<div class="stage-card ${STATE[s.state] ?? 'muted'}">
      <span class="badge ${STATE[s.state] ?? 'muted'}">${esc(s.state)}</span> <b>${tourLink(s) ? `<a href="${tourLink(s)}">${esc(s.tour ?? s.name)}</a>` : esc(s.tour ?? s.name)}</b>
      <span class="muted">${esc(s.reached ?? pointLabel(fromStage(s.point)))}${s.env ? ` · ${esc(s.env)}` : ''}${s.as ? ` · as ${esc(s.as)}` : ''}</span>
      <span class="stage-actions">${s.alive && s.url ? `<button type="button" class="stage-act" data-open="${esc(s.name)}">↗ Open</button>` : ''}
        <button type="button" class="stage-act" data-end="${esc(s.name)}">■ End &amp; clean up</button></span></div>`).join('')}</div>`;
  box.querySelectorAll('[data-open]').forEach(b => (b.onclick = () => post('/api/stage-open', { name: b.dataset.open }).catch(e => (b.title = e.message))));
  box.querySelectorAll('[data-end]').forEach(b => (b.onclick = () => {
    b.disabled = true; b.textContent = '⏳ ending…';
    runStageJob(`end:${b.dataset.end}`, ['stage', 'end', b.dataset.end], ev => { if (ev === 'done') mountLiveStages(box, { tourLink }); });
  }));
}
