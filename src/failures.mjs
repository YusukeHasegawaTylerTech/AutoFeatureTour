// Failure classes: one table drives the exit code, the one-line console summary, and the report's "why" and "look
// next" lines, so every failure mode is reported the same way. Classification is by rule, never by judgment.

export const SCHEMA_REPORT = 'aft-report/1';

export const CLASSES = {
  ok:          { exit: 0,   label: 'PASSED' },
  error:       { exit: 1,   label: 'ERROR', why: 'an unexpected error in the tool or its configuration',
                 next: 'the message above; report.json "error"; run.json for the command and arguments' },
  script:      { exit: 2,   label: 'SCRIPT', why: 'an action step could not be performed (its target was not found, was blocked, disabled or detached)',
                 next: 'the "did you mean" matches and triage/page/aria.yml for the names on the page; fix the step (aft locate / try-step), then re-run' },
  unreachable: { exit: 3,   label: 'UNREACHABLE', why: 'nothing answered at the app URL',
                 next: 'is the app running? check --base-url / BASE_URL / --target, and the launch logs (*.log) in the run folder' },
  criterion:   { exit: 4,   label: 'CRITERION', why: 'a verify step ran and its check failed: the page did not show what the step expected',
                 next: 'triage/screenshot.png and page/text.txt (what was shown); if the check itself is wrong, fix it; otherwise report it as a blocker with the bundle' },
  app:         { exit: 5,   label: 'APP', why: 'during the step the app showed its error UI, returned an HTTP error, threw an uncaught exception, or a page did not finish loading',
                 next: 'the first cause below and triage/network.json / console.json for that step; report it as a blocker with the bundle' },
  login:       { exit: 6,   label: 'LOGIN', why: 'signing in did not reach a signed-in page',
                 next: 'triage/login-failure.png; credentials env vars; aft login <tour> (or --manual for SSO)' },
  tooling:     { exit: 7,   label: 'TOOLING', why: 'a local tool failed (ffmpeg, the speech voice, the browser, or the disk)',
                 next: 'aft doctor; the message above; free disk space and folder permissions' },
  interrupted: { exit: 130, label: 'INTERRUPTED', why: 'the run was stopped (Ctrl+C or a kill signal) before it finished',
                 next: 'the partial report and trace; run again' },
};

/** A failure with a known class. entry: the step report entry, when a step failed. */
export class Failure extends Error {
  constructor(failure, message, extra = {}) { super(message); this.failure = failure; Object.assign(this, extra); }
}

/** The class of any error, by rule. */
export function classify(e) {
  if (!e) return 'ok';
  if (e.failure && CLASSES[e.failure]) return e.failure;
  const m = String(e.message ?? e);
  if (/net::ERR_(CONNECTION|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|TIMED_OUT|UNSAFE_PORT|CONNECTION_RESET)|didn't come up|Can't reach/.test(m)) return 'unreachable';
  if (/Target (page, context or browser )?(has been )?closed|Browser closed|browser has disconnected|crashed/i.test(m)) return 'tooling';
  if (/ENOSPC|EACCES|EPERM|EROFS|EMFILE/.test(m) || /\b(ffmpeg|ffprobe|powershell\.exe|tts-sapi|SAPI|speech provider)\b/i.test(m)) return 'tooling';
  if (/Executable doesn't exist|browserType\.launch/i.test(m)) return 'tooling';
  return 'error';
}

export const exitCode = e => CLASSES[classify(e)]?.exit ?? 1;

/** One line for the console: "SCRIPT: scene-02 step 3 click "Save": Target not found ..." */
export function summaryLine(e) {
  const c = classify(e);
  return `${CLASSES[c].label}: ${String(e?.message ?? e).split('\n')[0].replace(new RegExp(`^${CLASSES[c].label}( failure| error)?:\\s*`), '')}`;
}
