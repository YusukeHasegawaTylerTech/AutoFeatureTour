// A tiny app that fails on demand, for the error-reporting tests. Every route is deterministic.
//   /ok         heading, a "Name" field, a Save button that shows "Saved"
//   /dup        two Save buttons (ambiguous target)
//   /overlay    a Save button under a full-page overlay (blocked action)
//   /pinned     a long page with a fixed footer over its last button, a CSS-uppercased "Paused", a random #code
//   /disabled   a disabled Save button
//   /xhr500     Save calls /api/fail (HTTP 500) and shows an error toast
//   /pageerror  Save throws an uncaught exception
//   /busy       a spinner that never goes away (page never settles)
//   /hang       never responds (navigation timeout)
//   /login      form: #user, #pass, "Sign in"; password "hunter2-fixture" sets a session cookie and goes to /secure
//   /secure     "Welcome" + #signed-in when the cookie is set, else redirects to /login
//   /api/fail   500 with a JSON body that includes a token (to test redaction)
//   /vocab      one control per step type: rows (scoping), a checkbox, a select, a frame, a popup link, a download,
//               confirm/prompt dialogs, a file input, a drag source and target, a key counter, a toggled panel,
//               buttons that call /api/echo (200) and /api/fail (500); /frame is the iframe's page
//   /api/echo   200 {"ok": true}       /file.txt   a download (Content-Disposition: attachment; report-2026.txt)
//   /known      known issues for workarounds: ?popup=1 (&stack=1), ?panel=1 (&two=1), ?tcm=1 (Save calls /api/tcm: 503)
//   /tabs       tabs with aria-selected, and a count of page loads (sessionStorage)

import http from 'node:http';

const page = (title, body, script = '') => `<!doctype html><html><head><title>${title}</title>
<style>body{font:16px sans-serif;margin:40px} .overlay{position:fixed;inset:0;background:rgba(0,0,0,.4)} .toast{color:#b00} .spinner{width:20px;height:20px;border:3px solid #999}</style>
</head><body>${body}<script>${script}</script></body></html>`;

