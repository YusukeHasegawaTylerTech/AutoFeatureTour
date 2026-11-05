// The simple screens: for someone who has never seen the tool. No JSON, no CLI words, plain-language results.
// Advanced screens live in app.js behind the ☰ menu.

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
  function kindOf(s) {
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
          <track default kind="captions" src="${fileUrl(lastVideo.id, 'tour.vtt')}"></video></div>` : ''}`;
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
          ${tour.scenes.map((s, i) => `<div class="scene-card ${flagScene === i + 1 ? 'flag' : ''}" data-s="${i}">
            <div class="scene-head"><span class="scene-num">${i + 1}</span>
              <input class="scene-title" data-s="${i}" data-f="title" value="${h(s.title ?? '')}" placeholder="Scene title">
              <span class="icons"><button class="icon-btn" data-local data-clonescene="${i}" title="Copy this scene" aria-label="Copy this scene">⧉</button>
                <button class="icon-btn del" data-local data-delscene="${i}" title="Delete this scene" aria-label="Delete this scene">🗑</button></span></div>
            <label class="lbl">Narration</label>
            <textarea class="narr" rows="3" data-s="${i}" data-f="narration" placeholder="What should the voice say here?">${h(s.narration ?? '')}</textarea>
            <label class="lbl">Steps</label>
            <div class="steps">${(s.steps ?? []).map((st, j) => stepRow(st, i, j, flagScene === i + 1 && flagStep === j + 1)).join('')
              || '<div class="hint">No steps yet.</div>'}</div>
            ${picking === i ? `<div class="picker">${Object.entries(KINDS).map(([k, K]) => `<button class="pick" data-pick="${k}" data-s="${i}">
                <span class="icon">${K.icon}</span><b>${K.label}</b><span class="hint">${K.hint}</span></button>`).join('')}</div>`
              : `<button class="chunky small c-blue" data-add="${i}">＋ ADD STEP</button>`}
          </div>`).join('')}
          <div class="actions">
            <button class="chunky mid c-blue" id="addscene"><span class="icon">➕</span>ADD SCENE</button>
            <button class="chunky mid c-green" id="save"><span class="icon">💾</span>SAVE</button></div>
          <div id="msg"></div>
          <p class="hint"><a href="#/edit/${encodeURIComponent(p)}">edit the raw file instead</a></p>`;
        wire();
      };
      function stepRow(st, i, j, flag) {
        const k = kindOf(st), K = KINDS[k];
        const tools = `<span class="row-tools"><button data-mv="-1" data-s="${i}" data-j="${j}" title="Move up">↑</button><button data-mv="1" data-s="${i}" data-j="${j}" title="Move down">↓</button>
          <button data-clonestep="${j}" data-s="${i}" title="Copy this step" aria-label="Copy this step">⧉</button>
          <button class="del" data-del="${j}" data-s="${i}" title="Delete this step" aria-label="Delete this step">🗑</button></span>`;
        if (!K) return `<div class="step-row adv ${flag ? 'flag' : ''}"><span class="step-icon">⚙</span><span>advanced step: ${h(summary(st))}</span>${tools}</div>`;
        const inputs = K.fields.map(([f, ph, type]) => `<input class="step-in" data-s="${i}" data-j="${j}" data-k="${f}" ${type === 'number' ? 'type="number" min="0" step="0.5"' : ''}
          value="${h(getF(st, f) ?? '')}" placeholder="${h(ph)}">`);
        const words = K.words.map(w => w ? `<span>${h(w)}</span>` : '');
        const parts = []; for (let n = 0; n < words.length; n++) { parts.push(words[n]); if (inputs[n]) parts.push(inputs[n]); }
        return `<div class="step-row ${flag ? 'flag' : ''}"><span class="step-icon">${K.icon}</span>${parts.join('')}${tools}</div>`;
      }
      function wire() {
        const $$ = s => $app.querySelectorAll(s);
        $$('[data-f]').forEach(el => (el.oninput = () => { tour.scenes[el.dataset.s][el.dataset.f] = el.value; dirty = true; }));
        $$('.step-in').forEach(el => (el.oninput = () => {
          const st = tour.scenes[el.dataset.s].steps[el.dataset.j];
          setF(st, el.dataset.k, el.type === 'number' ? Number(el.value) : el.value); dirty = true; }));
        $$('[data-add]').forEach(b => (b.onclick = () => { picking = Number(b.dataset.add); draw(); }));
        $$('[data-pick]').forEach(b => (b.onclick = () => {
          const i = Number(b.dataset.s), steps = (tour.scenes[i].steps ??= []);
          steps.push(KINDS[b.dataset.pick].make()); picking = null; dirty = true; draw();
          $app.querySelector(`.step-in[data-s="${i}"][data-j="${steps.length - 1}"]`)?.focus();
        }));
        $$('[data-del]').forEach(b => (b.onclick = () => { tour.scenes[b.dataset.s].steps.splice(Number(b.dataset.del), 1); dirty = true; draw(); }));
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
              genOpen = false; dirty = true; draw();
              $app.querySelector('#msg').innerHTML = `<div class="verdict ok">✨ ${tour.scenes.length} scene${tour.scenes.length === 1 ? '' : 's'} written
                <small>Read them through, fix anything that's off, then press SAVE.${made.draft ? ' Some steps still need filling in.' : ''}</small></div>`;
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
          if (!String(s.narration ?? '').trim()) problems.push(`Scene ${i + 1}: what should the voice say?`);
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
          msg.innerHTML = `<div class="verdict ok">✔ Saved<div class="actions tight"><a class="chunky small c-orange" href="#/tour/${encodeURIComponent(p)}">🔍 GO CHECK IT</a></div></div>`;
        } catch (e) { msg.innerHTML = `<div class="verdict bad">✘ Couldn't save<small>${h(e.message)}</small></div>`; }
      }
      draw();
      const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
      addEventListener('beforeunload', warn);
      return () => { removeEventListener('beforeunload', warn); genJob?.close(); };
    },
  };
  return views;
}
