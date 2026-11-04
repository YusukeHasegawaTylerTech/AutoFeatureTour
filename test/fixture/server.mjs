// A tiny app that fails on demand, for the error-reporting tests. Every route is deterministic.
//   /ok         heading, a "Name" field, a Save button that shows "Saved"
//   /dup        two Save buttons (ambiguous target)
//   /overlay    a Save button under a full-page overlay (blocked action)
//   /disabled   a disabled Save button
//   /xhr500     Save calls /api/fail (HTTP 500) and shows an error toast
//   /pageerror  Save throws an uncaught exception
//   /busy       a spinner that never goes away (page never settles)
//   /hang       never responds (navigation timeout)
//   /login      form: #user, #pass, "Sign in"; password "hunter2-fixture" sets a session cookie and goes to /secure
//   /secure     "Welcome" + #signed-in when the cookie is set, else redirects to /login
//   /api/fail   500 with a JSON body that includes a token (to test redaction)

import http from 'node:http';

const page = (title, body, script = '') => `<!doctype html><html><head><title>${title}</title>
<style>body{font:16px sans-serif;margin:40px} .overlay{position:fixed;inset:0;background:rgba(0,0,0,.4)} .toast{color:#b00} .spinner{width:20px;height:20px;border:3px solid #999}</style>
</head><body>${body}<script>${script}</script></body></html>`;

const PAGES = {
  '/ok': page('OK', `<h1>Fixture</h1><label>Name <input id="name"></label> <button id="save">Save</button><p id="out"></p>`,
    `save.onclick = () => { out.textContent = 'Saved ' + document.getElementById('name').value; };`),
  '/dup': page('Dup', `<h1>Two buttons</h1><button>Save</button> <button>Save</button>`),
  '/overlay': page('Overlay', `<h1>Covered</h1><button>Save</button><div class="overlay"></div>`),
  '/disabled': page('Disabled', `<h1>Disabled</h1><button disabled>Save</button>`),
  '/xhr500': page('XHR', `<h1>Server error</h1><button id="save">Save</button><div id="toast"></div>`,
    `save.onclick = async () => { const r = await fetch('/api/fail?access_token=abc123secret'); if (!r.ok) { toast.className = 'toast'; toast.textContent = 'Error: something went wrong'; console.error('save failed with ' + r.status); } };`),
  '/pageerror': page('Throws', `<h1>Throws</h1><button id="save">Save</button>`,
    `save.onclick = () => { setTimeout(() => { throw new Error('fixture exploded'); }); };`),
  '/busy': page('Busy', `<h1>Loading forever</h1><div class="spinner"></div>`),
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
