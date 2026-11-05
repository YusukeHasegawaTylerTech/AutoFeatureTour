// The GENERATE panel as a chat (aft generate --converse / aft converse): the agent explores the live app on a stage,
// asks; the person answers with buttons or words, records steps by hand, refines; ✔ USE THESE SCENES finishes it
// (validates the draft) and puts the scenes into the editor. The conversation lives in its run folder
// (conversation.json), so closing the panel keeps it; reopening the script offers to continue (localStorage).

const BADGE = { planned: '⚪ planned', explored: '🔎 explored', recorded: '⏺ recorded', verified: '✅ verified' };
const WHO = { agent: '🤖', person: '🙂', tool: '🔧' };

export function conversation({ h, api, runJob, platform, tourPath, onUse, redraw }) {
  const key = `aft-conv:${tourPath}`;
  const S = { runDir: localStorage.getItem(key) || null, conv: null, view: null, busy: null, error: null, recorded: [], job: null, poll: null };

  const load = async () => {
    if (!S.runDir) return;
    try { S.conv = await api(`/api/conversation?run=${encodeURIComponent(S.runDir)}`); }
    catch { S.runDir = null; S.conv = null; localStorage.removeItem(key); }
  };

  /** One `aft generate --converse` / `aft converse` job; the view comes back as its data. */
  const run = (args, what) => new Promise(ok => {
    S.busy = what; S.error = null; redraw();
    runJob(args, {
      onLine: l => { const el = document.querySelector('#conv-last'); if (el) el.textContent = l.replace(/^agent: /, '🤖 ').slice(0, 160); },
      onDone: async r => {
        S.busy = null; S.job = null;
        if (r.runDir && !S.runDir) { S.runDir = r.runDir; localStorage.setItem(key, r.runDir); }
        if (!r.ok) S.error = r.error?.message ?? 'It stopped with an error.';
        S.view = r.data ?? S.view;
        await load();
        // Recording, however it started (⏺ RECORD, or answering a record-this question): show the steps as they come.
        if (S.conv?.state === 'recording') startPoll(); else stopPoll();
        redraw();
        ok(r);
      } }).then(j => (S.job = j));
  });

  const start = (story, { oneGo = false } = {}) => (oneGo ? null
    : run(['generate', '--story', story, '--platform', platform, '--llm', 'claude', '--converse'], 'Looking at the app and the story'));
  const say = text => run(['converse', S.runDir, '--say', text], 'Thinking');
  const answer = (id, value) => run(['converse', S.runDir, '--answer', `${id}=${value}`], 'Thinking');
  const record = n => run(['converse', S.runDir, '--record', String(n)], `Getting the app ready for scene ${n}`);
  const stop = () => { stopPoll(); return run(['converse', S.runDir, '--stop'], 'Writing the narration for what you did'); };
  const finish = async () => {
    const r = await run(['converse', S.runDir, '--finish'], 'Checking every step (validate)');
    if (r.ok && r.data?.finished) {
      const made = JSON.parse((await api(`/api/tour?path=${encodeURIComponent(r.data.tour)}`)).text);
      onUse(made);
    }
  };
  const proposal = (id, accept) => run(['converse', S.runDir, accept ? '--accept' : '--reject', id], accept ? 'Applying it' : 'Dropping it');
  const end = () => run(['converse', S.runDir, '--end'], 'Ending (undoing what it created)').then(() => { localStorage.removeItem(key); S.runDir = null; S.conv = null; redraw(); });

  // While recording: the steps so far, every 2 s (record-steps answers while the browser is in use).
  const startPoll = () => {
    if (S.poll) return;
    S.recorded = [];
    if (S.conv?.state !== 'recording') return;
    let pending = false;   // one poll at a time (each is a CLI job)
    const tick = () => {
      if (pending) return;
      pending = true;
      runJob(['converse', S.runDir, '--steps'], { onDone: r => { pending = false; if (r.ok) S.recorded = r.data?.recorded ?? S.recorded; const el = document.querySelector('#conv-rec'); if (el) el.innerHTML = recList(); } });
    };
    S.poll = setInterval(tick, 2000);
    tick();
  };
  const stopPoll = () => { clearInterval(S.poll); S.poll = null; };
  const dropLast = () => runJob(['converse', S.runDir, '--steps', '--drop-last'], { onDone: r => { S.recorded = r.data?.recorded ?? []; const el = document.querySelector('#conv-rec'); if (el) el.innerHTML = recList(); } });
  const recList = () => (S.recorded.length ? `<ol>${S.recorded.map(s => `<li><code>${h(JSON.stringify(s.step))}</code>${s.weak ? ' <span class="warn-text">weak target</span>' : ''}</li>`).join('')}</ol>` : '<p class="hint">Nothing yet: click and type in the browser window.</p>');

  const turnHtml = t => {
    if (t.who === 'tool' && t.probes) return `<details class="conv-probe"><summary>🔎 ${h(t.text)}</summary>
      ${t.probes.map(p => `<div><b>${h(p.kind)}</b> ${p.ok === false ? `<span class="bad-text">✘ ${h(p.error ?? '')}</span>` : '✔'} ${h(p.url ?? p.after?.url ?? '')}
        ${p.steps ? `<small>${h(p.steps.map(s => `${s.action}${s.ok ? '' : ' ✘'}`).join(' · '))}</small>` : ''}</div>`).join('')}</details>`;
    const qs = (t.questions ?? []).map(id => S.conv.questions.find(q => q.id === id)).filter(Boolean);
    return `<div class="conv-turn ${t.who}"><span class="who">${WHO[t.who] ?? ''}</span><div>${h(t.text || (t.answers ? Object.entries(t.answers).map(([k, v]) => `${k}: ${v}`).join(', ') : ''))}
      ${qs.map(questionHtml).join('')}</div></div>`;
  };
  const questionHtml = q => `<div class="conv-q ${q.open ? 'open' : 'done'}" data-q="${h(q.id)}"><b>${h(q.text)}</b>
      ${q.evidence ? `<details><summary>what it saw</summary><pre>${h(q.evidence)}</pre></details>` : ''}
      ${q.open ? `<div class="actions tight">${(q.options ?? []).map(o => `<button class="chunky small c-blue" data-answer="${h(q.id)}" data-value="${h(o.value)}">${h(o.label ?? o.value)}</button>`).join('')}
        ${q.type === 'record-this' && !(q.options ?? []).length ? `<button class="chunky small c-red" data-answer="${h(q.id)}" data-value="record">⏺ I'LL DO IT</button>` : ''}
        <input class="mid-input" data-free="${h(q.id)}" placeholder="or type an answer"> <button class="chunky small c-gray" data-freego="${h(q.id)}">SEND</button></div>`
        : `<div class="hint">→ ${h(q.answer ?? '')}</div>`}</div>`;

  const html = () => {
    const c = S.conv;
    if (!c && !S.busy) return '';
    const scenes = c?.scenes ?? [];
    const proposals = (c?.proposals ?? []).filter(p => p.status === 'proposed');
    const recording = c?.state === 'recording';
    return `<div class="conv">
      <div class="conv-log">${(c?.turns ?? []).map(turnHtml).join('')}</div>
      ${S.busy ? `<div class="verdict wait">⏳ ${h(S.busy)}…<small id="conv-last"></small></div>` : ''}
      ${S.error ? `<div class="verdict bad">✘ ${h(S.error)}</div>` : ''}
      ${proposals.map(p => `<div class="conv-q open"><b>Suggested ${p.kind === 'workaround' ? 'workaround' : 'review decision'}:</b> ${h(p.why)}
        <pre>${h(JSON.stringify(p.workaround ?? p.decision, null, 1))}</pre>
        <div class="actions tight"><button class="chunky small c-green" data-prop="${h(p.id)}" data-accept="1">✔ APPLY</button><button class="chunky small c-gray" data-prop="${h(p.id)}">✕ NO</button></div></div>`).join('')}
      ${recording ? `<div class="conv-recording"><b>⏺ Recording scene ${c.recording.scene}</b>: do it in the browser window (↗ Open brings it to the front).
          <div id="conv-rec">${recList()}</div>
          <div class="actions tight"><button class="chunky small c-gray" id="conv-drop">↶ DROP LAST</button><button class="chunky small c-red" id="conv-stop">⏹ STOP</button>
            <button class="chunky small c-gray" id="conv-open">↗ OPEN</button></div></div>` : ''}
      ${scenes.length ? `<div class="conv-scenes">${scenes.map((s, i) => `<div class="conv-scene"><span>${i + 1}. ${h(s.title || 'Scene')}</span>
          <span class="badge">${BADGE[s.state] ?? h(s.state)}</span> <span class="hint">${(s.steps ?? []).length} step(s)${s.todo ? ` · ${h(s.todo.slice(0, 80))}` : ''}</span>
          ${!recording && !S.busy ? `<button class="chunky small c-gray" data-rec="${i + 1}" title="Do this scene by hand in the live browser; the agent writes the narration">⏺ RECORD</button>` : ''}</div>`).join('')}</div>` : ''}
      ${c && !recording ? `<div class="conv-say"><textarea id="conv-text" rows="2" placeholder="Tell it what to change: &quot;scene 3 is too long&quot;, &quot;use the Approve button&quot;, &quot;check the total is 42&quot;"></textarea>
        <div class="actions tight"><button class="chunky small c-blue" id="conv-send" ${S.busy ? 'disabled' : ''}>SEND</button>
          <button class="chunky small c-green" id="conv-use" ${S.busy ? 'disabled' : ''} title="Check every step, then put the scenes into the editor">✔ USE THESE SCENES</button>
          <button class="chunky small c-gray" id="conv-open">↗ OPEN THE BROWSER</button>
          <button class="chunky small c-gray" id="conv-end" ${S.busy ? 'disabled' : ''} title="Stop the conversation and undo what it created">END</button></div></div>` : ''}
    </div>`;
  };

  const wire = root => {
    const $ = s => root.querySelector(s);
    root.querySelectorAll('[data-answer]').forEach(b => (b.onclick = () => answer(b.dataset.answer, b.dataset.value)));
    root.querySelectorAll('[data-freego]').forEach(b => (b.onclick = () => { const v = root.querySelector(`[data-free="${b.dataset.freego}"]`)?.value.trim(); if (v) answer(b.dataset.freego, v); }));
    root.querySelectorAll('[data-prop]').forEach(b => (b.onclick = () => proposal(b.dataset.prop, !!b.dataset.accept)));
    root.querySelectorAll('[data-rec]').forEach(b => (b.onclick = () => record(Number(b.dataset.rec))));
    if ($('#conv-send')) $('#conv-send').onclick = () => { const v = $('#conv-text').value.trim(); if (v) say(v); };
    if ($('#conv-use')) $('#conv-use').onclick = finish;
    if ($('#conv-end')) $('#conv-end').onclick = end;
    if ($('#conv-stop')) $('#conv-stop').onclick = stop;
    if ($('#conv-drop')) $('#conv-drop').onclick = dropLast;
    root.querySelectorAll('#conv-open').forEach(b => (b.onclick = () => S.conv?.stageName && fetch('/api/stage-open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: S.conv.stageName }) })));
    const log = $('.conv-log');
    if (log) log.scrollTop = log.scrollHeight;
  };

  return {
    get active() { return !!(S.conv || S.busy); },
    get resumable() { return !!S.runDir && !S.conv; },
    get finished() { return !!S.conv?.finished; },
    load: async () => { await load(); if (S.conv?.finished) { localStorage.removeItem(key); S.runDir = null; S.conv = null; } if (S.conv?.state === 'recording') startPoll(); },
    start, html, wire,
    close: () => { stopPoll(); S.job?.close(); },
  };
}
