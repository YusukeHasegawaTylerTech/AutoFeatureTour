// The simple screens: for someone who has never seen the tool. No JSON, no CLI words, plain-language results.
// Advanced screens live in app.js behind the ☰ menu.

import { filmedScenes, mountMarkers, sceneStarts } from './media.js';

export function simpleViews({ $app, h, api, fileUrl, ago, rel, render, TEMPLATES }) {
  const send = (method, url, data) => api(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const pretty = slug => { const s = String(slug).replace(/\.tour\.(json|mjs)$/, '').replace(/[-_]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
  const slugify = s => s.trim().toLowerCase().replace(/\.(tour\.)?json$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const query = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
  const readTour = async p => JSON.parse((await api(`/api/pfile?path=${encodeURIComponent(p)}`)).text);
  const saveFile = (p, obj) => send('PUT', `/api/pfile?path=${encodeURIComponent(p)}`, { text: JSON.stringify(obj, null, 2) + '\n' });

  // ---- ⧉ clone / 🗑 delete icon buttons, used on every item ----
  /** HTML for the icon buttons of one item. kind: script | platform | run | scene | step (scene/step are in-editor). */
  const icons = (kind, path, extra = '') => `<span class="icons" ${extra}>
      <button class="icon-btn" data-icon="clone" data-kind="${kind}" data-path="${h(path)}" title="Make a copy" aria-label="Make a copy">⧉</button>
      <button class="icon-btn del" data-icon="delete" data-kind="${kind}" data-path="${h(path)}" title="Delete" aria-label="Delete">🗑</button></span>`;
  /** First click on 🗑 asks "sure?"; returns true when it's the confirming click. */
  const confirmDelete = b => {
    if (b.dataset.sure) return true;
    b.dataset.sure = '1'; b.textContent = 'sure?'; b.classList.add('sure');
    setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '🗑'; b.classList.remove('sure'); } }, 4000);
    return false;
  };
  /** Wires file/app/run icon buttons under root; after(result, action) runs when one succeeded. */
  function wireIcons(root, after) {
    root.querySelectorAll('.icon-btn[data-kind]:not([data-local])').forEach(b => (b.onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      if (b.dataset.icon === 'delete' && !confirmDelete(b)) return;
      const kind = b.dataset.kind === 'script' ? 'file' : b.dataset.kind;
      try {
        const r = await send('POST', `/api/${b.dataset.icon}`, { kind, path: b.dataset.path });
        after(r, b.dataset.icon, b.dataset.kind);
      } catch (err) { b.title = err.message; b.textContent = '⚠'; }
    }));
  }

  /** Runs `aft <args>`; calls onLine(text) per log line and onDone(result). Returns { stop, close }. */
  async function runJob(args, { onLine, onDone }) {
    const job = await send('POST', '/api/jobs', { args });
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    es.addEventListener('line', e => onLine?.(JSON.parse(e.data).replace(/^\d\d:\d\d:\d\d /, '')));
    es.addEventListener('done', e => { es.close(); onDone?.(JSON.parse(e.data)); });
    return { stop: () => send('POST', `/api/jobs/${job.id}/stop`, {}), close: () => es.close() };
  }

  // "scenes[0].narration is required" → "Scene 1: narration is required"
  const humanPath = d => String(d).replace(/scenes\[(\d+)\]\.?/g, (_, n) => `Scene ${Number(n) + 1}: `).replace(/steps\[(\d+)\]\.?/g, (_, n) => `step ${Number(n) + 1} `)
    .replace(/: narration is required/, ': it needs narration (what the voice says)').replace(/: title is required/, ': it needs a title');

  /** A run or job result in plain words: { title, detail, kind, scene, step, target, suggestion }. */
  function friendly(r, baseUrl) {
    if (r.class === 'error' && r.error?.details?.length)   // the file itself has a problem: nothing ran
      return { kind: 'config', title: 'The script has something missing.', detail: r.error.details.slice(0, 3).map(humanPath).join(' · '),
        raw: [r.error.message, ...r.error.details].join('\n') };
    const err = String(r.error?.message ?? r.error ?? '');
    const cls = r.class ?? (/^(SCRIPT|CRITERION|APP|LOGIN|TOOLING|UNREACHABLE|INTERRUPTED)/.exec(err)?.[1]?.toLowerCase()) ?? 'error';
    const where = /scene-(\d+)(?: \([^)]*\))? step (\d+)/.exec(err);
    const scene = where ? Number(where[1]) : null, step = where ? Number(where[2]) : null;
    const target = /Target not found: "([^"]+)"/.exec(err)?.[1];
    const suggestion = /did you mean "([^"]+)"/.exec(err)?.[1];
    const at = scene ? `Scene ${scene}, step ${step}` : /fixtures/.test(err) ? 'While getting ready' : 'A step';
    const out = { kind: cls, scene, step, target, suggestion, raw: err };
    if (cls === 'script') return { ...out, title: target ? `${at} couldn't find “${target}” on the page.` : `${at} couldn't be done.`,
      detail: suggestion ? `Did you mean “${suggestion}”?` : target ? 'Check the words: they must match what the page shows.' : err.split(': ').slice(-1)[0] };
    if (cls === 'unreachable') return { ...out, title: `The app isn't answering${baseUrl ? ` at ${baseUrl}` : ''}.`, detail: 'Is it running? Start it, then try again.' };
    if (cls === 'login') return { ...out, title: "Couldn't sign in.", detail: 'Check the test username and password below.' };
    if (cls === 'criterion') return { ...out, title: `${scene ? `Scene ${scene}` : 'The page'} didn't show what it should.`, detail: 'The app may have changed, or the check expects the wrong words.' };
    if (cls === 'app') return { ...out, title: 'The app itself showed an error.', detail: "This isn't your script: tell the app's team (the screenshot below helps)." };
    if (cls === 'interrupted') return { ...out, title: 'Stopped.', detail: 'It was stopped before it finished.' };
    return { ...out, title: 'Something on this computer went wrong.', detail: err.split('\n')[0].slice(0, 200) };
  }

  function progress(line, total) {
    let m;
    if ((m = /scene-(\d+) start/.exec(line))) return `Scene ${Number(m[1])}${total ? ` of ${total}` : ''}`;
    if (/sign|login/i.test(line)) return 'Signing in';
    if (/fixture|setup/i.test(line)) return 'Getting ready';
    if (/render|ffmpeg|encod|caption/i.test(line)) return 'Putting the video together';
    if (/running at|attach|launch|starting/i.test(line)) return 'Opening the app';
    return null;
  }

  /** The "Sign-in details" card: one field per credential the app uses. Fills `box`. */
  async function signInCard(platform, box, { open = false, onSaved } = {}) {
    const d = await api(`/api/platform?name=${encodeURIComponent(platform)}`);
    if (!d.env.length) { box.innerHTML = ''; return; }
    const label = n => /USER(NAME)?$|LOGIN$|EMAIL$/.test(n) ? 'Test username' : /PASSWORD|SECRET|TOKEN|KEY/.test(n) ? 'Test password' : pretty(n.toLowerCase());
    const secret = n => /PASSWORD|SECRET|TOKEN|KEY/.test(n);
    d.env.sort((a, b) => secret(a.name) - secret(b.name) || a.name.localeCompare(b.name));   // username before password
    box.innerHTML = `<details class="signin" ${open ? 'open' : ''}><summary>🔑 Sign-in details
        <span class="hint">${d.env.every(e => e.source) ? '✔ all saved' : 'some missing'}</span></summary>
      ${d.env.map(e => `<label class="lbl">${h(label(e.name))}</label>
        <input class="mid-input" data-env="${h(e.name)}" type="${secret(e.name) ? 'password' : 'text'}" autocomplete="off"
          placeholder="${e.source ? 'saved ✔ (type to change)' : 'not set yet'}">`).join('')}
      <p class="hint">Use a test account, not your real one. Saved on this computer only.</p>
      <button class="chunky small c-green" data-save>💾 SAVE</button> <span class="signin-msg"></span></details>`;
    box.querySelector('[data-save]').onclick = async () => {
      const msg = box.querySelector('.signin-msg');
      try {
        let n = 0;
        for (const input of box.querySelectorAll('[data-env]')) if (input.value) { await send('PUT', '/api/secret', { platform, name: input.dataset.env, value: input.value }); n++; }
        msg.innerHTML = n ? '<span class="ok">✔ Saved</span>' : '<span class="hint">Nothing typed, nothing changed.</span>';
        if (n) { await signInCard(platform, box, { open, onSaved }); box.querySelector('.signin-msg').innerHTML = '<span class="ok">✔ Saved</span>'; onSaved?.(); }
      } catch (e) { msg.innerHTML = `<span class="bad">${h(e.message)}</span>`; }
    };
  }

  // ---- steps in plain words ----
  const KINDS = {
    goto: { icon: '🌐', label: 'Open a page', hint: 'Go to an address in the app', make: () => ({ goto: '' }),
      fields: [['goto', 'page, e.g. /reports']], words: ['Open page', ''], need: 'which page to open' },
    click: { icon: '👆', label: 'Click', hint: 'Click a button or link by the words on it', make: () => ({ click: '' }),
      fields: [['click', 'words on it, e.g. Save']], words: ['Click', ''], need: 'what to click' },
    fill: { icon: '⌨️', label: 'Type', hint: 'Type into a box', make: () => ({ fill: '', text: '' }),
      fields: [['text', 'what to type'], ['fill', 'the box, e.g. Name']], words: ['Type', 'into', ''], need: 'what to type and into which box' },
    press: { icon: '⏎', label: 'Press a key', hint: 'Like Enter or Tab', make: () => ({ press: 'Enter' }),
      fields: [['press', 'Enter']], words: ['Press', ''], need: 'which key' },
    verify: { icon: '✅', label: 'Check it shows', hint: 'Make sure some words are on the page', make: () => ({ verify: { text: '' } }),
      fields: [['verify.text', 'words on the page']], words: ['Make sure it shows', ''], need: 'what it should show' },
    wait: { icon: '⏱', label: 'Wait', hint: 'Pause a moment', make: () => ({ wait: 2 }),
      fields: [['wait', '2', 'number']], words: ['Wait', 'seconds'], need: 'how many seconds' },
  };
  const isStr = v => typeof v === 'string';
  function kindOf(s0) {
    const { camera, ...s } = s0; // on/off camera is a toggle on any step, not part of its kind
    const k = Object.keys(s);
    if (k.length === 1 && isStr(s.goto)) return 'goto';
    if (k.length === 1 && isStr(s.click)) return 'click';
    if (k.length === 2 && isStr(s.fill) && isStr(s.text)) return 'fill';
    if (k.length === 1 && isStr(s.press)) return 'press';
    if (k.length === 1 && s.verify && typeof s.verify === 'object' && Object.keys(s.verify).length === 1 && isStr(s.verify.text)) return 'verify';
    if (k.length === 1 && typeof s.wait === 'number') return 'wait';
    return null;
  }
  const getF = (s, f) => f.split('.').reduce((o, k) => o?.[k], s);
  const setF = (s, f, v) => { const ks = f.split('.'); let o = s; for (const k of ks.slice(0, -1)) o = o[k]; o[ks.at(-1)] = v; };
  function summary(s) {
    const OPTS = new Set(['optional', 'timeout', 'retries', 'criterion', 'comment', 'waitForResponse', 'status', 'method', 'with', 'text', 'secret']);
    const action = Object.keys(s).find(k => !OPTS.has(k)) ?? Object.keys(s)[0];
    const v = s[action];
    const what = isStr(v) ? v : v && typeof v === 'object' ? (v.name ?? v.text ?? v.label ?? v.placeholder ?? v.testId ?? v.css ?? v.url ?? JSON.stringify(v)) : String(v ?? '');
    const args = s.with ? ` (${Object.entries(s.with).map(([k, x]) => `${k}: ${isStr(x) ? x : JSON.stringify(x)}`).join(', ')})` : '';
    return `${action} ${String(what).slice(0, 60)}${args}`;
  }

  // ---- scene timing: how long the voice speaks vs. how long the steps take ----
  // Spoken length as the engine estimates it (src/tts.mjs: words / 2.5, at least 2 s); steps by rough kind (what a
  // paced run spends: a cursor move and a click, typing, a page load). Paced steps run while the voice speaks; when
  // they take longer, the scene overruns its narration (the voice stops, the video keeps going).
  const spokenSeconds = text => { const w = String(text ?? '').split(/\s+/).filter(Boolean).length; return w ? Math.max(2, w / 2.5) : 0; };
  function stepSeconds(st) {
    if (st.camera === false) return 0;   // cut from the video
    if (typeof st.wait === 'number') return st.wait;
    if (st.goto != null) return 2.5;
    if (st.fill != null || st.type != null) return 1.2 + String(st.text ?? '').length * 0.06;
    if (st.verify != null || st.waitFor != null || st.pin != null || st.capture != null || st.at != null) return 0.4;
    if (st.press != null) return 0.6;
    if (st.use != null || st.code != null) return 3;
    return 1.4;   // click, hover, check, select…
  }
  const sceneTiming = s => ({ spoken: spokenSeconds(s.narration), steps: (s.steps ?? []).reduce((n, st) => n + stepSeconds(st), s.url ? 2.5 : 0) });

  // ---- gotos the planner wrote: a path from the site root drops the base URL's own path ----
  /**
   * goto resolves like new URL(path, baseUrl): with a base of http://host/todomvc/, "/todomvc/#/" stays inside it but
   * "/#/" leaves it (http://host/#/). Gotos (and scene urls) that repeat the base path are made relative ("#/");
   * other root paths are reported, since only a person knows which page was meant.
   */
  function fixGotos(t, baseUrl) {
    let basePath = '/'; try { basePath = new URL(baseUrl).pathname; } catch {}
    const fixed = [], outside = [];
    if (basePath === '/' ) return { fixed, outside };
    const fix = (v, where) => {
      if (!isStr(v) || !v.startsWith('/') || v.startsWith('//')) return v;
      if (v.startsWith(basePath) || `${v}/` === basePath) { const r = v.slice(basePath.length) || './'; fixed.push(`${where}: ${v} → ${r}`); return r; }
      outside.push(`${where}: ${v}`); return v;
    };
    (t.scenes ?? []).forEach((s, i) => {
      if (s.url) s.url = fix(s.url, `Scene ${i + 1} page`);
      (s.steps ?? []).forEach((st, j) => { if (isStr(st.goto)) st.goto = fix(st.goto, `Scene ${i + 1}, step ${j + 1}`); });
    });
    return { fixed, outside, basePath };
  }

  // ---- {data.x}: what a placeholder stands for, from the platform, the environment and the tour's fixtures ----
  const dataHint = (v, data) => {
    const keys = [...String(v ?? '').matchAll(/\{data\.([\w.-]+)\}/g)].map(m => m[1]);
    if (!keys.length) return '';
    return `<span class="data-hint">${keys.map(k => data?.[k] ? `<span title="from ${h(data[k].source)}">{data.${h(k)}} = <b>${h(data[k].value)}</b></span>`
      : `<span class="bad-text" title="Nothing gives it a value: add it to a fixture's data, or to the app's or environment's data">{data.${h(k)}} isn't set</span>`).join(' · ')}</span>`;
  };

  /** Interactive names on the page, from an ARIA snapshot: what a step can target by its words. */
  function ariaTargets(aria) {
    const ROLES = { button: 'click', link: 'click', tab: 'click', menuitem: 'click', option: 'click', checkbox: 'click', radio: 'click', switch: 'click',
      textbox: 'fill', searchbox: 'fill', combobox: 'fill', spinbutton: 'fill', heading: 'verify' };
    const out = new Map();
    for (const line of String(aria ?? '').split('\n')) {
      const m = /^\s*- (\w+) "((?:[^"\\]|\\.)+)"/.exec(line);
      if (m && ROLES[m[1]]) { const name = m[2].replace(/\\"/g, '"'); out.set(`${m[1]}|${name}`, { role: m[1], name, does: ROLES[m[1]] }); }
    }
    return [...out.values()];
  }

  // ---- IMPORT: drop (or pick) an exported .aft.json, choose the app, import it into platforms/<app>/tours/ ----
  /** Wires #drop / #drop-file / #import-msg on the current page; returns a cleanup for the running job. */
  /** The drop zone's HTML; with a target platform it imports straight into that one. */
  const dropZoneHtml = target => `<div class="dropzone" id="drop" role="button" tabindex="0"
      aria-label="Import a script${target ? ` into ${h(target)}` : ''}: drop an exported .aft.json file here, or click to choose one">
      <span class="icon">📥</span><b>IMPORT A SCRIPT${target ? ` INTO ${h(target.toUpperCase())}` : ''}</b>
      <span class="sub">Drop an exported <code>.aft.json</code> file here, or click to choose one</span>
      <input type="file" id="drop-file" accept=".json,application/json" hidden></div>
    <div id="import-msg"></div>`;

  /** fixed: import only into this platform (no app picker). */
  function importZone(platforms, fixed = null) {
    const zone = $app.querySelector('#drop'), input = $app.querySelector('#drop-file'), msg = $app.querySelector('#import-msg');
    let job = null, upload = null;
    const pick = () => input.click();
    zone.onclick = pick;
    zone.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files?.[0]; if (f) take(f); };
    input.onchange = () => { const f = input.files?.[0]; input.value = ''; if (f) take(f); };

    async function take(file) {
      msg.innerHTML = '<div class="verdict wait">⏳ Reading the file…</div>';
      try { upload = await send('POST', '/api/upload-export', { name: file.name, text: await file.text() }); }
      catch (e) { msg.innerHTML = `<div class="verdict bad">✘ ${h(e.message)}</div>`; return; }
      const src = upload.source ?? {}, last = src.last;
      const choices = fixed ? [fixed] : platforms.map(p => p.name);
      const preferred = choices.find(n => n !== src.platform && src.platform && n.startsWith(src.platform.split('-')[0])) ?? choices.find(n => n !== src.platform) ?? choices[0];
      msg.innerHTML = `<div class="card import-card">
          <div class="import-title">${h(upload.tour ?? file.name)}</div>
          <p class="hint">Made on <b>${h(src.platform ?? 'another machine')}</b>${src.env ? ` (${h(src.env)})` : ''}.
            ${last ? `Its last ${last.command === 'run' ? 'video' : 'check'} there: <b class="${last.result === 'PASSED' || last.status === 'done' ? 'ok-text' : 'bad-text'}">${h(last.result ?? last.status)}</b>.`
              : 'It never passed there.'}</p>
          ${last?.criteria?.filter(c => c.text).length ? `<ul class="crit">${last.criteria.filter(c => c.text).map(c =>
            `<li>${c.status === 'met' ? '✔' : '✘'} ${h(c.text)}</li>`).join('')}</ul>` : ''}
          ${fixed ? `<p class="hint">It goes into <b>${h(fixed)}</b>.</p>` : '<label class="lbl" for="imp-platform">Import it into which app?</label>'}
          <select class="mid-input" id="imp-platform" ${fixed ? 'hidden' : ''}>${choices.map(n => `<option ${n === preferred ? 'selected' : ''}>${h(n)}</option>`).join('')}</select>
          <p class="hint">That app's own address, sign-in and test account are used: the script carries none.</p>
          <div class="actions tight"><button class="chunky small c-green" id="imp-go">📥 IMPORT</button>
            <button class="chunky small c-gray" id="imp-cancel">CANCEL</button></div>
          <div id="imp-result"></div></div>`;
      msg.querySelector('#imp-cancel').onclick = () => { msg.innerHTML = ''; };
      msg.querySelector('#imp-go').onclick = () => go(false);
    }

    async function go(force) {
      const platform = msg.querySelector('#imp-platform').value, out = msg.querySelector('#imp-result');
      msg.querySelectorAll('button').forEach(b => (b.disabled = true));
      out.innerHTML = '<div class="verdict wait">⏳ Importing…</div>';
      job = await runJob(['import', upload.file, '--platform', platform, ...(force ? ['--force'] : [])], { onDone: r => {
        msg.querySelectorAll('button').forEach(b => (b.disabled = false));
        if (!r.ok) {
          const text = r.error?.message ?? '';
          if (/exists; pass --force/.test(text)) {
            out.innerHTML = `<div class="verdict bad">✘ ${h(platform)} already has a script called ${h(upload.tour ?? '')}.
              <div class="actions tight"><button class="chunky small c-orange" id="imp-force">REPLACE IT</button></div></div>`;
            out.querySelector('#imp-force').onclick = () => go(true);
          } else out.innerHTML = `<div class="verdict bad">✘ Couldn't import it.<small>${h(text)}</small></div>`;
          return;
        }
        const tour = rel(r.data.tour);
        const missing = r.data.missing ?? [];
        out.innerHTML = `<div class="verdict ${missing.length ? 'wait' : 'ok'}">${missing.length ? '⚠ Imported, but it needs more before it can run here' : `✔ Imported into ${h(platform)}`}
          <small>${missing.length ? `Add to ${h(platform)}: ${h(missing.join('; '))}` : 'Next: open it and press CHECK IT to try every step on this app.'}</small>
          <div class="actions tight"><a class="chunky small c-green" href="#/tour/${encodeURIComponent(tour)}">➜ OPEN IT</a></div></div>`;
      } });
    }
    return () => job?.close();
  }

  // Runs that say whether a script works (an export or import says nothing about that).
  const VERDICT_COMMANDS = new Set(['validate', 'run', 'render']);

  const views = {
    // No separate home page: the start page is the script list (views.browse; #/browse still works).
    home() { return views.browse(); },

    async new(platform) {
      platform = decodeURIComponent(platform ?? '');
      if (!platform) {
        const ps = await api('/api/platforms');
        $app.innerHTML = `<a class="back" href="#/">← back</a><div class="page-title">Which app is it for?</div>
          <div class="tiles">${ps.map(p => `<a class="tile" href="#/new/${encodeURIComponent(p.name)}">${h(p.name)}
            <span class="sub">${p.tours.length} script${p.tours.length === 1 ? '' : 's'}</span>${icons('platform', p.name)}</a>`).join('')}
            <a class="tile tile-new" href="#/newapp"><span class="plus">✚</span>NEW APP<span class="sub">set up another app</span></a></div>`;
        wireIcons($app, () => render());
        return;
      }
      $app.innerHTML = `<a class="back" href="#/">← back</a><div class="page-title">What will this video show?</div>
        <input class="big-input" id="name" placeholder="e.g. Adding a report">
        <p class="hint" id="as"></p>
        <div class="actions"><button class="chunky mid c-green" id="go"><span class="icon">✚</span>CREATE</button></div>
        <div id="err"></div>
        <div class="group-title">Or bring in one made elsewhere</div>
        ${dropZoneHtml(platform)}`;
      const cleanup = importZone([], platform);
      const input = $app.querySelector('#name'), err = $app.querySelector('#err'), as = $app.querySelector('#as');
      input.focus();
      input.oninput = () => { as.textContent = slugify(input.value) ? `Saved as ${slugify(input.value)}` : ''; };
      const go = async () => {
        const n = slugify(input.value);
        if (!n) { err.innerHTML = '<div class="verdict bad">✘ Give it a name first.</div>'; return; }
        const p = `platforms/${platform}/tours/${n}.tour.json`;
        try {
          await send('PUT', `/api/pfile?path=${encodeURIComponent(p)}`, { create: true, text: JSON.stringify(TEMPLATES.tour(platform, n), null, 2) + '\n' });
          location.hash = `#/write/${encodeURIComponent(p)}`;
        } catch (e) { err.innerHTML = `<div class="verdict bad">✘ ${/exists/.test(e.message) ? 'There is already one with that name.' : h(e.message)}</div>`; }
      };
      $app.querySelector('#go').onclick = go;
      input.onkeydown = e => { if (e.key === 'Enter') go(); };
      return cleanup;
    },

    async newapp() {
      $app.innerHTML = `<a class="back" href="#/">← back</a><div class="page-title">Set up a new app</div>
        <div class="stepper"><b>1 Name</b> › 2 Sign-in › 3 Test</div>
        <label class="lbl">Its name</label><input class="big-input" id="name" placeholder="e.g. My app">
        <label class="lbl">Its web address</label><input class="big-input" id="url" placeholder="http://localhost:3000/">
        <label class="lbl check"><input type="checkbox" id="login" checked> People have to sign in to use it</label>
        <div class="actions"><button class="chunky mid c-green" id="go"><span class="icon">➜</span>NEXT</button></div>
        <div id="msg"></div>`;
      const $ = s => $app.querySelector(s), msg = $('#msg');
      $('#name').focus();
      let job = null;
      const go = async () => {
        const name = slugify($('#name').value).replace(/\./g, '-'), url = $('#url').value.trim();
        if (!name) { msg.innerHTML = '<div class="verdict bad">✘ Give it a name first.</div>'; return; }
        if (!/^https?:\/\/\S+$/.test(url)) { msg.innerHTML = '<div class="verdict bad">✘ The web address starts with http:// or https://</div>'; return; }
        $('#go').disabled = true;
        msg.innerHTML = '<div class="verdict wait">⏳ Setting it up…</div>';
        const login = $('#login').checked;
        job = await runJob(['platform', 'init', name, '--base-url', url, ...(login ? [] : ['--no-login'])], { onDone: r => {
          if (r.ok) location.hash = login ? `#/newapp-signin/${encodeURIComponent(name)}` : `#/newapp-test/${encodeURIComponent(name)}`;
          else { $('#go').disabled = false; msg.innerHTML = `<div class="verdict bad">✘ ${/already exists/.test(r.error?.message ?? '') ? 'There is already an app with that name.' : "Couldn't set it up."}<small>${h(r.error?.message ?? '')}</small></div>`; }
        } });
      };
      $('#go').onclick = go;
      for (const s of ['#name', '#url']) $(s).onkeydown = e => { if (e.key === 'Enter') go(); };
      return () => job?.close();
    },

    async 'newapp-signin'(name) {
      name = decodeURIComponent(name);
      const lp = `platforms/${name}/login.json`;
      const login = await readTour(lp);
      const role = login.default ?? Object.keys(login.roles ?? {})[0];
      const steps = login.roles?.[role]?.steps ?? [];
      const cur = { path: steps.find(s => isStr(s.goto))?.goto ?? '/login',
        user: steps.find(s => isStr(s.fill) && !s.secret)?.fill ?? 'Username', pass: steps.find(s => isStr(s.fill) && s.secret)?.fill ?? 'Password',
        button: steps.find(s => s.click)?.click?.name ?? steps.find(s => isStr(s.click))?.click ?? 'Sign in' };
      const userVar = steps.find(s => isStr(s.fill) && !s.secret)?.text, passVar = steps.find(s => isStr(s.fill) && s.secret)?.text;
      $app.innerHTML = `<div class="page-title">Signing in to ${h(name)}</div>
        <div class="stepper">1 Name › <b>2 Sign-in</b> › 3 Test</div>
        <p class="hint">How does the sign-in page look? Use the words you see on it.</p>
        <label class="lbl">The sign-in page</label><input class="mid-input" data-k="path" value="${h(cur.path)}">
        <label class="lbl">The username box is called</label><input class="mid-input" data-k="user" value="${h(cur.user)}">
        <label class="lbl">The password box is called</label><input class="mid-input" data-k="pass" value="${h(cur.pass)}">
        <label class="lbl">The button says</label><input class="mid-input" data-k="button" value="${h(cur.button)}">
        <div id="creds" style="margin-top:20px"></div>
        <div class="actions"><button class="chunky mid c-green" id="go"><span class="icon">➜</span>NEXT</button></div><div id="msg"></div>`;
      await signInCard(name, $app.querySelector('#creds'), { open: true });
      $app.querySelector('#go').onclick = async () => {
        const v = k => $app.querySelector(`[data-k=${k}]`).value.trim();
        if (!v('path') || !v('user') || !v('pass') || !v('button')) { $app.querySelector('#msg').innerHTML = '<div class="verdict bad">✘ Fill in all four boxes.</div>'; return; }
        login.roles[role].steps = [{ goto: v('path') }, { fill: v('user'), text: userVar }, { fill: v('pass'), text: passVar, secret: true },
          { click: { role: 'button', name: v('button') } }];
        await saveFile(lp, login);
        location.hash = `#/newapp-test/${encodeURIComponent(name)}`;
      };
    },

    async 'newapp-test'(name) {
      name = decodeURIComponent(name);
      const d = await api(`/api/platform?name=${encodeURIComponent(name)}`);
      $app.innerHTML = `<div class="page-title">Test ${h(name)}</div>
        <div class="stepper">1 Name › 2 Sign-in › <b>3 Test</b></div>
        <div id="verdict"><div class="verdict wait">Let's see if we can reach it${d.files.some(f => f.rel === 'login.json') ? ' and sign in' : ''}.</div></div>
        <div class="actions"><button class="chunky mid c-orange" id="test"><span class="icon">🔌</span>TEST THE CONNECTION</button>
          <a class="chunky mid c-gray" href="#/new/${encodeURIComponent(name)}"><span class="icon">⏭</span>SKIP</a></div>
        <div id="creds"></div>`;
      let job = null;
      const box = $app.querySelector('#verdict');
      $app.querySelector('#test').onclick = async () => {
        $app.querySelector('#test').disabled = true;
        box.innerHTML = '<div class="verdict wait">⏳ Testing…<small id="last"></small></div>';
        job = await runJob(['platform', 'check', name], {
          onLine: l => { const p = progress(l); const el = $app.querySelector('#last'); if (p && el) el.textContent = p; },
          onDone: r => {
            $app.querySelector('#test').disabled = false;
            // `platform check --json` can say ok:true while exiting 1 with data.ok false: trust the exit code and data.ok
            const stage = r.data?.results?.find(x => !x.ok);
            if (r.exitCode !== 0 || r.data?.ok === false) {
              const STAGES = { machine: ['This computer is missing something it needs.', 'Ask whoever set it up to run the Doctor (☰ menu).'],
                settings: ["The app's settings have a problem.", stage?.detail ?? ''],
                reachable: [`The app isn't answering${d.baseUrl ? ` at ${d.baseUrl}` : ''}.`, 'Is it running? Start it, then test again.'] };
              const f = stage && STAGES[stage.label] ? { title: STAGES[stage.label][0], detail: STAGES[stage.label][1], kind: stage.label, raw: stage.detail }
                : friendly({ ...r, class: r.class === 'ok' ? 'error' : r.class, error: r.error ?? stage?.detail }, d.baseUrl);
              box.innerHTML = `<div class="verdict bad">✘ ${h(f.title)}<small>${h(f.detail)}</small>
                <details class="raw"><summary>details</summary><pre>${h(f.raw ?? '')}</pre></details></div>`;
              if (f.kind === 'login') signInCard(name, $app.querySelector('#creds'), { open: true });
              return;
            }
            if (r.ok) { box.innerHTML = `<div class="verdict ok">✔ It works!</div>
              <div class="actions"><a class="chunky mid c-green" href="#/new/${encodeURIComponent(name)}"><span class="icon">✚</span>MAKE THE FIRST SCRIPT</a></div>`; return; }
            const f = friendly(r, d.baseUrl);
            box.innerHTML = `<div class="verdict bad">✘ ${h(f.title)}<small>${h(f.detail)}</small>
              <details class="raw"><summary>details</summary><pre>${h(f.raw)}</pre></details></div>`;
            if (f.kind === 'login') signInCard(name, $app.querySelector('#creds'), { open: true });
          } });
      };
      return () => job?.close();
    },

    async browse() {
      const [ps, runs] = await Promise.all([api('/api/platforms'), api('/api/runs')]);
      const last = new Map();
      for (const r of runs) { if (!VERDICT_COMMANDS.has(r.command)) continue; const k = rel(r.input?.[0]); if (k && !last.has(k)) last.set(k, r); }
      // The start page: every app with its scripts, a "new script" tile closing each app's row, and "new app" last.
      $app.innerHTML = `<div class="page-title">Your scripts</div>
        ${dropZoneHtml(null)}
        ${ps.map(p => `<div class="group-title">${h(p.name)} ${icons('platform', p.name)}</div><div class="tiles">
          ${p.tours.map(t => { const r = last.get(t.path); const st = !r || r.status === 'running' ? 'none' : r.status === 'done' ? 'ok' : 'bad';
            return `<a class="tile ${st === 'none' ? '' : st}" href="#/tour/${encodeURIComponent(t.path)}">${h(pretty(t.file))}
              <span class="dot ${st}">${!r ? 'not tried yet' : r.status === 'running' ? '⏳ running' : st === 'ok' ? `✔ ${r.command === 'run' ? 'video made' : 'works'}` : '✘ needs fixing'}</span>
              <span class="sub">${r ? ago(r.startedAt) : ''}</span>${icons('script', t.path)}</a>`; }).join('')}
          <a class="tile tile-new" href="#/new/${encodeURIComponent(p.name)}"><span class="plus">✚</span>NEW SCRIPT<span class="sub">write one, or import one</span></a></div>`).join('')}
        ${ps.length ? '' : '<p class="hint">No apps yet. Set one up first: its address, and how to sign in.</p>'}
        <div class="group-title">&nbsp;</div><div class="tiles">
          <a class="tile tile-new" href="#/newapp"><span class="plus">✚</span>NEW APP<span class="sub">set up another app</span></a></div>`;
      wireIcons($app, () => render());
      return importZone(ps);
    },

    async tour(p) {
      p = decodeURIComponent(p);
      const platform = p.split('/')[1];
      const [allRuns, d] = await Promise.all([api('/api/runs'), api(`/api/platform?name=${encodeURIComponent(platform)}`)]);
      const runs = allRuns.filter(r => rel(r.input?.[0]) === p && VERDICT_COMMANDS.has(r.command));
      const lastAny = runs[0], lastVideo = runs.find(r => r.command === 'run' && r.status === 'done');
      let total = null;
      if (p.endsWith('.json')) try { total = (await readTour(p)).scenes?.length ?? null; } catch {}
      const hasLogin = d.files.some(f => f.rel === 'login.json');
      const edit = p.endsWith('.json');
      const verdictHtml = () => {
        if (!lastAny) return '<div class="verdict wait">Not tried yet.<small>Press CHECK IT: it tries every step, without making a video.</small></div>';
        if (lastAny.status === 'running') return '<div class="verdict wait">⏳ Working on it…</div>';
        if (lastAny.status === 'done') return lastAny.command === 'run'
          ? `<div class="verdict ok">✔ Video made<small>${ago(lastAny.startedAt)}</small></div>`
          : `<div class="verdict ok">✔ Every step works<small>Now press MAKE VIDEO.</small></div>`;
        const f = friendly(lastAny, d.baseUrl);
        return `<div class="verdict bad">✘ ${h(f.title)}<small>${h(f.detail)}</small>
          ${lastAny.failedSteps > 1 ? `<small>${lastAny.failedSteps} steps need fixing in all; this is the first.</small>` : ''}
          <div class="actions tight">
            ${f.kind === 'script' && f.suggestion && f.scene && edit ? `<button class="chunky small c-green" id="use">USE “${h(f.suggestion)}”</button>` : ''}
            ${f.kind === 'script' && edit ? `<a class="chunky small c-purple" href="#/write/${encodeURIComponent(p)}?scene=${f.scene ?? ''}&step=${f.step ?? ''}">✏️ FIX IT</a>` : ''}
            ${f.kind === 'unreachable' ? '<button class="chunky small c-orange" data-do="validate">↻ TRY AGAIN</button>' : ''}
            <a class="chunky small c-gray" href="#/run/${h(lastAny.id)}">🔎 SEE WHAT HAPPENED</a></div>
          <img class="shot-small" src="${fileUrl(lastAny.id, 'screens/failure.png')}" onerror="this.remove()">
          <details class="raw"><summary>details</summary><pre>${h(f.raw)}</pre></details></div>`;
      };
      $app.innerHTML = `<a class="back" href="#/">← back</a>
        <div class="page-title">${h(pretty(p.split('/').pop()))} <span class="hint">${h(platform)}</span> ${icons('script', p)}</div>
        <div id="verdict">${verdictHtml()}</div>
        <div class="actions" id="main-actions">
          <button class="chunky mid c-orange" data-do="validate"><span class="icon">🔍</span>CHECK IT</button>
          <button class="chunky mid c-green" data-do="run"><span class="icon">🎬</span>MAKE VIDEO</button>
          ${edit ? `<a class="chunky mid c-purple" href="#/write/${encodeURIComponent(p)}"><span class="icon">✏️</span>EDIT</a>` : ''}
          ${edit ? '<button class="chunky mid c-blue" id="export" title="One file to send to QA or another machine, to import there"><span class="icon">📤</span>EXPORT</button>' : ''}
        </div>
        <div id="export-msg"></div>
        <div id="creds"></div>
        ${lastVideo ? `<div class="group-title">Latest video</div><div class="card" style="max-width:900px"><video controls preload="metadata" src="${fileUrl(lastVideo.id, 'tour.mp4')}">
          <track default kind="captions" src="${fileUrl(lastVideo.id, 'tour.vtt')}"></video><div id="markers"></div></div>` : ''}`;
      if (lastVideo) api(`/api/run?id=${encodeURIComponent(lastVideo.id)}`).then(async rd => {
        let t = null; try { t = rd.files.some(f => f.path === 'tour.json') ? await (await fetch(fileUrl(lastVideo.id, 'tour.json'))).json() : await readTour(p); } catch {}
        await mountMarkers($app.querySelector('#markers'), $app.querySelector('video'), { vttUrl: fileUrl(lastVideo.id, 'tour.vtt'), scenes: filmedScenes(rd.files, t) });
      }).catch(() => {});
      if (hasLogin) signInCard(platform, $app.querySelector('#creds'), { open: lastAny && friendly(lastAny).kind === 'login' && lastAny.status === 'failed' });
      let job = null;
      const start = async what => {
        $app.querySelectorAll('[data-do]').forEach(x => (x.disabled = true));
        $app.querySelector('#verdict').innerHTML = `<div class="verdict wait">⏳ ${what === 'run' ? 'Making the video' : 'Checking every step'}…
          <small id="last">Starting</small><div class="actions tight"><button class="chunky small c-red" id="stop">■ STOP</button></div></div>`;
        $app.querySelector('#stop').onclick = () => job?.stop();
        job = await runJob([what, p], {
          onLine: l => { const s = progress(l, total); const el = $app.querySelector('#last'); if (s && el) el.textContent = s; },
          onDone: r => {
            if (r.ok || r.runDir) return render();   // a run folder exists: the page reads its result
            // nothing ran (the file has a problem, or the tool failed before starting): say so here
            const f = friendly(r, d.baseUrl);
            $app.querySelectorAll('[data-do]').forEach(x => (x.disabled = false));
            $app.querySelector('#verdict').innerHTML = `<div class="verdict bad">✘ ${h(f.title)}<small>${h(f.detail)}</small>
              ${edit ? `<div class="actions tight"><a class="chunky small c-purple" href="#/write/${encodeURIComponent(p)}">✏️ FIX IT</a></div>` : ''}
              <details class="raw"><summary>details</summary><pre>${h(f.raw)}</pre></details></div>`;
          } });
      };
      $app.querySelectorAll('[data-do]').forEach(b => (b.onclick = () => start(b.dataset.do)));
      $app.querySelector('#export')?.addEventListener('click', async e => {
        const btn = e.currentTarget, msg = $app.querySelector('#export-msg');
        btn.disabled = true;
        msg.innerHTML = '<div class="verdict wait">⏳ Exporting…</div>';
        job = await runJob(['export', p], { onDone: r => {
          btn.disabled = false;
          if (!r.ok || !r.data?.file) {
            const f = friendly(r, d.baseUrl);
            msg.innerHTML = `<div class="verdict bad">✘ Couldn't export it.<small>${h(f.detail || f.title)}</small>
              <details class="raw"><summary>details</summary><pre>${h(f.raw ?? '')}</pre></details></div>`;
            return;
          }
          const file = String(r.data.file).replace(/\\/g, '/'), name = file.split('/').pop();
          const id = rel(file).replace(/^out\//, '').split('/').slice(0, -1).join('/');   // <name>/<run>
          const last = r.data.source?.last;
          const proof = last ? `It carries this script's last ${last.command === 'run' ? 'video' : 'check'}: ${last.result ?? last.status}.`
            : 'It has never passed here, so it carries no proof that it works.';
          const needs = [...(r.data.requires?.fixtures ?? []), ...(r.data.requires?.mocks ?? [])];
          msg.innerHTML = `<div class="verdict ok">✔ Exported ${h(name)}
            <small>Send this file to QA. They drop it on the start page, pick their app, and run it there. ${h(proof)}</small>
            ${needs.length ? `<small>Their app needs the same test data: ${h(needs.join(', '))}</small>` : ''}
            <div class="actions tight"><a class="chunky small c-blue" id="dl" href="${fileUrl(id, name)}" download="${h(name)}">⬇ DOWNLOAD</a></div></div>`;
          msg.querySelector('#dl').click();
        } });
      });
      wireIcons($app, (r, action) => { location.hash = action === 'clone' ? `#/tour/${encodeURIComponent(r.path)}` : '#/'; });
      $app.querySelector('#use')?.addEventListener('click', async () => {
        const f = friendly(lastAny);
        const tour = await readTour(p);
        const scene = tour.scenes?.[f.scene - 1];
        const swap = v => isStr(v) ? (v === f.target ? f.suggestion : v) : Array.isArray(v) ? v.map(swap)
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
        if (scene) scene.steps = swap(scene.steps ?? []);
        await saveFile(p, tour);
        start('validate');
      });
      return () => job?.close();
    },

    async write(p) {
      p = decodeURIComponent(p);
      const tour = await readTour(p);
      let original = JSON.stringify(tour);
      tour.scenes ??= [];
      const q = query(), flagScene = Number(q.get('scene')) || null, flagStep = Number(q.get('step')) || null;
      let dirty = false, picking = null, genOpen = false, genJob = null, genText = '';
      const platform = p.split('/')[1];
      // {data.x} values, the app's address (for goto checks), and how long each scene took in the last video
      const [tourData, pd, runs] = await Promise.all([api(`/api/tour-data?path=${encodeURIComponent(p)}`).catch(() => null),
        api(`/api/platform?name=${encodeURIComponent(platform)}`).catch(() => ({})), api('/api/runs').catch(() => [])]);
      const data = tourData?.data ?? {};
      const lastVideo = runs.find(r => rel(r.input?.[0]) === p && r.command === 'run' && r.status === 'done');
      const filmedLength = {};   // scene number → seconds in the last video
      if (lastVideo) try {
        const vtt = await (await fetch(fileUrl(lastVideo.id, 'tour.vtt'))).text();
        const rd = await api(`/api/run?id=${encodeURIComponent(lastVideo.id)}`);
        const ids = filmedScenes(rd.files, tour).map(s => s.n);
        const starts = sceneStarts(vtt), end = rd.run?.seconds ?? null;
        ids.forEach((n, k) => { const next = starts[k + 1] ?? end; if (starts[k] != null && next != null) filmedLength[n] = next - starts[k]; });
      } catch {}
      // the pick-from-the-page panel: one scene at a time
      let pick = null;   // { scene, state: 'loading'|'ready'|'error', url, shot, targets, error, chosen }
      let pickJob = null;
      let pinOpen = null;  // "i:j" of the pin step being edited
      const genPanel = () => !genOpen ? '' : `<div class="gen-panel">
          <label class="lbl">Paste the story (e.g. from Jira): title, description and acceptance criteria</label>
          <textarea id="story" rows="9" placeholder="RMS-1234 Add a report&#10;As a user I want…&#10;&#10;Acceptance criteria:&#10;1. …">${h(genText)}</textarea>
          <p class="hint">The AI (Claude) reads the story and looks at the app's screens to write the scenes. Only use it where that's allowed.
            ${tour.scenes.some(s => s.steps?.length || s.narration) ? '<b>It replaces the scenes below.</b>' : ''}</p>
          <div class="actions tight"><button class="chunky small c-purple" id="gen-go">✨ WRITE THE SCENES</button>
            <button class="chunky small c-gray" id="gen-cancel">CANCEL</button></div>
          <div id="gen-msg"></div></div>`;
      const draw = () => {
        $app.innerHTML = `<a class="back" href="#/tour/${encodeURIComponent(p)}">← back</a>
          <div class="title-row"><div class="page-title">✏️ ${h(pretty(p.split('/').pop()))}</div>
            <button class="chunky small c-purple" id="gen" ${genOpen ? 'disabled' : ''}>✨ GENERATE</button></div>
          ${genPanel()}
          ${tour.scenes.map((s, i) => `<div class="scene-card ${flagScene === i + 1 ? 'flag' : ''} ${s.camera === false ? 'offcam' : ''}" data-s="${i}">
            <div class="scene-head"><span class="scene-num">${i + 1}</span>
              <input class="scene-title" data-s="${i}" data-f="title" value="${h(s.title ?? '')}" placeholder="Scene title">
              <span class="icons"><button class="icon-btn cam ${s.camera === false ? 'cam-off' : ''}" data-local data-camscene="${i}"
                  title="${s.camera === false ? 'Off camera: it runs and is checked, but is not in the video. Click to film it.' : 'On camera. Click to run it off camera (checked, not filmed, no narration needed).'}"
                  aria-label="${s.camera === false ? 'Scene is off camera' : 'Scene is on camera'}" aria-pressed="${s.camera === false}">🎥</button>
                <button class="icon-btn" data-local data-clonescene="${i}" title="Copy this scene" aria-label="Copy this scene">⧉</button>
                <button class="icon-btn del" data-local data-delscene="${i}" title="Delete this scene" aria-label="Delete this scene">🗑</button></span></div>
            ${s.camera === false ? `<div class="offcam-note">🎥 Off camera: these steps run and are checked, but this scene is not in the video and needs no narration.</div>` : `<label class="lbl">Narration</label>
            <textarea class="narr" rows="3" data-s="${i}" data-f="narration" placeholder="What should the voice say here?">${h(s.narration ?? '')}</textarea>
            <div class="timing" data-timing="${i}">${timingHtml(i)}</div>`}
            <label class="lbl">Steps</label>
            <div class="steps">${(s.steps ?? []).map((st, j) => stepRow(st, i, j, flagScene === i + 1 && flagStep === j + 1)).join('')
              || '<div class="hint">No steps yet.</div>'}</div>
            ${picking === i ? `<div class="picker">${Object.entries(KINDS).map(([k, K]) => `<button class="pick" data-pick="${k}" data-s="${i}">
                <span class="icon">${K.icon}</span><b>${K.label}</b><span class="hint">${K.hint}</span></button>`).join('')}</div>`
              : `<button class="chunky small c-blue" data-add="${i}">＋ ADD STEP</button>
                 <button class="chunky small c-gray" data-pickpage="${i}" title="Open the app at this scene's page and pick what to click or type into">🖱 PICK FROM THE PAGE</button>`}
            ${pick?.scene === i ? pickPanel(i) : ''}
          </div>`).join('')}
          <div class="actions">
            <button class="chunky mid c-blue" id="addscene"><span class="icon">➕</span>ADD SCENE</button>
            <button class="chunky mid c-green" id="save"><span class="icon">💾</span>SAVE</button></div>
          <div id="msg"></div>
          <p class="hint"><a href="#/edit/${encodeURIComponent(p)}">edit the raw file instead</a></p>`;
        wire();
      };
      /** {artifact.<name>.<field>} references available at scene i, step j: pins earlier in the script (and role forms). */
      const artifactRefs = (i, j) => {
        const refs = [];
        tour.scenes.forEach((s, si) => (s.steps ?? []).forEach((st, sj) => {
          if (!st.pin || si > i || (si === i && sj >= j)) return;
          for (const f of Object.keys(st.fields ?? {})) {
            refs.push({ ref: `{artifact.${st.pin}.${f}}`, label: `${st.pin} · ${f}${(st.secret ?? []).includes(f) ? ' (secret)' : ''}` });
            if (st.role) refs.push({ ref: `{artifact[${st.role}].${f}}`, label: `latest ${st.role} · ${f}` });
          }
        }));
        return [...new Map(refs.map(r => [r.ref, r])).values()];
      };
      /** "🗣 about 9 s spoken · 👣 about 12 s of steps", with a warning when the steps outlast the voice. */
      function timingHtml(i) {
        const s = tour.scenes[i], t = sceneTiming(s), r = x => Math.round(x);
        if (!t.spoken && !t.steps) return '';
        const filmed = filmedLength[i + 1];
        const over = t.spoken && t.steps > t.spoken + 1;
        return `<span class="hint">🗣 about ${r(t.spoken)} s spoken · 👣 about ${r(t.steps)} s of steps${filmed ? ` · 🎬 ${r(filmed)} s in the last video` : ''}</span>
          ${over ? `<div class="warn-text">⚠ The steps take longer than the voice: the scene runs on silently for about ${r(t.steps - t.spoken)} s. Add a few words, or move some steps to a scene of their own.</div>` : ''}
          ${!t.spoken && t.steps ? '<div class="hint">No narration yet: the scene lasts as long as its steps.</div>' : ''}`;
      }

      /** Where the app should open for scene i: its url, else the last page an earlier step opened, else the start page. */
      function scenePage(i) {
        for (let k = i; k >= 0; k--) {
          const s = tour.scenes[k], g = [...(s.steps ?? [])].reverse().find(st => isStr(st.goto))?.goto;
          if (g) return g;
          if (s.url) return s.url;
        }
        return '';
      }

      const ROLE_ICON = { button: '🔘', link: '🔗', tab: '🗂', menuitem: '☰', option: '•', checkbox: '☑', radio: '◉', switch: '⏻', textbox: '⌨️', searchbox: '🔎', combobox: '▾', spinbutton: '🔢', heading: '🅷' };
      /** The live page for scene i: a screenshot and every name on it a step can use, each with what it can do. */
      function pickPanel(i) {
        const P = pick;
        const head = `<div class="pick-head"><b>🖱 Pick from the page</b>
          <input class="mid-input" id="pick-url" value="${h(P.url ?? '')}" placeholder="page, e.g. #/ or /reports (blank: where it is now)">
          <button class="chunky small c-blue" id="pick-load">↻ OPEN</button>
          ${P.live ? `<button class="chunky small c-gray" id="pick-steps" title="Do this scene's steps in the open browser first, then look again">▶ DO THE STEPS SO FAR</button>
            <button class="chunky small c-gray" id="pick-stop" title="Close the browser kept open for picking">■ CLOSE THE BROWSER</button>`
            : '<button class="chunky small c-gray" id="pick-live" title="Keep a signed-in browser open: each look takes a second instead of starting over">⚡ KEEP A BROWSER OPEN</button>'}
          <button class="chunky small c-gray" id="pick-close">✕</button></div>`;
        if (P.state === 'loading') return `<div class="pick-panel">${head}<div class="verdict wait">⏳ ${h(P.what ?? 'Opening the app')}…<small id="pick-last">${P.live ? '' : 'Without an open browser this starts one and signs in: up to a minute.'}</small></div></div>`;
        if (P.state === 'error') return `<div class="pick-panel">${head}<div class="verdict bad">✘ ${h(P.error)}</div></div>`;
        const filter = (P.filter ?? '').toLowerCase();
        const list = P.targets.filter(t => !filter || t.name.toLowerCase().includes(filter));
        const chosen = P.chosen != null ? P.targets[P.chosen] : null;
        return `<div class="pick-panel">${head}
          <p class="hint">${h(P.title ?? '')} <code>${h(P.pageUrl ?? '')}</code>. ${P.live ? 'The open browser keeps its state between looks.' : 'It opens this page fresh: steps before this point have not been done.'}</p>
          <div class="pick-body"><div class="pick-shot">${P.shot ? `<a href="${h(P.shot)}" target="_blank"><img src="${h(P.shot)}" alt="the page now"></a>` : '<div class="noshot muted">no screenshot</div>'}</div>
            <div class="pick-list"><input class="mid-input" id="pick-filter" placeholder="filter names" value="${h(P.filter ?? '')}">
              <div class="pick-names">${list.map(t => { const n = P.targets.indexOf(t); return `<button class="pick-name ${P.chosen === n ? 'on' : ''}" data-target="${n}" title="${h(t.role)}">
                <span>${ROLE_ICON[t.role] ?? '•'}</span> ${h(t.name)} <span class="muted">${h(t.role)}</span></button>`; }).join('') || '<span class="hint">Nothing with a name here.</span>'}</div>
              ${chosen ? `<div class="pick-do"><b>${h(chosen.name)}</b>:
                <button class="chunky small c-blue" data-addpick="click">👆 Click it</button>
                ${chosen.does === 'fill' ? `<input class="mid-input" id="pick-text" placeholder="what to type"> <button class="chunky small c-blue" data-addpick="fill">⌨️ Type into it</button>` : ''}
                <button class="chunky small c-blue" data-addpick="verify">✅ Check it shows</button></div>` : '<p class="hint">Pick a name to add a step for it.</p>'}
            </div></div></div>`;
      }

      /** Runs a CLI job for the pick panel; resolves with its result. */
      const pickRun = (args, what) => new Promise(ok => {
        pick = { ...pick, state: 'loading', what }; draw();
        runJob(args, { onLine: l => { const el = $app.querySelector('#pick-last'); if (el && /sign|login|launch|attach|session|browser/i.test(l)) el.textContent = l.slice(0, 140); },
          onDone: ok }).then(j => (pickJob = j));
      });
      async function pickLook(url) {
        const r = await pickRun(['snapshot', '--platform', platform, '--screenshot', ...(url ? ['--url', url] : [])], url ? `Opening ${url}` : 'Looking at the page');
        if (!pick) return;
        if (!r.ok) { pick = { ...pick, state: 'error', error: r.error?.message ?? 'It could not open the page.' }; draw(); return; }
        const d = r.data ?? {};
        const shot = d.screenshot ? `/api/file/${rel(d.screenshot).replace(/^out\//, '').split('/').map(encodeURIComponent).join('/')}` : null;
        pick = { ...pick, state: 'ready', url, pageUrl: d.url, title: d.title, shot, targets: ariaTargets(d.aria), chosen: null };
        draw();
      }
      async function pickLive() {
        const r = await pickRun(['session', 'start', '--platform', platform], 'Opening a browser to keep');
        if (!pick) return;
        pick.live = !!r.ok;
        if (!r.ok) { pick = { ...pick, state: 'error', error: r.error?.message ?? "Couldn't open a browser." }; draw(); return; }
        pickLook(pick.url);
      }
      async function pickSteps(i) {
        const s = tour.scenes[i];
        const steps = [...(s.url ? [{ goto: s.url }] : []), ...(s.steps ?? [])].map(({ camera, ...st }) => st);
        if (!steps.length) return pickLook(pick.url);
        const r = await pickRun(['try-step', JSON.stringify(steps), '--platform', platform], `Doing scene ${i + 1}'s ${steps.length} step(s)`);
        if (!pick) return;
        if (!r.ok) { pick = { ...pick, state: 'error', error: `A step didn't work: ${r.error?.message ?? r.data?.error ?? ''}` }; draw(); return; }
        pickLook('');
      }

      /** The pin step's editor: name, role, each field (from the page, the page address, or a fixed value), secrets, cleanup. */
      function pinEditor(st, i, j) {
        const fields = Object.entries(st.fields ?? {});
        const modeOf = v => isStr(v) ? 'page' : v?.capture?.url ? 'url' : v && 'value' in v ? 'value' : v?.capture ? 'capture' : 'page-adv';
        const fieldRow = ([k, v], n) => {
          const mode = modeOf(v);
          const main = mode === 'page' ? v : mode === 'url' ? v.pattern ?? '' : mode === 'value' ? v.value ?? '' : JSON.stringify(v);
          return `<div class="pin-field" data-n="${n}">
            <input class="pin-in" data-pf="name" value="${h(k)}" placeholder="field, e.g. id" size="10">
            <select class="pin-in" data-pf="mode">
              <option value="page" ${mode === 'page' ? 'selected' : ''}>from the page: words of the element</option>
              <option value="url" ${mode === 'url' ? 'selected' : ''}>from the page address (a pattern)</option>
              <option value="value" ${mode === 'value' ? 'selected' : ''}>a fixed value</option>
              ${['capture', 'page-adv'].includes(mode) ? `<option value="${mode}" selected>advanced (JSON)</option>` : ''}</select>
            <input class="pin-in mid-input" data-pf="main" value="${h(main)}" placeholder="${mode === 'url' ? 'e.g. /orders/(\\d+)' : mode === 'value' ? 'value' : 'e.g. Order number'}">
            <label class="hint"><input type="checkbox" class="pin-in" data-pf="secret" ${(st.secret ?? []).includes(k) ? 'checked' : ''}> secret</label>
            <button class="del" data-pindel="${n}" title="Remove this field">🗑</button>${dataHint(main, data)}</div>`;
        };
        const cleanup = st.cleanup == null ? '' : JSON.stringify(st.cleanup, null, 2);
        return `<div class="pin-editor" data-pin="${i}:${j}">
          <label class="lbl">Name it (later steps use {artifact.<i>name</i>.<i>field</i>})</label><input class="mid-input pin-top" data-pk="pin" value="${h(st.pin)}">
          <label class="lbl">What kind of thing it is (optional; {artifact[<i>kind</i>].field} is the latest one)</label><input class="mid-input pin-top" data-pk="role" value="${h(st.role ?? '')}" placeholder="e.g. order">
          <label class="lbl">Its fields</label>${fields.map(fieldRow).join('')}
          <button class="chunky small c-blue" data-pinadd>＋ FIELD</button>
          <label class="lbl">How to remove it afterwards (cleanup: steps, e.g. [{"click": "Delete"}], or a hook {"run": "…"}; blank: none)</label>
          <textarea class="pin-cleanup" rows="${Math.min(8, cleanup.split('\n').length + 1)}" spellcheck="false">${h(cleanup)}</textarea>
          <div class="pin-msg"></div>
          <button class="chunky small c-gray" data-pindone>✔ DONE</button></div>`;
      }
      /** Reads the pin editor back into the step; returns an error message or null. */
      function readPin(box, st) {
        const top = k => box.querySelector(`[data-pk="${k}"]`).value.trim();
        if (!/^[A-Za-z_][\w-]*$/.test(top('pin'))) return 'The name: letters, digits, - and _ (start with a letter).';
        const fields = {}, secret = [];
        for (const row of box.querySelectorAll('.pin-field')) {
          const g = k => row.querySelector(`[data-pf="${k}"]`);
          const k = g('name').value.trim(), mode = g('mode').value, main = g('main').value;
          if (!k) continue;
          if (!/^[A-Za-z_][\w-]*$/.test(k)) return `Field "${k}": letters, digits, - and _.`;
          if (mode === 'page') fields[k] = main;
          else if (mode === 'url') fields[k] = { capture: { url: true }, ...(main ? { pattern: main } : {}) };
          else if (mode === 'value') fields[k] = { value: main };
          else { try { fields[k] = JSON.parse(main); } catch { return `Field "${k}": that isn't valid JSON.`; } }
          if (g('secret').checked) secret.push(k);
        }
        if (!Object.keys(fields).length) return 'Give it at least one field.';
        const cl = box.querySelector('.pin-cleanup').value.trim();
        let cleanup; if (cl) { try { cleanup = JSON.parse(cl); } catch { return "The cleanup isn't valid JSON."; } }
        st.pin = top('pin');
        if (top('role')) st.role = top('role'); else delete st.role;
        st.fields = fields;
        if (secret.length) st.secret = secret; else delete st.secret;
        if (cleanup !== undefined) st.cleanup = cleanup; else delete st.cleanup;
        return null;
      }

      function stepRow(st, i, j, flag) {
        const k = kindOf(st), K = KINDS[k];
        const off = st.camera === false;
        const tools = `<span class="row-tools"><button class="cam ${off ? 'cam-off' : ''}" data-camstep="${j}" data-s="${i}" aria-pressed="${off}"
            title="${off ? 'Off camera: it runs and is checked, but is cut from the video. Click to film it.' : 'On camera. Click to cut this step from the video (it still runs).'}" aria-label="${off ? 'Step is off camera' : 'Step is on camera'}">🎥</button>
          <button data-mv="-1" data-s="${i}" data-j="${j}" title="Move up">↑</button><button data-mv="1" data-s="${i}" data-j="${j}" title="Move down">↓</button>
          <button data-clonestep="${j}" data-s="${i}" title="Copy this step" aria-label="Copy this step">⧉</button>
          <button class="del" data-del="${j}" data-s="${i}" title="Delete this step" aria-label="Delete this step">🗑</button></span>`;
        const cls = `step-row ${flag ? 'flag' : ''} ${off ? 'offcam' : ''}`;
        if (st.pin) return `<div class="${cls} adv"><span class="step-icon">📌</span><span>Pin <b>${h(st.pin)}</b>${st.role ? ` (${h(st.role)})` : ''}: ${h(Object.keys(st.fields ?? {}).join(', '))}
          ${st.cleanup ? '<span class="badge ok">has cleanup</span>' : '<span class="badge warn" title="Say how to remove it (✏️) so the run cleans up after itself">no cleanup</span>'}
          <button class="edit-pin" data-editpin="${i}:${j}" title="Edit this pin">✏️</button></span>${tools}</div>
          ${pinOpen === `${i}:${j}` ? pinEditor(st, i, j) : ''}`;
        if (!K) return `<div class="${cls} adv"><span class="step-icon">⚙</span><span>advanced step: ${h(summary(st))}</span>${tools}<span class="data-hints">${dataHint(JSON.stringify(st), data)}</span></div>`;
        const refs = artifactRefs(i, j);
        const inputs = K.fields.map(([f, ph, type]) => `<span class="in-wrap"><input class="step-in" data-s="${i}" data-j="${j}" data-k="${f}" ${type === 'number' ? 'type="number" min="0" step="0.5"' : ''}
          value="${h(getF(st, f) ?? '')}" placeholder="${h(ph)}">${refs.length && type !== 'number' ? `<select class="art-pick" data-s="${i}" data-j="${j}" data-k="${f}" title="Use a value this run created earlier (a pinned artifact)" aria-label="Insert an artifact value">
            <option value="">📌</option>${refs.map(r => `<option value="${h(r.ref)}">${h(r.label)}</option>`).join('')}</select>` : ''}</span>`);
        const words = K.words.map(w => w ? `<span>${h(w)}</span>` : '');
        const parts = []; for (let n = 0; n < words.length; n++) { parts.push(words[n]); if (inputs[n]) parts.push(inputs[n]); }
        const hints = K.fields.map(([f]) => dataHint(getF(st, f), data)).join('');
        return `<div class="${cls}"><span class="step-icon">${K.icon}</span>${parts.join('')}${off ? '<span class="badge offcam">off camera</span>' : ''}${tools}
          <span class="data-hints" data-hints="${i}:${j}">${hints}</span></div>`;
      }
      function wire() {
        const $$ = s => $app.querySelectorAll(s);
        const retime = i => { const el = $app.querySelector(`[data-timing="${i}"]`); if (el) el.innerHTML = timingHtml(Number(i)); };
        $$('[data-f]').forEach(el => (el.oninput = () => { tour.scenes[el.dataset.s][el.dataset.f] = el.value; dirty = true; if (el.dataset.f === 'narration') retime(el.dataset.s); }));
        $$('.step-in').forEach(el => (el.oninput = () => {
          const st = tour.scenes[el.dataset.s].steps[el.dataset.j];
          setF(st, el.dataset.k, el.type === 'number' ? Number(el.value) : el.value); dirty = true;
          retime(el.dataset.s);
          const hb = $app.querySelector(`[data-hints="${el.dataset.s}:${el.dataset.j}"]`), K = KINDS[kindOf(st)];
          if (hb && K) hb.innerHTML = K.fields.map(([f]) => dataHint(getF(st, f), data)).join(''); }));
        // 🖱 pick from the page
        $$('[data-pickpage]').forEach(b => (b.onclick = async () => {
          const i = Number(b.dataset.pickpage);
          pickJob?.close();
          pick = { scene: i, url: scenePage(i), live: false, state: 'loading', what: 'Looking for an open browser' }; draw();
          const st = await new Promise(ok => runJob(['session', 'status'], { onDone: ok }));
          if (!pick) return;
          pick.live = !!st.data?.sessions?.some(s => s.platform === platform && s.status === 'ready');
          pickLook(pick.url);
        }));
        if (pick) {
          const i = pick.scene;
          $app.querySelector('#pick-close').onclick = () => { pickJob?.stop(); pickJob?.close(); pick = null; draw(); };
          $app.querySelector('#pick-load').onclick = () => pickLook($app.querySelector('#pick-url').value.trim());
          $app.querySelector('#pick-url').onkeydown = e => { if (e.key === 'Enter') pickLook(e.target.value.trim()); };
          $app.querySelector('#pick-live')?.addEventListener('click', pickLive);
          $app.querySelector('#pick-steps')?.addEventListener('click', () => pickSteps(i));
          $app.querySelector('#pick-stop')?.addEventListener('click', async () => {
            await pickRun(['session', 'stop', '--platform', platform], 'Closing the browser');
            if (pick) { pick.live = false; pick.state = 'ready'; pick.targets ??= []; draw(); }
          });
          const f = $app.querySelector('#pick-filter');
          if (f) f.oninput = () => { pick.filter = f.value; const at = f.selectionStart; draw(); const g = $app.querySelector('#pick-filter'); g.focus(); g.setSelectionRange(at, at); };
          $$('[data-target]').forEach(b => (b.onclick = () => { pick.chosen = Number(b.dataset.target); draw(); $app.querySelector('#pick-text')?.focus(); }));
          $$('[data-addpick]').forEach(b => (b.onclick = () => {
            const t = pick.targets[pick.chosen], steps = (tour.scenes[i].steps ??= []);
            const step = b.dataset.addpick === 'click' ? { click: t.name }
              : b.dataset.addpick === 'fill' ? { fill: t.name, text: $app.querySelector('#pick-text')?.value ?? '' }
              : { verify: { text: t.name } };
            steps.push(step); dirty = true; pick.chosen = null; draw();
          }));
        }
        // 📌 pin editor
        $$('[data-editpin]').forEach(b => (b.onclick = () => { pinOpen = pinOpen === b.dataset.editpin ? null : b.dataset.editpin; draw(); }));
        $$('.pin-editor').forEach(box => {
          const [i, j] = box.dataset.pin.split(':').map(Number), st = tour.scenes[i].steps[j];
          const apply = () => { const err = readPin(box, st); box.querySelector('.pin-msg').innerHTML = err ? `<div class="bad-text">${h(err)}</div>` : ''; if (!err) dirty = true; return !err; };
          box.querySelectorAll('input, select, textarea').forEach(el => (el.onchange = apply));
          box.querySelector('[data-pinadd]').onclick = () => { if (!apply()) return; let n = Object.keys(st.fields).length + 1; while (`field${n}` in st.fields) n++; st.fields[`field${n}`] = ''; dirty = true; draw(); };
          box.querySelectorAll('[data-pindel]').forEach(b => (b.onclick = () => { box.querySelector(`.pin-field[data-n="${b.dataset.pindel}"]`).remove(); apply(); draw(); }));
          box.querySelector('[data-pindone]').onclick = () => { if (apply()) { pinOpen = null; draw(); } };
        });
        $$('[data-add]').forEach(b => (b.onclick = () => { picking = Number(b.dataset.add); draw(); }));
        $$('[data-pick]').forEach(b => (b.onclick = () => {
          const i = Number(b.dataset.s), steps = (tour.scenes[i].steps ??= []);
          steps.push(KINDS[b.dataset.pick].make()); picking = null; dirty = true; draw();
          $app.querySelector(`.step-in[data-s="${i}"][data-j="${steps.length - 1}"]`)?.focus();
        }));
        $$('[data-del]').forEach(b => (b.onclick = () => { tour.scenes[b.dataset.s].steps.splice(Number(b.dataset.del), 1); dirty = true; draw(); }));
        // 🎥: off camera ("camera": false) or back on (the key removed: on camera is the default).
        const toggleCam = o => { if (o.camera === false) delete o.camera; else o.camera = false; dirty = true; draw(); };
        $$('[data-camscene]').forEach(b => (b.onclick = () => toggleCam(tour.scenes[b.dataset.camscene])));
        $$('[data-camstep]').forEach(b => (b.onclick = () => toggleCam(tour.scenes[b.dataset.s].steps[b.dataset.camstep])));
        // 📌: insert an {artifact.x.field} reference at the cursor of the field next to it.
        $$('.art-pick').forEach(sel => (sel.onchange = () => {
          if (!sel.value) return;
          const input = sel.parentElement.querySelector('.step-in');
          const at = input.selectionStart ?? input.value.length;
          input.value = input.value.slice(0, at) + sel.value + input.value.slice(input.selectionEnd ?? at);
          setF(tour.scenes[sel.dataset.s].steps[sel.dataset.j], sel.dataset.k, input.value);
          dirty = true; sel.value = ''; input.focus();
        }));
        $$('[data-mv]').forEach(b => (b.onclick = () => {
          const steps = tour.scenes[b.dataset.s].steps, j = Number(b.dataset.j), to = j + Number(b.dataset.mv);
          if (to < 0 || to >= steps.length) return;
          [steps[j], steps[to]] = [steps[to], steps[j]]; dirty = true; draw();
        }));
        $$('[data-delscene]').forEach(b => (b.onclick = () => {
          const i = Number(b.dataset.delscene), s = tour.scenes[i];
          if ((s.steps?.length || s.narration) && !confirmDelete(b)) return;
          tour.scenes.splice(i, 1); dirty = true; draw();
        }));
        $$('[data-clonescene]').forEach(b => (b.onclick = () => {
          const i = Number(b.dataset.clonescene), copy = structuredClone(tour.scenes[i]);
          delete copy.id;
          copy.title = copy.title ? `${copy.title} (copy)` : '';
          tour.scenes.splice(i + 1, 0, copy); dirty = true; draw();
          $app.querySelector(`.scene-card[data-s="${i + 1}"]`)?.scrollIntoView({ block: 'center' });
        }));
        $$('[data-clonestep]').forEach(b => (b.onclick = () => {
          const steps = tour.scenes[b.dataset.s].steps, j = Number(b.dataset.clonestep);
          steps.splice(j + 1, 0, structuredClone(steps[j])); dirty = true; draw();
        }));
        $app.querySelector('#addscene').onclick = () => {
          tour.scenes.push({ title: '', narration: '', steps: [] }); dirty = true; draw();
          $app.querySelector(`.scene-title[data-s="${tour.scenes.length - 1}"]`)?.focus();
        };
        $app.querySelector('#save').onclick = save;
        $app.querySelector('#gen').onclick = () => { genOpen = true; draw(); $app.querySelector('#story')?.focus(); };
        if (genOpen) {
          const story = $app.querySelector('#story');
          story.oninput = () => { genText = story.value; };
          $app.querySelector('#gen-cancel').onclick = () => { genJob?.stop(); genJob?.close(); genJob = null; genOpen = false; draw(); };
          $app.querySelector('#gen-go').onclick = generate;
        }
        const flagged = $app.querySelector('.step-row.flag') ?? $app.querySelector('.scene-card.flag');
        flagged?.scrollIntoView({ block: 'center' });
      }
      async function generate() {
        const msg = $app.querySelector('#gen-msg');
        if (genText.trim().length < 20) { msg.innerHTML = '<div class="verdict bad">✘ Paste the story first (a title and what it should do).</div>'; return; }
        $app.querySelector('#gen-go').disabled = true;
        msg.innerHTML = '<div class="verdict wait">⏳ Writing the scenes… this takes a minute or two.<small id="gen-last">Starting</small></div>';
        genJob = await runJob(['generate', '--story', genText, '--platform', platform, '--llm', 'claude'], {
          onLine: l => { const el = $app.querySelector('#gen-last'); if (!el) return;
            el.textContent = /discover|crawl|page/i.test(l) ? 'Looking at the app' : /claude|plan|llm/i.test(l) ? 'Thinking about the scenes' : /sign|login/i.test(l) ? 'Signing in' : el.textContent; },
          onDone: async r => {
            genJob = null;
            const box = $app.querySelector('#gen-msg');
            if (!r.ok || !r.data?.tour) {
              const f = friendly(r);
              if (box) box.innerHTML = `<div class="verdict bad">✘ ${h(f.title)}<small>${h(f.detail)}</small>
                <details class="raw"><summary>details</summary><pre>${h(f.raw)}</pre></details></div>`;
              $app.querySelector('#gen-go')?.removeAttribute('disabled');
              return;
            }
            try {
              const made = JSON.parse((await api(`/api/tour?path=${encodeURIComponent(rel(r.data.tour))}`)).text);
              tour.scenes = made.scenes ?? [];
              if (made.story) tour.story = made.story;
              // the planner writes paths from the site root; keep them inside the app's address
              const g = fixGotos(tour, pd.baseUrl);
              genOpen = false; dirty = true; draw();
              $app.querySelector('#msg').innerHTML = `<div class="verdict ok">✨ ${tour.scenes.length} scene${tour.scenes.length === 1 ? '' : 's'} written
                <small>Read them through, fix anything that's off, then press SAVE.${made.draft ? ' Some steps still need filling in.' : ''}</small>
                ${g.fixed.length ? `<small>Pages made relative to the app's address (${h(g.basePath)}): ${h(g.fixed.join('; '))}</small>` : ''}
                ${g.outside.length ? `<small class="bad-text">⚠ These open a page outside the app's address (${h(g.basePath)}); check them: ${h(g.outside.join('; '))}</small>` : ''}</div>`;
              $app.querySelector('.scene-card')?.scrollIntoView({ block: 'start' });
            } catch (e) { if (box) box.innerHTML = `<div class="verdict bad">✘ Couldn't read what it wrote<small>${h(e.message)}</small></div>`; }
          } });
      }
      async function save() {
        const msg = $app.querySelector('#msg');
        const problems = [];
        if (!tour.scenes.length) problems.push('Add at least one scene.');
        tour.scenes.forEach((s, i) => {
          if (!String(s.title ?? '').trim()) problems.push(`Scene ${i + 1}: give it a title.`);
          if (s.camera !== false && !String(s.narration ?? '').trim()) problems.push(`Scene ${i + 1}: what should the voice say?`);
        });
        tour.scenes.forEach((s, i) => (s.steps ?? []).forEach((st, j) => {
          const k = kindOf(st);
          if (k && KINDS[k].fields.some(([f]) => getF(st, f) === '' || getF(st, f) == null || Number.isNaN(getF(st, f))))
            problems.push(`Scene ${i + 1}, step ${j + 1}: ${KINDS[k].need}?`);
        }));
        if (problems.length) { msg.innerHTML = `<div class="verdict bad">✘ A few blanks to fill in${problems.slice(0, 5).map(x => `<small>${h(x)}</small>`).join('')}</div>`; return; }
        try {
          // unchanged: keep the file as it is (and its hand formatting)
          if (JSON.stringify(tour) !== original) { await saveFile(p, tour); original = JSON.stringify(tour); }
          dirty = false;
          // a root path leaves the app's address (goto resolves like new URL(path, baseUrl)): say so, don't block
          const outside = fixGotos(structuredClone(tour), pd.baseUrl).outside;
          msg.innerHTML = `<div class="verdict ok">✔ Saved${outside.length ? `<small class="bad-text">⚠ Opens a page outside the app's address: ${h(outside.join('; '))}. Start it without "/" (e.g. "#/" or "reports") to stay inside it.</small>` : ''}<div class="actions tight"><a class="chunky small c-orange" href="#/tour/${encodeURIComponent(p)}">🔍 GO CHECK IT</a></div></div>`;
        } catch (e) { msg.innerHTML = `<div class="verdict bad">✘ Couldn't save<small>${h(e.message)}</small></div>`; }
      }
      draw();
      const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
      addEventListener('beforeunload', warn);
      return () => { removeEventListener('beforeunload', warn); genJob?.close(); pickJob?.close(); };
    },
  };
  return views;
}
