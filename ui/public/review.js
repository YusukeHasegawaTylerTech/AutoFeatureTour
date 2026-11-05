// The review of one run (report.json / validation.json "review", from src/review.mjs): the verdict, evidence per
// criterion, and every finding with the calls a person can make about it. Decisions are written into the tour that
// ran ("review.decisions", and "workarounds" for "work around it for now"); they never touch the platform.

const DECIDED = { script: '✏️ script is wrong', workaround: '🩹 real issue, worked around for now', 'app-issue': '🐞 real app issue', accept: '✔ accepted' };
const STRENGTH = { strong: ['ok', 'strong'], moderate: ['warn', 'moderate'], weak: ['bad', 'weak'], none: ['bad', 'not checked'], failed: ['bad', 'failed'] };
const VERDICT = { passed: 'ok', 'passed-with-issues': 'warn', 'needs-review': 'warn', failed: 'bad', 'failed-app-issue': 'bad' };

/** The tour file a run used, if the UI may write it: platforms/**.tour.json or out/**\/tour.json. */
function tourFileOf(d, input, rel) {
  const r = input ? rel(input) : '';
  if (/^platforms\/.+\.tour\.json$/.test(r)) return { path: r, api: 'pfile' };
  if (/^out\/.+tour\.json$/.test(r)) return { path: r, api: 'tour' };
  return null;
}

