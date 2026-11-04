// The source of the published JSON Schemas (draft 2020-12) in schemas/*.schema.json. Steps and locators are shared
// definitions. `node src/schema-defs.mjs --write` regenerates the files (a test fails if they're out of date); the
// loader, `aft validate` and `aft schema` all use the generated files, so editors, agents and the engine check the
// same format.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 'v1';
const BASE = `https://autofeaturetour.local/schemas/${SCHEMA_VERSION}`;
const D = '2020-12';

// ---- Building blocks -----------------------------------------------------------------------------------------------

const str = description => ({ type: 'string', description });
const bool = description => ({ type: 'boolean', description });
/** A number, or a "{args.x}" / "{data.x}" placeholder that becomes one. */
const num = (description, extra = {}) => ({ description, anyOf: [{ type: 'number', ...extra }, { $ref: 'common.schema.json#/$defs/placeholder' }] });
const obj = (description, properties, extra = {}) => ({ type: 'object', description, properties, additionalProperties: false, ...extra });
const ref = name => ({ $ref: `common.schema.json#/$defs/${name}` });
const loc = description => ({ ...ref('locator'), description });

const LOCATOR_KEYS = ['role', 'label', 'placeholder', 'text', 'testId', 'css', 'alt'];

const locatorObject = {
  type: 'object',
  description: 'An element by what users see. Exactly one of role, label, placeholder, text, testId, alt or css; optionally narrowed (has, hasText, nth) and scoped (within, frame).',
  properties: {
    role: str('ARIA role: button, link, textbox, checkbox, tab, menuitem, combobox, heading, row, cell, dialog…'),
    name: str('Accessible name, with "role". Substring match unless "exact".'),
    exact: bool('Match name/label/placeholder/text exactly (default false: substring, case-insensitive).'),
    label: str('A form field by its <label> or aria-label.'),
    placeholder: str('A field by its placeholder text.'),
    text: str('An element by its visible text.'),
    testId: str('data-testid attribute.'),
    alt: str('An image by its alt text.'),
    css: str('A CSS selector. Last resort: it breaks when markup changes and means nothing to a viewer.'),
    nth: num('Pick the n-th match (0-based) instead of the first visible one; also silences the ambiguity warning.', { minimum: 0 }),
    has: { $ref: '#/$defs/locator', description: 'Only elements that contain an element matching this locator.' },
    hasNot: { $ref: '#/$defs/locator', description: 'Only elements that do not contain an element matching this locator.' },
    hasText: str('Only elements whose text contains this (anywhere inside them).'),
    hasNotText: str('Only elements whose text does not contain this.'),
    within: { $ref: '#/$defs/locator', description: 'Search inside the first visible element matching this locator (a dialog, a row, a panel). Nest for chains.' },
    frame: { description: 'Search inside an iframe: its CSS selector, or a list of selectors for nested frames (outermost first).',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
  },
  additionalProperties: false,
  oneOf: LOCATOR_KEYS.map(k => ({ required: [k] })),
};

const common = {
  $schema: `https://json-schema.org/draft/${D}/schema`,
  $id: `${BASE}/common.schema.json`,
  title: 'AutoFeatureTour shared definitions: locators and steps',
  $defs: {
    placeholder: { type: 'string', pattern: '^\\{(args|data|env:)[A-Za-z0-9_.:-]*\\}$', description: 'A placeholder filled in when the tour loads: {args.x} (fragment parameter), {data.x} (fixture data) or {env:NAME}.' },
    locator: {
      description: 'What a step acts on. A string tries, in order: button/link/tab/menuitem/checkbox/radio/option/switch/combobox/textbox by exact name, label, placeholder, the same roles by partial name, exact then partial text, a name="…" attribute, and a custom-element tag; a string starting with #, ., [ or css= is CSS. Or an object.',
      anyOf: [{ type: 'string', minLength: 1 }, locatorObject],
    },
    steps: { type: 'array', description: 'Steps, run in order.', items: { $ref: '#/$defs/step' } },
  },
};

/** Keys any step may carry. */
const STEP_COMMON = {
  optional: bool('If it fails, log it and carry on (gives up after timeouts.optional, default 3 s). A check marked optional never fails the run.'),
  timeout: num('Milliseconds before this step gives up (defaults: timeouts.action / verify / waitFor / navigation).', { minimum: 0 }),
  retries: num('Rule-based retries when an action times out or its target is not there yet (default: the tour\'s "retries", 1). Checks are never retried.', { minimum: 0 }),
  criterion: { description: 'The acceptance criterion this check covers (e.g. 2 or "AC2"); defaults to the scene\'s "criteria".', anyOf: [{ type: 'number' }, { type: 'string' }] },
  comment: str('A note for people; ignored.'),
  waitForResponse: { description: 'Also wait for a network response whose URL contains this (or matches /regex/), started before the action so it can\'t be missed.', type: 'string' },
  status: num('With waitForResponse: the HTTP status the response must have; any other status is an APP failure.'),
  method: str('With waitForResponse (or mock): only requests with this HTTP method.'),
};

/** One action: its key, its own properties, and the common ones; nothing else (catches typos like "txet"). */
const action = (key, description, value, props = {}, required = []) => ({
  type: 'object', description,
  properties: { [key]: value, ...props, ...STEP_COMMON },
  required: [key, ...required],
  additionalProperties: false,
});

const keyName = str('A key or chord: Enter, Escape, Tab, ArrowDown, Control+A, Shift+Tab…');
const text = str('The text to enter. Use "{env:NAME}" with "secret": true for credentials.');
const secret = bool('The value is a credential: set without typing, never logged, scrubbed from reports.');

export const ACTIONS = {
  goto: action('goto', 'Navigate to a path relative to the environment\'s baseUrl (never an absolute URL in a platform tour).', str('Path, e.g. "/orders" or "#/home".')),
  click: action('click', 'Move the cursor to the element and click it.', loc('The element to click.'), {
    button: { enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
    modifiers: { type: 'array', items: { enum: ['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta'] }, description: 'Keys held during the click.' },
    clickCount: num('Number of clicks (2 = double click).', { minimum: 1 }),
    opensPopup: bool('The click opens a new tab or window: wait for it and continue there (switch back with { "switchTo": "main" }). Only the main page is filmed.'),
  }),
  dblclick: action('dblclick', 'Double-click the element.', loc('The element to double-click.')),
  rightClick: action('rightClick', 'Right-click the element (context menu).', loc('The element to right-click.')),
  hover: action('hover', 'Move the cursor over the element (menus, tooltips).', loc('The element to hover.')),
  point: action('point', 'Move the cursor to the element to draw the viewer\'s eye; nothing is clicked.', loc('The element to point at.')),
  fill: action('fill', 'Click the field, clear it and type the text.', loc('The field.'), { text, secret }, ['text']),
  type: action('type', 'Type into the field key by key without clearing it (for fields that react to each key).', loc('The field.'), { text, secret, delay: num('Milliseconds between keys (default 45).', { minimum: 0 }) }, ['text']),
  clear: action('clear', 'Empty a field.', loc('The field.')),
  focus: action('focus', 'Give the element keyboard focus.', loc('The element.')),
  press: action('press', 'Press a key, on the focused element or on "on".', keyName, { on: loc('Focus this element first.') }),
  check: action('check', 'Tick a checkbox, radio button or switch (no-op if already on).', loc('The checkbox, radio or switch.')),
  uncheck: action('uncheck', 'Untick a checkbox or switch (no-op if already off).', loc('The checkbox or switch.')),
  select: action('select', 'Choose an option in a <select>.', loc('The <select>.'), {
    option: { description: 'The option: its label or value, a list for multi-select, or { "label" | "value" | "index" }.',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, obj('', { label: { type: 'string' }, value: { type: 'string' }, index: { type: 'integer' } })] },
  }, ['option']),
  upload: action('upload', 'Set the files of a file input (or the input behind an upload button).', loc('The file input, or the button that opens the file chooser.'), {
    files: { description: 'File path(s), relative to the tour file, then to the platform\'s fixtures/ folder. Synthetic files only.',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
  }, ['files']),
  drag: action('drag', 'Drag the element and drop it on "to", with a visible cursor path.', loc('What to drag.'), { to: loc('Where to drop it.') }, ['to']),
  scroll: action('scroll', 'Scroll: a number of pixels with the wheel (negative = up), or a locator to bring into view.', { description: 'Pixels, or a locator.', anyOf: [{ type: 'number' }, ref('locator')] }),
  waitFor: action('waitFor', 'Wait (off pace) until the element reaches a state; default visible.', loc('The element.'), {
    state: { enum: ['visible', 'hidden', 'attached', 'detached'], description: 'The state to wait for (default visible).' },
  }),
  waitForResponse: {
    type: 'object', description: 'Wait for a network response (when it was triggered by something other than a step; otherwise put "waitForResponse" on that step).',
    properties: { ...STEP_COMMON, waitForResponse: { type: 'string', description: 'URL substring, or /regex/.' } }, required: ['waitForResponse'], additionalProperties: false,
  },
  verify: action('verify', 'A check: the element (or page) must be as described within timeouts.verify, else CRITERION failure. The cursor points at it. Without a condition: visible.',
    { description: 'The element to check, or { "url": … } / { "title": … } for the page.', anyOf: [ref('locator'),
      obj('The page\'s URL contains this (or matches /regex/).', { url: { type: 'string' } }, { required: ['url'] }),
      obj('The page title contains this (or matches /regex/).', { title: { type: 'string' } }, { required: ['title'] })] },
    {
      text: str('The element\'s text contains this (or matches /regex/).'),
      exactText: str('The element\'s text is exactly this (whitespace collapsed).'),
      value: str('A field\'s value is exactly this.'),
      count: num('Exactly this many visible elements match.', { minimum: 0 }),
      state: { enum: ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'editable', 'focused'], description: 'The element\'s state.' },
    }),
  capture: action('capture', 'Remember a value from the page for later steps, as "{vars.<as>}" (an id, a generated code, a link): an element\'s attribute, else a field\'s value, else its text; or the page URL. A later step that uses a value never captured is a SCRIPT failure.',
    { description: 'The element to read, or { "url": true } for the page URL.', anyOf: [ref('locator'),
      obj('The page URL.', { url: { const: true } }, { required: ['url'] })] },
    {
      as: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'The name: later steps use "{vars.<as>}".' },
      attribute: str('Read this attribute (e.g. "href") instead of the text or value.'),
      pattern: str('A regex (with or without /…/flags): keep its first group, or the whole match. No match is a SCRIPT failure.'),
    }, ['as']),
  wait: action('wait', 'Pause for a number of seconds (prefer "at" or waitFor).', num('Seconds.', { minimum: 0 })),
  at: action('at', 'Wait until this fraction of the scene\'s narration has played (0–1); places the next actions in time.', num('Fraction of the narration, 0 to 1.', { minimum: 0, maximum: 1 })),
  dialog: action('dialog', 'How to answer the next alert/confirm/prompt (default: accept). Put it before the step that opens the dialog.', { enum: ['accept', 'dismiss'], description: 'accept or dismiss.' }, {
    text: str('For a prompt(): the answer to type.'),
    expect: str('The dialog\'s message must contain this (or match /regex/), else CRITERION failure when it appears.'),
  }),
  switchTo: action('switchTo', 'Continue on another page: "main" (the first tab), "popup" / "last" (the newest tab).', { enum: ['main', 'popup', 'last'], description: 'Which page.' }),
  download: action('download', 'Click the element and wait for the download it starts; the file is saved in the run folder under downloads/.', loc('The element that starts the download.'), {
    saveAs: str('File name to save it as (default: the suggested name).'),
    expect: str('The suggested file name must contain this (or match /regex/), else CRITERION failure.'),
  }),
  mock: action('mock', 'Answer matching requests with a canned response, for the rest of the run. Needs "allowMocks": true on the tour, and every mock is listed in the report: a video shown as evidence must say so.', str('URL substring, or /regex/.'), {
    json: { description: 'JSON body to return.' },
    body: str('Text body to return.'),
    contentType: str('Content-Type (default application/json for json, text/plain for body).'),
    times: num('Only the first n matching requests.', { minimum: 1 }),
  }),
  code: action('code', 'A code step: a .mjs file (normally in the platform\'s fragments/) exporting  async ({ page, context, args, ctx }) => …  Must be deterministic.', str('File name, e.g. "todo-count.mjs".'), {
    with: { type: 'object', description: 'Arguments, as args in the function.' },
  }),
  use: action('use', 'Run a fragment: platforms/<platform>/fragments/<name>.json (steps) or .mjs (a code step). Extra keys such as "optional" apply to each of its steps.', str('Fragment name, without extension.'), {
    with: { type: 'object', description: 'Fragment parameters, available to it as {args.<name>}.' },
  }),
};

