// The process behind `aft session start`: holds one Session (src/session.mjs) open and serves commands on a local
// HTTP port. Started detached by the CLI with AFT_SESSION={ toolRoot, name, args, outDir, stateFile }; writes its
// state file when ready (or failed) and removes it when it stops. Logs go to <outDir>/session.log.
//
// POST / (header x-aft-token) { "op": "status" | "snapshot" | "locate" | "try-step" | "stop", ... } → JSON.
// Commands run one at a time (one page): a second command while one is running is refused with HTTP 409 (busy), so
// two callers can't interleave steps on the same page; status always answers, and a stop waits for the command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { classify } from './failures.mjs';
import { Session } from './session.mjs';
import { log } from './util.mjs';

const { toolRoot, name, args, outDir, stateFile } = JSON.parse(process.env.AFT_SESSION);
const token = crypto.randomBytes(24).toString('hex');
const writeState = s => { const tmp = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, stateFile); };
const base = { schema: 'aft-session/1', name, pid: process.pid, outDir, log: `${outDir}/session.log` };

let session, server, queue = Promise.resolve(), stopping = false, running = null;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const result = await session?.stop().catch(e => ({ error: e.message }));
  fs.rmSync(stateFile, { force: true });
  log(`stopped: ${JSON.stringify(result)}`);
  server?.close();
  setTimeout(() => process.exit(code), 200);
  return result;
}

async function main() {
  // The CLI resolved the app (platform, environment, role) and passed it as data; functions are rebuilt here.
  const { appSettingsFor } = await import('./cli-app.mjs');
  const appCfg = appSettingsFor(toolRoot, args, { allowBareUrl: true });
  session = new Session({ app: appCfg, outDir, headed: !!args.headed, log, options: { freshLogin: args.freshLogin, env: args.target ?? args.env } });
  writeState({ ...base, status: 'starting', startedAt: new Date().toISOString() });
  const status = await session.start();
  server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.headers['x-aft-token'] !== token) return send(403, { error: 'forbidden' });
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
      if (msg.op === 'status') return send(200, { ...base, status: 'ready', ...session.status(), ...(running ? { busy: running } : {}) });
      if (running && msg.op !== 'stop')
        return send(409, { error: `session ${name} is busy: a "${running}" call is still running (one call at a time on a session's page); wait for it, or start another session with --session <name>`, class: 'error' });
      if (msg.op !== 'stop') running = msg.op;
      queue = queue.then(async () => {
        try {
          switch (msg.op) {
            case 'status': return send(200, { ...base, status: 'ready', ...session.status() });
            case 'snapshot': return send(200, await session.snapshot(msg));
            case 'locate': return send(200, await session.locate(msg.target, msg));
            case 'try-step': return send(200, await session.tryStep(msg.step, msg));
            case 'stop': return send(200, { ...base, ...(await shutdown()) });
            default: return send(400, { error: `unknown op ${msg.op}` });
          }
        } catch (e) {
          log(`${msg.op} failed: ${e.stack ?? e}`);
          send(500, { error: e.message.split('\n')[0], class: e.failure ?? classify(e) });
        } finally {
          if (msg.op !== 'stop') running = null;
        }
      });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  writeState({ ...base, status: 'ready', port: server.address().port, token, ...status });
  log(`ready on 127.0.0.1:${server.address().port}`);
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
main().catch(e => {
  log(`failed to start: ${e.stack ?? e}`);
  writeState({ ...base, status: 'failed', error: e.message.split('\n')[0], class: e.failure ?? classify(e) });
  session?.stop().finally(() => process.exit(1));
});