export async function mountReview(box, { id, d, input, h, api, rel, fileUrl, onCheckAgain }) {
  let rv = d.report?.review ?? null;
  if (!rv && d.files.some(f => f.path === 'validation.json')) { try { rv = (await (await fetch(fileUrl(id, 'validation.json'))).json()).review; } catch {} }
  if (!rv) { box.innerHTML = ''; return; }
  const file = tourFileOf(d, input, rel);
  const load = async () => JSON.parse((await api(`/api/${file.api}?path=${encodeURIComponent(file.path)}`)).text);
  const save = async tour => api(`/api/${file.api}?path=${encodeURIComponent(file.path)}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: JSON.stringify(tour, null, 2) + '\n' }) });
  const editStep = f => file?.api === 'pfile' ? `#/write/${encodeURIComponent(file.path)}?scene=${Number(String(f.scene ?? '').slice(6)) || ''}&step=${f.scriptStep ?? f.step ?? ''}` : null;
  const editScene = () => (file?.api === 'pfile' ? `#/write/${encodeURIComponent(file.path)}` : null);

  const buttons = f => {
    if (f.kind === 'known-issue') return f.id.startsWith('xfail|') ? '<button data-act="remove-ki">🗑 STOP EXPECTING IT TO FAIL</button>' : '<button data-act="remove-wa">🗑 REMOVE THE WORKAROUND</button>';
    if (f.kind === 'issue-gone' && f.id.startsWith('xpass|')) return '<button data-act="remove-ki">🗑 FIXED: STOP EXPECTING IT TO FAIL</button><button data-act="accept">✔ KEEP IT</button>';
    if (f.decision && !f.decision.implied) return `<button data-act="undo">↩ UNDO</button>`;
    const B = (act, label, cls = '') => `<button class="${cls}" data-act="${act}">${label}</button>`;
    switch (f.kind) {
      case 'failure': return [
        editStep(f) ? `<a class="btn" data-act="script" href="${editStep(f)}">✏️ FIX THE SCRIPT${f.from ? ` (in “${h(f.from)}”)` : ''}</a>` : '',
        B('ai', '✨ AI FIX', 'ai'), f.class === 'criterion' ? B('expect', '🩹 REAL ISSUE: EXPECT IT TO FAIL FOR NOW') : B('workaround', '🩹 REAL ISSUE: WORK AROUND IT FOR NOW'), B('app-issue', '🐞 REAL ISSUE: LEAVE IT FAILING', 'bad-btn')].join('');
      case 'evidence': return [editScene(f) ? `<a class="btn" href="${editScene(f)}">✏️ ADD A CHECK</a>` : '', B('accept', '✔ GOOD ENOUGH')].join('');
      case 'workaround': return [B('accept', '✔ EXPECTED HERE'), B('workaround', '🩹 REAL ISSUE: WORK AROUND IT FOR NOW'), B('app-issue', '🐞 REAL ISSUE')].join('');
      case 'mock': return B('accept', '✔ FINE FOR THIS STORY');
      case 'leftover': return [B('cleanup', '🧹 CLEAN UP NOW', 'primary'), B('accept', '✔ IT CAN STAY')].join('');
      case 'suggest-pin': return [f.proposal ? B('pin', '📌 PIN IT', 'primary') : '', B('accept', '✔ NOT NEEDED')].join('');
      case 'issue-gone': return [B('remove-wa', '🗑 IT\'S FIXED: REMOVE THE WORKAROUND'), B('accept', '✔ KEEP IT')].join('');
      default: return B('accept', '✔ ACCEPT');
    }
  };

  const draw = () => {
    const open = rv.findings.filter(f => !f.decision);
    box.innerHTML = `<div class="card review">
      <h3>Review</h3>
      <div class="verdict-line ${VERDICT[rv.verdict] ?? ''}">${h(rv.label)}${open.length ? ` <span class="muted">· ${open.length} to decide</span>` : ''}</div>
      ${rv.evidence.length ? `<table class="evidence"><tr><th>criterion</th><th>evidence</th><th>why</th></tr>${rv.evidence.map(e => {
        const [c, w] = STRENGTH[e.strength] ?? ['', e.strength];
        return `<tr><td><b>AC${h(e.id)}</b> <span class="muted">${h(e.text)}</span></td><td><span class="badge ${c}">${h(w)}</span></td><td>${h(e.reasons.join('; '))}</td></tr>`; }).join('')}</table>` : ''}
      ${rv.findings.length ? `<div class="findings">${rv.findings.map((f, i) => `<div class="finding kind-${h(f.kind)} ${f.decision ? 'decided' : ''}" data-i="${i}">
          <div class="finding-title">${f.kind === 'failure' ? '✘' : f.decision ? '●' : '○'} ${h(f.title)}</div>
          ${f.detail ? `<div class="muted">${h(String(f.detail).slice(0, 300))}</div>` : ''}
          ${f.suggestions?.length ? `<div class="muted">did you mean: ${h(f.suggestions.join(', '))}</div>` : ''}
          ${f.decision ? `<div class="decision">${h(DECIDED[f.decision.decision] ?? f.decision.decision)}${f.decision.note ? `: ${h(f.decision.note)}` : ''}${f.decision.ticket ? ` <span class="badge">${h(f.decision.ticket)}</span>` : ''}</div>` : ''}
          ${file ? `<div class="finding-actions">${buttons(f)}</div>` : ''}
          <div class="finding-form"></div></div>`).join('')}</div>`
        : '<p class="muted">Nothing to decide: every criterion has a specific check, and no known issue or mock was involved.</p>'}
      ${!file ? '<p class="muted">This run\'s script is outside platforms/ and out/: decisions can only be made by hand in its tour file.</p>' : ''}
      <div id="review-msg"></div></div>`;
    box.querySelectorAll('.finding').forEach(el => {
      const f = rv.findings[Number(el.dataset.i)];
      el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => act(f, b.dataset.act, el, b, e)
        .catch(err => { el.querySelector('.finding-form').innerHTML = `<div class="bad">✘ ${h(err.message)}</div>`; })));
    });
  };

  /** Writes a decision (and maybe a workaround) into the tour; marks it on the page. */
  const decide = async (f, decision, extra = {}, workaround = null) => {
    const tour = await load();
    tour.review ??= {}; tour.review.decisions ??= [];
    // Undoing (or replacing) a decision also takes back what it added: its story workaround, or a step's knownIssue.
    for (const old of tour.review.decisions.filter(x => x.finding === f.id)) {
      if (old.workaround) tour.workarounds = (tour.workarounds ?? []).filter(w => w.name !== old.workaround);
      if (old.knownIssue) { const st = tour.scenes?.[Number(String(f.scene).slice(6)) - 1]?.steps?.[(f.scriptStep ?? f.step) - 1]; if (st && !extra.knownIssue) delete st.knownIssue; }
    }
    if (tour.workarounds && !tour.workarounds.length) delete tour.workarounds;
    tour.review.decisions = tour.review.decisions.filter(x => x.finding !== f.id);
    if (decision) tour.review.decisions.push({ finding: f.id, decision, ...extra, ...(workaround ? { workaround: workaround.name } : {}), at: new Date().toISOString().slice(0, 10) });
    if (!tour.review.decisions.length) delete tour.review.decisions;
    if (!Object.keys(tour.review).length) delete tour.review;
    if (workaround) { tour.workarounds = [...(tour.workarounds ?? []).filter(w => w.name !== workaround.name), workaround]; }
    await save(tour);
    f.decision = decision ? { decision, ...extra } : undefined;
    draw();
    box.querySelector('#review-msg').innerHTML = `<div class="saved">Saved in ${h(file.path)}. ${workaround ? 'The workaround applies from the next run. ' : ''}
      ${onCheckAgain ? '<button id="again" class="primary">CHECK IT AGAIN</button>' : ''}</div>`;
    box.querySelector('#again')?.addEventListener('click', () => onCheckAgain(file.path));
  };

  const noteForm = (el, f, decision, { ticket = false, prompt = 'Why?' } = {}) => {
    const form = el.querySelector('.finding-form');
    form.innerHTML = `<label>${h(prompt)} <input class="note" placeholder="a short note"></label>
      ${ticket ? '<label>Ticket <input class="ticket" placeholder="e.g. RMS-1234"></label>' : ''}
      <button class="primary save">SAVE</button> <button class="cancel">CANCEL</button>`;
    form.querySelector('.note').focus();
    form.querySelector('.cancel').onclick = () => { form.innerHTML = ''; };
    form.querySelector('.save').onclick = () => {
      const note = form.querySelector('.note').value.trim(), t = form.querySelector('.ticket')?.value.trim();
      decide(f, decision, { ...(note ? { note } : {}), ...(t ? { ticket: t } : {}) });
    };
  };

  /** A failing check that is a real app issue: the step stays, marked "knownIssue", so it is expected to fail for now. */
  const expectForm = (el, f) => {
    const form = el.querySelector('.finding-form');
    form.innerHTML = `<div class="wa-form"><p class="muted">The check stays in the script and still runs. While the issue lasts it fails as expected and the run
        reads "passed with known issues"; when it passes again, the run says the issue looks fixed.</p>
      <label>What is wrong in the app <input class="note" placeholder="e.g. the count is missing from the tab"></label>
      <label>Ticket <input class="ticket" placeholder="e.g. RMS-1234"></label>
      <button class="primary save">SAVE</button> <button class="cancel">CANCEL</button></div>`;
    form.querySelector('.note').focus();
    form.querySelector('.cancel').onclick = () => { form.innerHTML = ''; };
    form.querySelector('.save').onclick = async () => {
      const note = form.querySelector('.note').value.trim(), ticket = form.querySelector('.ticket').value.trim();
      const tour = await load();
      const st = tour.scenes?.[Number(String(f.scene).slice(6)) - 1]?.steps?.[(f.scriptStep ?? f.step) - 1];
      if (!st) { form.insertAdjacentHTML('beforeend', '<div class="bad">That step is no longer in the script (it changed since the run).</div>'); return; }
      st.knownIssue = { ...(note ? { note } : {}), ...(ticket ? { ticket } : {}), since: new Date().toISOString().slice(0, 10) };
      await save(tour);
      return decide(f, 'workaround', { ...(note ? { note } : {}), ...(ticket ? { ticket } : {}), knownIssue: true });
    };
  };

  /** "Work around it for now": what the issue looks like and what to do about it, for this story only. */
  const workaroundForm = (el, f, draft = null) => {
    const form = el.querySelector('.finding-form');
    const req = /\b(GET|POST|PUT|PATCH|DELETE) (\S+) (\d{3})/.exec(`${f.detail} ${f.title}`);
    const covered = /covered by <?([^>]+)>?/.exec(f.detail ?? '');
    const d0 = draft ?? (req ? { kind: 'request', value: req[2], status: req[3] } : covered ? { kind: 'element', value: covered[1] } : f.kind === 'workaround' ? { kind: 'same', value: f.id.slice(6) } : { kind: 'element', value: '' });
    form.innerHTML = `<div class="wa-form">
      <p class="muted">For this story only. The run will pass, and say "passed with known issues" until the workaround is removed.</p>
      <label>Name <input class="wa-name" value="${h(draft?.name ?? (f.kind === 'workaround' ? f.id.slice(6) : `known issue: ${f.title}`).slice(0, 80))}"></label>
      ${f.kind === 'workaround' ? `<input type="hidden" class="wa-kind" value="same"><p class="muted">The platform already recognises it as "${h(f.id.slice(6))}"; this marks it as an app issue for this story.</p>` : `
      <label>It shows up as <select class="wa-kind">
        <option value="element" ${d0.kind === 'element' ? 'selected' : ''}>an element on the page (a popup, a panel, a message)</option>
        <option value="request" ${d0.kind === 'request' ? 'selected' : ''}>a failing request</option>
        <option value="console" ${d0.kind === 'console' ? 'selected' : ''}>a console error</option></select></label>
      <label class="k-element">Its CSS, or its role <input class="wa-css" value="${h(d0.kind === 'element' ? d0.value : '')}" placeholder="e.g. .error-panel, or dialog"></label>
      <label class="k-element">Containing the text <input class="wa-text" value="${h(d0.text ?? '')}" placeholder="optional, e.g. TCM"></label>
      <label class="k-request">Request URL contains <input class="wa-req" value="${h(d0.kind === 'request' ? d0.value : '')}" placeholder="/api/tcm/"></label>
      <label class="k-request">Status <input class="wa-status" value="${h(d0.status ?? '5xx')}"></label>
      <label class="k-console">Message contains <input class="wa-console" value="${h(d0.kind === 'console' ? d0.value : '')}"></label>
      <label>What to do <select class="wa-do">
        <option value="tolerate" ${d0.do === 'tolerate' || !d0.do ? 'selected' : ''}>leave it on screen (don't fail because of it)</option>
        <option value="click" ${d0.do === 'click' ? 'selected' : ''}>close it with a button</option>
        <option value="hide" ${d0.do === 'hide' ? 'selected' : ''}>hide it (fakes the app's state)</option></select></label>
      <label class="k-click">The button says <input class="wa-button" value="${h(d0.button ?? 'OK')}"></label>`}
      <label>What the issue is <input class="note" value="${h(draft?.note ?? '')}" placeholder="e.g. the IBR service is down on QA"></label>
      <label>Ticket <input class="ticket" value="${h(draft?.ticket ?? '')}" placeholder="e.g. RMS-1234"></label>
      <button class="primary save">SAVE THE WORKAROUND</button> <button class="cancel">CANCEL</button></div>`;
    const $ = s => form.querySelector(s);
    const sync = () => {
      const k = $('.wa-kind').value, d = $('.wa-do')?.value;
      form.querySelectorAll('.k-element,.k-request,.k-console').forEach(x => (x.hidden = !x.classList.contains(`k-${k}`)));
      form.querySelectorAll('.k-click').forEach(x => (x.hidden = k !== 'element' || d !== 'click'));
      if ($('.wa-do')) [...$('.wa-do').options].forEach(o => (o.disabled = k !== 'element' && o.value !== 'tolerate'));
    };
    form.querySelectorAll('select').forEach(s => (s.onchange = sync)); sync();
    $('.cancel').onclick = () => { form.innerHTML = ''; };
    $('.save').onclick = () => {
      const k = $('.wa-kind').value, name = $('.wa-name').value.trim() || 'known issue';
      const note = $('.note').value.trim(), ticket = $('.ticket').value.trim();
      const issue = { ...(note ? { note } : {}), ...(ticket ? { ticket } : {}), since: new Date().toISOString().slice(0, 10) };
      let w;
      if (k === 'same') w = { name, issue };
      else {
        let when;
        if (k === 'request') when = { request: $('.wa-req').value.trim(), status: /^\d+$/.test($('.wa-status').value.trim()) ? Number($('.wa-status').value.trim()) : $('.wa-status').value.trim() || '5xx' };
        else if (k === 'console') when = { console: $('.wa-console').value.trim() };
        else {
          const v = $('.wa-css').value.trim(), t = $('.wa-text').value.trim();
          when = /^[a-z]+$/.test(v) && !/^(div|span|section|p|a)$/.test(v) ? { role: v } : { css: v };
          if (t) when.hasText = t;
        }
        if (!Object.values(when)[0]) { $('.save').insertAdjacentHTML('afterend', ' <span class="bad">Say what it looks like first.</span>'); return; }
        const doV = $('.wa-do').value;
        w = { name, when, do: doV === 'click' ? [{ click: { role: 'button', name: $('.wa-button').value.trim() || 'OK' } }] : doV, as: 'warn', issue };
      }
      decide(f, 'workaround', { ...(note ? { note } : {}), ...(ticket ? { ticket } : {}) }, w);
    };
  };

  const act = async (f, a, el, b, e) => {
    if (a === 'script') { await decide(f, 'script').catch(() => {}); location.hash = b.getAttribute('href'); e.preventDefault(); return; }
    if (a === 'undo') return decide(f, null);
    if (a === 'accept') return noteForm(el, f, 'accept', { prompt: f.kind === 'workaround' ? 'Why is it expected here?' : 'Why is it good enough?' });
    if (a === 'app-issue') return noteForm(el, f, 'app-issue', { ticket: true, prompt: 'What is wrong in the app?' });
    if (a === 'workaround') return workaroundForm(el, f);
    if (a === 'expect') return expectForm(el, f);
    if (a === 'remove-ki') {
      const tour = await load();
      const st = tour.scenes?.[Number(String(f.scene).slice(6)) - 1]?.steps?.[(f.scriptStep ?? f.step) - 1];
      if (st) delete st.knownIssue;
      if (tour.review?.decisions) tour.review.decisions = tour.review.decisions.filter(x => x.finding !== f.id.replace(/^x(pass|fail)\|/, 'fail|'));
      await save(tour);
      f.decision = { decision: 'accept', note: 'no longer expected to fail' };
      draw();
      box.querySelector('#review-msg').innerHTML = `<div class="saved">The step is a normal check again (${h(file.path)}).</div>`;
      return;
    }
    if (a === 'remove-wa') {
      const name = f.id.replace(/^(issue|gone)\|/, '');
      const tour = await load();
      tour.workarounds = (tour.workarounds ?? []).filter(w => w.name !== name);
      if (!tour.workarounds.length) delete tour.workarounds;
      if (tour.review?.decisions) tour.review.decisions = tour.review.decisions.filter(x => !x.finding.endsWith(`|${name}`));
      await save(tour);
      f.decision = { decision: 'accept', note: 'workaround removed' };
      draw();
      box.querySelector('#review-msg').innerHTML = `<div class="saved">Removed "${h(name)}" from ${h(file.path)}.</div>`;
      return;
    }
    if (a === 'ai') return aiFix(el, f);
    if (a === 'cleanup') return cleanUp(el);
    if (a === 'pin') return pinIt(el, f);
  };

  /** 🧹 Leftover data: `aft cleanup <this run>` runs its pending undo again. */
  const cleanUp = async el => {
    const form = el.querySelector('.finding-form');
    form.innerHTML = '<div class="verdict-line warn">🧹 Cleaning up…</div>';
    const job = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: ['cleanup', `out/${id}`] }) });
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    es.addEventListener('done', ev => {
      es.close();
      const r = JSON.parse(ev.data), c = r.data?.cleaned?.[0];
      form.innerHTML = r.ok ? `<div class="saved">✔ Cleaned up${c ? `: ${c.undone} undone` : ' (nothing was left)'}.</div>`
        : `<div class="bad">✘ Still left behind: ${h(r.error?.message ?? 'the undo failed')}. See ledger.json; fix the cleanup steps, or remove the data by hand.</div>`;
    });
  };

  /** 📌 PIN IT: adds the proposed pin step after the step that created the record, for a person to complete. */
  const pinIt = async (el, f) => {
    const tour = await load();
    const n = Number(String(f.scene).slice(6)), sc = tour.scenes?.[n - 1];
    if (!sc) { el.querySelector('.finding-form').innerHTML = '<div class="bad">That scene is no longer in the script.</div>'; return; }
    const names = new Set((tour.scenes ?? []).flatMap(s => s.steps ?? []).filter(s => s.pin).map(s => s.pin));
    const step = structuredClone(f.proposal.step);
    for (let k = 2; names.has(step.pin); k++) step.pin = `${f.proposal.step.pin}${k}`;
    step.comment = 'Pinned from the review: add "cleanup" (how to delete it), and more fields if later steps need them.';
    sc.steps ??= [];
    sc.steps.splice(Math.min(f.proposal.insertAfter, sc.steps.length), 0, step);
    await save(tour);
    await decide(f, 'script', { note: `pinned as ${step.pin}` });
    const at = Math.min(f.proposal.insertAfter, sc.steps.length - 1) + 1;
    box.querySelector('#review-msg').insertAdjacentHTML('beforeend', `<div class="saved">📌 Added <code>${h(JSON.stringify(step).slice(0, 160))}</code>
      ${file.api === 'pfile' ? `<a class="btn" href="#/write/${encodeURIComponent(file.path)}?scene=${n}&step=${at}">✏️ ADD ITS CLEANUP</a>` : ''}</div>`);
  };

  /** ✨ AI FIX: asks `aft suggest-fix` for a proposal, shows it, and applies it only when accepted. */
  const aiFix = async (el, f) => {
    const form = el.querySelector('.finding-form');
    form.innerHTML = '<div class="verdict-line warn">✨ Asking the AI (Claude) for a fix… it reads this run\'s failure, the page and the script.</div>';
    let job;
    try { job = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: ['suggest-fix', `out/${id}`, '--finding', f.id, '--llm', 'claude'] }) }); }
    catch (e) { form.innerHTML = `<div class="bad">Couldn't ask the AI: ${h(e.message)}</div>`; return; }
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    es.addEventListener('done', ev => {
      es.close();
      const r = JSON.parse(ev.data), s = r.data;
      if (!r.ok || !s) { form.innerHTML = `<div class="bad">Couldn't get a fix: ${h(r.error?.message ?? 'no answer')}</div>`; return; }
      const verdictWord = { script: 'The script looks wrong', app: 'This looks like a real app issue', unsure: 'Not sure' }[s.diagnosis] ?? s.diagnosis;
      form.innerHTML = `<div class="ai-fix">
        <div><b>${h(verdictWord)}.</b> ${h(s.explanation ?? '')}</div>
        ${s.step ? `<div class="diff"><div class="before"><span class="muted">now</span><code>${h(JSON.stringify(s.before))}</code></div>
          <div class="after"><span class="muted">proposed</span><code>${h(JSON.stringify(s.step))}</code></div></div>` : ''}
        ${s.workaround ? `<div class="diff"><div class="after"><span class="muted">proposed workaround (this story only)</span><code>${h(JSON.stringify(s.workaround))}</code></div></div>` : ''}
        <div class="finding-actions">
          ${s.step ? '<button class="primary" data-ai="step">✔ USE THIS STEP</button>' : ''}
          ${s.workaround ? '<button class="primary" data-ai="wa">🩹 USE THIS WORKAROUND</button><button data-ai="edit-wa">EDIT IT FIRST</button>' : ''}
          ${s.diagnosis === 'app' ? '<button data-ai="app">🐞 MARK AS AN APP ISSUE</button>' : ''}
          <button data-ai="discard">DISCARD</button></div></div>`;
      form.querySelectorAll('[data-ai]').forEach(x => (x.onclick = async () => {
        const k = x.dataset.ai;
        if (k === 'discard') { form.innerHTML = ''; return; }
        if (k === 'app') return noteForm(el, f, 'app-issue', { ticket: true, prompt: 'What is wrong in the app?' });
        if (k === 'edit-wa') {
          const w = s.workaround, when = w.when ?? {};
          return workaroundForm(el, f, { name: w.name, kind: when.request ? 'request' : when.console ? 'console' : 'element', value: when.request ?? when.console ?? when.css ?? when.role ?? '',
            text: when.hasText ?? '', status: when.status, do: Array.isArray(w.do) ? 'click' : w.do, button: Array.isArray(w.do) ? w.do[0]?.click?.name : undefined, note: w.issue?.note ?? s.explanation });
        }
        if (k === 'wa') {
          const w = { ...s.workaround, as: s.workaround.as ?? 'warn', issue: { note: s.workaround.issue?.note ?? s.explanation ?? '', since: new Date().toISOString().slice(0, 10) } };
          return decide(f, 'workaround', { note: w.issue.note, by: 'ai' }, w);
        }
        if (k === 'step') {
          const tour = await load();
          const sc = tour.scenes?.[s.scene - 1];
          if (!sc?.steps?.[s.index - 1]) { form.insertAdjacentHTML('beforeend', '<div class="bad">That step is no longer in the script (it changed since the run).</div>'); return; }
          sc.steps[s.index - 1] = s.step;
          await save(tour);
          return decide(f, 'script', { note: `AI fix: ${s.explanation ?? ''}`.slice(0, 200), by: 'ai' });
        }
      }));
    });
  };

  draw();
}