common.$defs.step = {
  description: 'One step: an object with exactly one action key.',
  anyOf: Object.keys(ACTIONS).map(k => ({ $ref: `#/$defs/action_${k}` })),
};
for (const [k, v] of Object.entries(ACTIONS)) common.$defs[`action_${k}`] = v;

// ---- Files ---------------------------------------------------------------------------------------------------------

const file = (name, title, description, schema) => ({ $schema: `https://json-schema.org/draft/${D}/schema`, $id: `${BASE}/${name}.schema.json`, title, description, ...schema });
const $schemaProp = { $schema: str('This file\'s schema, for editors: a relative path to schemas/<type>.schema.json.') };

const timeouts = obj('Milliseconds per kind of step.', {
  action: num('Actions: finding and acting on an element (default 10000).'), verify: num('Checks (default 15000).'),
  waitFor: num('waitFor steps (default 30000).'), navigation: num('Page loads (default 30000).'), optional: num('Optional steps (default 3000).'),
});
const ready = obj('When a page counts as ready after an action, for apps that never go network-idle.', {
  busy: str('CSS of busy indicators (spinners, skeletons); wait until none is visible.'), stableMs: num('Then the page must not change for this long (default 1500).'),
  timeout: num('Max wait for busy indicators to go (default 60000).'), stableTimeout: num('Max wait for a stable page (default 15000).'),
  strict: bool('A page that never settles is an APP failure (default: a warning).'),
});
const errors = obj('The app\'s own error UI: a step that leaves it visible fails as APP.', { selector: str('CSS of the error element (dialog, toast).'), text: str('Only when its text matches this regex.') }, { required: ['selector'] });
const appErrors = obj('What browser-side errors during a step do: "fail" (APP failure) or "warn" (listed in the report).', {
  network: { enum: ['fail', 'warn'], description: 'HTTP 5xx responses (default warn).' }, network4xx: { enum: ['fail', 'warn'], description: 'Also fail on 4xx.' },
  console: { enum: ['fail', 'warn'], description: 'console.error messages (default warn).' }, pageErrors: { enum: ['fail', 'warn'], description: 'Uncaught exceptions (default warn).' },
  ignore: { type: 'array', items: { type: 'string' }, description: 'Regexes of known noisy requests/messages: kept in network.json/console.json, marked ignored, never a cause.' },
});
const mask = obj('Blurred in the page before anything is recorded (video, screenshots, trace).', {
  selectors: { type: 'array', items: { type: 'string' }, description: 'CSS of elements to blur.' }, patterns: { type: 'array', items: { type: 'string' }, description: 'Regexes of text to blur.' },
});
const viewport = obj('Browser size in CSS pixels (default 1440×810).', { width: { type: 'integer' }, height: { type: 'integer' } }, { required: ['width', 'height'] });
const pronounce = { type: 'object', additionalProperties: { type: 'string' }, description: 'Narration substitutions: written form → how to say it ("RMS": "R M S").' };
const hook = {
  description: 'A setup/teardown hook, run off camera with BASE_URL and RUN_DIR set.',
  anyOf: [
    obj('A shell command.', { run: str('Command line.'), cwd: str('Working folder, relative to the file.'), optional: bool('Failure is only a warning.') }, { required: ['run'] }),
    obj('A Node script.', { node: str('Script path, relative to the file.'), args: { type: 'array', items: { type: 'string' } }, optional: bool('Failure is only a warning.') }, { required: ['node'] }),
    obj('An HTTP request.', { http: obj('The request.', { method: str('Default POST.'), url: str('Relative to baseUrl.'), headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { description: 'JSON value or string.' } }, { required: ['url'] }), optional: bool('A non-2xx answer is only a warning.') }, { required: ['http'] }),
  ],
};
const hooks = obj('Test data, off camera: setup before the browser starts, teardown after it closes (teardown runs whenever setup ran).', { setup: { type: 'array', items: hook }, teardown: { type: 'array', items: hook } });
const launch1 = obj('A service the run starts when nothing answers at healthUrl (already up: used as is, never stopped).', {
  name: str('Label for logs.'), command: str('Shell command that starts it (run from the platform folder).'), cwd: str('Working folder, relative to the platform folder.'),
  env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables ({port} is the free port).' },
  port: { description: '"auto" picks a free port per run ({port}).', anyOf: [{ const: 'auto' }, { type: 'integer' }] },
  healthUrl: str('URL that answers when it is up (default baseUrl; {baseUrl} and {port} allowed).'), anyStatus: bool('Any HTTP status counts as up (default: 2xx/3xx).'),
  timeoutSeconds: num('How long to wait for it (default 120).'), stop: bool('false: leave it running after the run (slow-starting services).'),
});
const attach1 = obj('A service the environment expects to be running; a run never starts it, and if it is down the run is UNREACHABLE.', { name: str('Label.'), healthUrl: str('Default baseUrl.'), anyStatus: bool('Any HTTP status counts as up.') });
const environment = obj('One deployment of the app.', {
  comment: str('A note for people.'), baseUrl: str('Root URL of the app in this environment.'),
  launch: { description: 'Start the app if it isn\'t running: one service or a list.', anyOf: [launch1, { type: 'array', items: launch1 }] },
  attach: { description: 'Attach-only: these must already be running.', type: 'array', items: attach1 },
  timeouts, ready, ignoreHTTPSErrors: bool('Accept self-signed certificates.'),
}, { required: ['baseUrl'] });

