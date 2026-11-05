import { simpleViews } from './simple.js';
// AutoFeatureTour UI: hash-routed, no build step.
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
    ...steps.map(s => String(s.scene ?? '').replace(/\s.*$/, '')).filter(Boolean)])];
  if (!ids.length) return '';
  const base = d.timings?.baseUrl ?? null;
  const pageUrl = u => { try { return base && u ? new URL(u, base.endsWith('/') ? base : base + '/').href : null; } catch { return null; } };
  const shot = sid => has(`screens/${sid}.png`) ? fileUrl(id, `screens/${sid}.png`) : null;
  const what = sp => { if (!sp || typeof sp !== 'object') return String(sp ?? '');
    const k = Object.keys(sp).find(x => !['criterion', 'optional', 'timeout', 'retries', 'comment', 'from'].includes(x)) ?? '';
    const v = sp[k]; const t = typeof v === 'string' ? v : v && typeof v === 'object' ? (v.name ?? v.text ?? v.label ?? v.css ?? v.url ?? v.use ?? JSON.stringify(v)) : String(v);
    const extra = sp.text && k !== 'text' && typeof sp.text === 'string' ? ` "${sp.text.slice(0, 40)}"` : sp.state ? ` (${sp.state})` : '';
    return `${k} ${String(t).slice(0, 80)}${extra}`; };
  return `<div class="card"><h3>Scenes</h3>${ids.map(sid => {
    const n = Number(sid.slice(6)), sc = scenes[n - 1] ?? {};
    const own = steps.filter(s => String(s.scene ?? '').replace(/\s.*$/, '') === sid);
    const bad = own.some(s => s.ok === false && !s.optional);
    const url = pageUrl(sc.url), img = shot(sid);
    return `<div class="board ${bad ? 'board-bad' : ''}" id="board-${sid}">
      <div class="board-shot">${img ? `<a href="${img}" target="_blank" title="Open the full screenshot"><img src="${img}" loading="lazy" alt="${h(sid)} at its end"></a>` : '<div class="noshot muted">no screenshot</div>'}</div>
      <div class="board-body">
        <div class="board-head"><span class="board-num ${bad ? 'bad' : own.length ? 'ok' : ''}">${n}</span><b>${h(sc.title ?? sid)}</b>
          ${sc.criteria?.length ? `<span class="badge muted">AC ${h(sc.criteria.join(', '))}</span>` : ''}
          ${url ? `<a class="board-link" href="${h(url)}" target="_blank" title="${h(url)}">open in the app ↗</a>` : ''}
          ${tourPath ? `<a class="board-link" href="#/write/${encodeURIComponent(tourPath)}?scene=${n}">edit scene ✏️</a>` : ''}</div>
        ${sc.narration ? `<p class="board-narr">“${h(sc.narration)}”</p>` : ''}
        <ol class="board-steps">${own.map(s => {
          const isUrl = /\(url\)/.test(s.scene ?? '');
          const edit = tourPath && !isUrl && !s.from ? `<a href="#/write/${encodeURIComponent(tourPath)}?scene=${n}&step=${s.step}" title="Edit this step">✏️</a>` : '';
          return `<li class="${s.ok === false ? (s.optional ? 'warn' : 'bad') : ''}"><span class="${s.ok === false ? 'bad' : s.ok ? 'ok' : 'muted'}">${s.ok === false ? '✘' : s.ok ? '✔' : '·'}</span>
            <code>${h(isUrl ? `open ${s.spec?.goto ?? sc.url ?? ''}` : what(s.spec ?? s.action))}</code>${s.from ? ` <span class="muted">(${h(s.from)})</span>` : ''} ${edit}
            ${s.error ? `<div class="bad">${h(s.error)}</div>` : ''}${s.suggestions?.length ? `<div class="muted">did you mean: ${h(s.suggestions.join(', '))}</div>` : ''}</li>`; }).join('')
          || '<li class="muted">no steps ran</li>'}</ol></div></div>`; }).join('')}</div>`;
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
    const scenes = d.timings?.scenes ?? [];
    $app.innerHTML = `<h2>${h(r.name)} <span class="muted">/ ${h(id.split('/')[1])}</span> ${status({ ...r, class: rep?.class ?? r.class })}</h2>
      <div class="toolbar">
        <a href="#/runs?name=${encodeURIComponent(r.name)}">← all runs of ${h(r.name)}</a>
        ${input && /tour\.json$/.test(input) ? `${/^(platforms|out)\//.test(rel(input)) ? `<a href="#/edit/${encodeURIComponent(rel(input))}">Edit tour</a>`
            : `<span class="muted" title="${h(input)}">tour outside this checkout</span>`}
          <button data-cmd="validate">Validate again</button><button data-cmd="run" class="primary">Run again</button>` : ''}
        ${failedStep ? `<button data-cmd="run" data-extra="--headed --pause">Replay headed (pause at failure)</button>` : ''}
      </div>
      <div class="grid"><div>
        ${has('tour.mp4') ? `<div class="card"><video controls preload="metadata" src="${fileUrl(id, 'tour.mp4')}">
            ${has('tour.vtt') ? `<track default kind="captions" src="${fileUrl(id, 'tour.vtt')}">` : ''}</video>
            ${scenes.length ? `<div class="scenes">${scenes.map(s => `<span title="${s.start}–${s.end} s in the recording">${h(s.id)}</span>`).join('')}</div>` : ''}</div>`
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
        <div id="story"></div>
        ${has('validation.md') ? `<details class="card"><summary><b>validation.md</b> <span class="muted">(raw)</span></summary><pre id="val"></pre></details>` : ''}
      </div><div>
        ${has('report.md') ? `<div class="card"><h3>report.md</h3><pre id="repmd"></pre></div>` : ''}
        ${has('triage/page/aria.yml') ? `<div class="card"><h3>ARIA at failure</h3><pre id="aria"></pre></div>` : ''}
        <div class="card files"><h3>Files</h3>${d.files.map(f => `<a href="${fileUrl(id, f.path)}" target="_blank">${h(f.path)}
          <span class="muted">${f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.ceil(f.size / 1024)} KB`}</span></a>`).join('')}</div>
      </div></div>`;
    const fill = async (sel, f) => { const el = $app.querySelector(sel); if (el) el.textContent = await (await fetch(fileUrl(id, f))).text(); };
    fill('#val', 'validation.md');
    storyboard(id, d, input).then(html => { const el = $app.querySelector('#story'); if (el) el.innerHTML = html; }).catch(() => {}); fill('#repmd', 'report.md'); fill('#aria', 'triage/page/aria.yml');
    $app.querySelectorAll('button[data-cmd]').forEach(b => (b.onclick = () =>
      startJob([b.dataset.cmd, rel(input), ...(b.dataset.extra ? b.dataset.extra.split(' ') : [])])));
    if (r.status === 'running') setTimeout(() => location.hash === `#/run/${id}` && render(), 3000);
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
    $app.innerHTML = `<h2>${h(p)}</h2>
      <div class="toolbar">${platform && isTour ? `<a class="back" href="#/tour/${encodeURIComponent(p)}">← back</a>` : platform ? `<a href="#/platform/${encodeURIComponent(platform)}">← ${h(platform)}</a>` : ''}
        <button id="save" class="primary">Save</button>
        ${isTour ? '<button id="saveval">Save + validate (dry run)</button>' : ''}
        ${isJson ? '<button id="schema">Save + schema check</button><button id="fmt">Format</button>' : ''}
        <span id="msg" class="muted"></span></div>
      <div class="${isTour ? 'grid' : ''}"><div><textarea id="src" spellcheck="false"></textarea></div>
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
      </div>
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
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#/${({ platform: 'platforms', run: 'runs', job: 'jobs', edit: 'platforms', write: '', tour: '', browse: '', new: '' })[route] ?? route}`));
  const view = views[route] ?? views.home;
  try { cleanup = await view(rest.join('/')); } catch (e) { $app.innerHTML = `<p class="bad">${h(e.message)}</p>`; }
}
addEventListener('hashchange', () => { document.querySelector('.burger')?.removeAttribute('open'); render(); });
document.addEventListener('click', e => { const b = document.querySelector('.burger'); if (b?.open && !b.contains(e.target)) b.removeAttribute('open'); });
render();