const PAGES = {
  '/ok': page('OK', `<h1>Fixture</h1><label>Name <input id="name"></label> <button id="save">Save</button><p id="out"></p>`,
    `save.onclick = () => { out.textContent = 'Saved ' + document.getElementById('name').value; };`),
  '/dup': page('Dup', `<h1>Two buttons</h1><button>Save</button> <button>Save</button>`),
  '/overlay': page('Overlay', `<h1>Covered</h1><button>Save</button><div class="overlay"></div>`),
  // A fixed footer over the bottom of a long page, a label shown in capitals by CSS, and a code made up per load.
  '/pinned': page('Pinned', `<h1>Pinned footer</h1><p id="status" style="text-transform:uppercase">Paused</p>
<p>Code <strong id="code"></strong></p><a id="link" href="/item/42">Item</a> <label>Code to enter <input id="entry"></label><p id="clicked"></p>
<div style="height:calc(100vh - 330px)"></div><button id="low">Low button</button><div style="height:1200px"></div>
<div class="bar" style="position:fixed;left:0;right:0;bottom:0;height:140px;background:#ddd">Toolbar</div>`,
    `code.textContent = 'C' + Math.random().toString(36).slice(2, 8).toUpperCase(); low.onclick = () => { clicked.textContent = 'low clicked'; };`),
  '/disabled': page('Disabled', `<h1>Disabled</h1><button disabled>Save</button>`),
  '/xhr500': page('XHR', `<h1>Server error</h1><button id="save">Save</button><div id="toast"></div>`,
    `save.onclick = async () => { const r = await fetch('/api/fail?access_token=abc123secret'); if (!r.ok) { toast.className = 'toast'; toast.textContent = 'Error: something went wrong'; console.error('save failed with ' + r.status); } };`),
  '/pageerror': page('Throws', `<h1>Throws</h1><button id="save">Save</button>`,
    `save.onclick = () => { setTimeout(() => { throw new Error('fixture exploded'); }); };`),
  '/busy': page('Busy', `<h1>Loading forever</h1><div class="spinner"></div>`),
  '/vocab': page('Vocab', `<h1>Vocabulary</h1>
    <table><tr><td>Alpha</td><td><button>Edit</button></td></tr><tr class="row"><td>Beta</td><td><button>Edit</button></td></tr></table>
    <section aria-label="Panel A"><button>Open</button></section><section aria-label="Panel B"><button>Open</button></section>
    <p id="which"></p>
    <label><input type="checkbox" id="agree"> I agree</label>
    <label>Color <select id="color"><option>Red</option><option>Green</option></select></label>
    <label>Notes <input id="notes" value="prefilled"></label>
    <label>Keys <input id="keys"></label><span id="keycount">0</span>
    <button id="ask" onclick="document.getElementById('asked').textContent = confirm('Delete it?') ? 'confirmed' : 'cancelled'">Delete</button><span id="asked"></span>
    <button id="prompt" onclick="document.getElementById('answer').textContent = prompt('Your name?') ?? 'none'">Ask name</button><span id="answer"></span>
    <label>Attachment <input type="file" id="file"></label><span id="filename"></span>
    <a href="/ok" target="_blank">Open in new tab</a> <a href="/file.txt" download>Download report</a>
    <div id="src" style="width:60px;height:30px;background:#9cf">Card</div><div id="dst" style="width:120px;height:60px;border:2px dashed #999;margin-top:10px">Drop here</div><span id="dropped"></span>
    <button id="toggle" onclick="document.getElementById('panel').hidden = !document.getElementById('panel').hidden">Toggle</button><div id="panel">Details panel</div>
    <button id="good" onclick="fetch('/api/echo').then(r => document.getElementById('net').textContent = 'echo ' + r.status)">Load</button>
    <button id="bad" onclick="fetch('/api/fail').then(r => document.getElementById('net').textContent = 'fail ' + r.status)">Break</button><span id="net"></span>
    <button disabled>Locked</button>
    <iframe src="/frame" title="embedded" style="height:60px"></iframe>`,
    `document.querySelectorAll('section button').forEach(b => b.onclick = () => { which.textContent = 'opened ' + b.parentElement.getAttribute('aria-label'); });
    keys.addEventListener('keydown', () => { keycount.textContent = String(+keycount.textContent + 1); });
    file.onchange = () => { filename.textContent = file.files[0]?.name ?? ''; };
    let dragging = false;
    src.addEventListener('mousedown', () => { dragging = true; });
    document.addEventListener('mouseup', e => { if (!dragging) return; dragging = false; const r = dst.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) dropped.textContent = 'dropped Card'; });`),
  // Known issues (workarounds): a modal popup shortly after load (?stack=1: a second one on top), an inline error panel
  // (?two=1: two of them), a Save that calls /api/tcm (503), tabs with aria-selected, and a counter of page loads.
  '/known': page('Known', `<h1>Known issues</h1><button id="save">Save</button><p id="out"></p><div id="slot"></div>`,
    `const q = new URLSearchParams(location.search);
    save.onclick = () => { out.textContent = 'Saved'; };
    const dialog = (id, text) => { const d = document.createElement('div'); d.id = id; d.setAttribute('role', 'dialog');
      d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);color:#fff;padding:80px';
      d.innerHTML = '<p>' + text + '</p><div class="actions"><button>Ok</button></div>'; d.querySelector('button').onclick = () => d.remove(); document.body.appendChild(d); };
    if (q.get('popup')) setTimeout(() => { dialog('d1', 'TCM service unavailable'); if (q.get('stack')) dialog('d2', 'A File Storage error has occurred'); }, 300);
    if (q.get('panel')) { slot.innerHTML = '<div class="error-panel">Edit check service unavailable (TCM error)</div>' + (q.get('two') ? '<div class="error-panel">Another error</div>' : ''); }
    if (q.get('tcm')) save.onclick = async () => { const r = await fetch('/api/tcm'); out.textContent = 'tcm ' + r.status; };`),
  '/tabs': page('Tabs', `<div role="tablist"><button role="tab" id="t1" aria-selected="true">Review</button><button role="tab" id="t2" aria-selected="false">IBR</button></div>
    <p id="loads"></p>`,
    `for (const t of document.querySelectorAll('[role=tab]')) t.onclick = () => { for (const x of document.querySelectorAll('[role=tab]')) x.setAttribute('aria-selected', String(x === t)); };
    sessionStorage.loads = String(+(sessionStorage.loads ?? 0) + 1); loads.textContent = 'loads ' + sessionStorage.loads;`),
  '/frame': page('Frame', `<button onclick="this.textContent = 'Clicked inside'">Inside</button>`),
  '/login': page('Login', `<h1>Sign in</h1><form method="post" action="/login"><label>User <input id="user" name="user"></label>
    <label>Password <input id="pass" name="pass" type="password"></label><button>Sign in</button></form><p id="error">__ERROR__</p>`),
};

export function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const authed = /session=ok/.test(req.headers.cookie ?? '');
    if (url.pathname === '/hang') return; // never answers
    if (url.pathname === '/api/fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'boom', token: 'tok-should-not-leak' }));
    }
    if (url.pathname === '/api/tcm') { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('TCM is down for maintenance'); }
    if (url.pathname === '/api/echo') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (url.pathname === '/file.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report-2026.txt"' });
      return res.end('synthetic report');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const ok = new URLSearchParams(body).get('pass') === 'hunter2-fixture';
        if (ok) { res.writeHead(302, { 'Set-Cookie': 'session=ok; Path=/', Location: '/secure' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGES['/login'].replace('__ERROR__', 'Invalid user or password'));
      });
      return;
    }
    if (url.pathname === '/secure') {
      if (!authed) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page('Secure', `<h1>Welcome</h1><p id="signed-in">signed in</p><button>Save</button>`));
    }
    const html = PAGES[url.pathname === '/' ? '/ok' : url.pathname];
    if (!html) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html.replace('__ERROR__', ''));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, close: () => { server.closeAllConnections?.(); server.close(); } });
  }));
}