const scene = obj('One scene: narration over the steps that show it.', {
  title: str('Shown on title cards and in reports.'), narration: str('What the narrator says; the scene lasts as long as it does.'),
  url: str('Path opened off camera just before the scene starts.'), criteria: { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, description: 'Acceptance criteria this scene demonstrates (1-based).' },
  steps: ref('steps'), comment: str('A note for people.'),
  unresolved: { type: 'array', items: { type: 'string' }, description: 'Story items the generator could not map to the app; recording refuses until resolved.' },
  todo: str('Work left for a person; recording refuses until removed.'),
}, { required: ['title', 'narration'] });

const story = obj('The user story the tour verifies.', {
  id: str('Ticket id, e.g. RMS-6142 (used in the run folder name).'), title: str('Story title.'), description: str('Story text.'),
  acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Numbered from 1 in scenes\' "criteria".' }, text: str('The story as pasted.'),
});

const PLATFORM_ONLY = { baseUrl: environment.properties.baseUrl, environments: { type: 'object', additionalProperties: environment, description: 'Stand-alone tours only.' },
  launch: environment.properties.launch, login: { description: 'Stand-alone tours only: { "role", "steps", "signedIn", "checkPath", "maxAgeMinutes" }.', type: 'object' },
  ready, errors, appErrors, mask, ignoreHTTPSErrors: bool('Stand-alone tours only.'), startPath: str('Stand-alone tours only.'), target: str('Stand-alone tours only: auth folder name.'),
  discover: { type: 'object', description: 'Stand-alone tours only.' } };

