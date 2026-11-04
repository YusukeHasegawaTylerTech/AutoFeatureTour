// RMS (local dev) requirements for `aft doctor` (advisory; strict with `aft doctor --target rms`).
import fs from 'node:fs';
import path from 'node:path';
import { probe } from '../../src/recorder.mjs';

export default async function requirements({ add, which, run }) {
  const scripts = process.env.AFT_RMS_DEV_SCRIPTS ?? 'C:\\TylerDev\\nwps-rms-dev-scripts';
  add('nwps-rms-dev-scripts', fs.existsSync(path.join(scripts, 'StartRmsApi.local.ps1')), scripts, 'clone it, or set AFT_RMS_DEV_SCRIPTS');
  const records = path.join(scripts, '..', 'nwps-rms-records');
  add('nwps-rms-records (sibling)', fs.existsSync(path.join(records, 'Web')), records, 'clone it next to nwps-rms-dev-scripts');
  const docker = which('docker') ? await run('docker', ['ps', '--format', '{{.Names}}'], { capture: true }).catch(() => null) : null;
  add('Docker running (dev containers)', docker !== null, docker === null ? 'docker not reachable' : `${docker.split(/\r?\n/).filter(Boolean).length} container(s) up`,
    'start Docker Desktop and the dev-docker containers');
  add('credentials AFT_RMS_USERNAME / AFT_RMS_PASSWORD', process.env.AFT_RMS_USERNAME && process.env.AFT_RMS_PASSWORD,
    process.env.AFT_RMS_USERNAME ? `user ${process.env.AFT_RMS_USERNAME}` : 'not set',
    'set them in your environment or a .env file (local dev default: dev / 1), or run aft login targets/rms/rms.tour.json --manual', false);
  add('RMS API (https://localhost:6600)', await probe('https://localhost:6600/', { any: true }), 'running?',
    'not required: the tour starts it (StartRmsApi.local.ps1, in its own window) if needed', false);
  add('RMS Web UI (http://localhost:4200)', await probe('http://localhost:4200/'), 'running?',
    'not required: the tour starts it (StartWebUi.local.ps1, in its own window) if needed', false);
}