export const SCHEMAS = {
  common,
  tour: file('tour', 'AutoFeatureTour tour (*.tour.json)', 'What to show: scenes of narration and steps. Names its platform; holds no URLs, credentials, launch commands or app-wide settings (stand-alone tours without "platform" may, for quick experiments).', {
    type: 'object', additionalProperties: false, required: ['scenes'],
    properties: {
      ...$schemaProp,
      name: str('Run folder name (default: the file name).'), platform: str('The app: platforms/<platform>/.'),
      env: str('Default environment (--target overrides; default: the platform\'s default).'), role: str('Login role (--role overrides; default: login.json "default").'),
      fixtures: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' }, description: 'Fixtures from the platform\'s fixtures/: data ({data.x}), setup/teardown and off-camera steps.' },
      story, scenes: { type: 'array', minItems: 1, items: scene, description: 'The scenes, in order.' },
      timeouts, retries: num('Retries for actions that time out (default 1).'), onError: { enum: ['fail', 'skip'], description: '"skip": an action that can\'t be done is skipped (checks still fail). Default fail.' },
      hooks, voice: str('SAPI voice name.'), pronounce, viewport, trace: bool('false: no trace.zip (it holds network traffic and DOM).'),
      allowMocks: bool('Permit "mock" steps. Mocked responses are listed in the report.'),
      comment: str('A note for people.'), style: str('Generation hint (verification, demo, training); the engine ignores it.'),
      generatedBy: str('Which planner wrote it.'), plannedAt: str('When it was generated.'), draft: bool('Generated with gaps; recording refuses unless --allow-draft.'),
      needs: { type: 'array', items: { type: 'string' }, description: 'What a draft still needs.' },
      ...PLATFORM_ONLY,
    },
  }),
  platform: file('platform', 'AutoFeatureTour platform (platforms/<name>/platform.json)', 'How the app behaves wherever it runs.', {
    type: 'object', additionalProperties: false,
    properties: { ...$schemaProp, comment: str('A note for people.'), ready, errors, appErrors, ignore: appErrors.properties.ignore, mask, pronounce, viewport, voice: str('SAPI voice.'),
      ignoreHTTPSErrors: bool('Accept self-signed certificates.'), startPath: str('Where sessions and discovery start (default /).'),
      discover: obj('Discovery hints.', { paths: { type: 'array', items: { type: 'string' }, description: 'Extra paths to crawl.' } }),
      timeouts, retries: num('Retries for actions that time out (default 1).'), trace: bool('false: no trace.zip.') },
  }),
  environments: file('environments', 'AutoFeatureTour environments (platforms/<name>/environments.json)', 'Where the app runs: one entry per environment, plus "default".', {
    type: 'object', properties: { ...$schemaProp, default: str('The environment used when none is given.') },
    additionalProperties: environment,
  }),
  login: file('login', 'AutoFeatureTour login (platforms/<name>/login.json)', 'How to sign in, per role. Credentials only as "{env:NAME}" (environment or .env). Saved state: auth/<platform>/<env>/<role>.json.', {
    type: 'object', additionalProperties: false, required: ['roles'],
    properties: { ...$schemaProp, comment: str('A note for people.'), default: str('Role used when none is given.'),
      signedIn: str('CSS of an element only a signed-in page shows; how an expired session is noticed.'), checkPath: str('Path opened to check the session (default startPath).'),
      maxAgeMinutes: num('Sign in again when the saved state is older than this.'),
      roles: { type: 'object', description: 'Role name → its sign-in steps.', additionalProperties: obj('A role.', { steps: ref('steps'), comment: str('A note.') }, { required: ['steps'] }) } },
  }),
  fragment: file('fragment', 'AutoFeatureTour fragment (platforms/<name>/fragments/<fragment>.json)', 'Reusable steps, called as { "use": "<fragment>", "with": { … } }; parameters are {args.<name>} in its steps.', {
    type: 'object', additionalProperties: false, required: ['steps'],
    properties: { ...$schemaProp, description: str('What it does (shown to authors).'),
      params: { type: 'object', description: 'Parameters: name → { required } or { default }. Unknown and missing required ones are refused.',
        additionalProperties: obj('A parameter.', { required: bool('Must be given.'), default: { description: 'Value when not given.' }, description: str('What it is.') }) },
      steps: ref('steps') },
  }),
  fixture: file('fixture', 'AutoFeatureTour fixture (platforms/<name>/fixtures/<fixture>.json)', 'Test data a tour needs: values, hooks to create/remove it, and browser steps run off camera before the first scene.', {
    type: 'object', additionalProperties: false,
    properties: { ...$schemaProp, description: str('What it sets up.'), data: { type: 'object', description: 'Values, as {data.<key>} in tours and steps.' },
      setup: { type: 'array', items: hook, description: 'Before the browser starts (run from fixtures/).' }, teardown: { type: 'array', items: hook, description: 'After the browser closes.' },
      steps: ref('steps') },
  }),
};

export const TYPES = ['tour', 'platform', 'environments', 'login', 'fragment', 'fixture'];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(SCHEMAS)) fs.writeFileSync(path.join(dir, `${k}.schema.json`), JSON.stringify(v, null, 2) + '\n');
  console.log(`wrote ${Object.keys(SCHEMAS).length} schemas to ${dir}`);
}
