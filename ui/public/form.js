// A form for a definition file, built from its JSON Schema (the same schemas/ files the CLI checks against).
// Scalars get inputs (enums a select, booleans unset/true/false), objects nest, maps (additionalProperties) list their
// keys with "+ add"; anything the form can't say plainly (lists, steps, mixed types) is a small JSON box. An emptied
// field removes its key, so the file keeps only what was set. The raw text stays the source of truth: the form edits a
// parsed copy and hands the whole document back through onChange.

const h = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Mounts the form in box for doc (an object, edited in place); onChange(doc) after every edit. */
export function mountSchemaForm(box, { schema, common, doc, onChange }) {
  const resolve = s => {
    for (let i = 0; s?.$ref && i < 10; i++) {
      const [file, ptr] = s.$ref.split('#');
      const src = file ? common : schema;
      s = { ...ptr.split('/').filter(Boolean).reduce((o, k) => o?.[k], src), ...(s.description ? { description: s.description } : {}) };
    }
    return s ?? {};
  };
  const typeOf = s => { s = resolve(s); return s.type ?? (s.properties ? 'object' : s.enum ? 'string' : null); };
  // anyOf/oneOf of scalars only (a number or a "{data.x}" placeholder): one text box that keeps numbers as numbers
  const scalarUnion = s => { const alts = s.anyOf ?? s.oneOf; return alts && alts.every(a => ['string', 'number', 'integer', 'boolean'].includes(typeOf(a))) ? alts.map(typeOf) : null; };

  const get = path => path.reduce((o, k) => o?.[k], doc);
  const set = (path, v) => {
    let o = doc;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {});
    if (v === undefined) delete o[path.at(-1)]; else o[path.at(-1)] = v;
    // drop objects the edit left empty, so unset sections vanish from the file
    for (let n = path.length - 1; n > 0; n--) { const parent = get(path.slice(0, n)); if (parent && typeof parent === 'object' && !Array.isArray(parent) && !Object.keys(parent).length) set(path.slice(0, n), undefined); else break; }
  };
  const id = path => `f-${path.map(p => String(p).replace(/\W/g, '_')).join('-')}`;
  const tip = s => s.description ? ` title="${h(s.description)}"` : '';

  function field(key, s0, path) {
    const s = resolve(s0), v = get(path), t = typeOf(s), union = scalarUnion(s);
    const label = `<label class="f-label" for="${id(path)}"${tip(s)}>${h(key)}${s.description ? ' <span class="f-help">ⓘ</span>' : ''}</label>`;
    const data = `data-path='${h(JSON.stringify(path))}'`;
    if (s.enum) return `<div class="f-row">${label}<select id="${id(path)}" ${data} data-t="enum"><option value=""></option>${s.enum.map(e => `<option ${v === e ? 'selected' : ''} value="${h(JSON.stringify(e))}">${h(e)}</option>`).join('')}</select></div>`;
    if (t === 'boolean') return `<div class="f-row">${label}<select id="${id(path)}" ${data} data-t="bool"><option value=""></option><option ${v === true ? 'selected' : ''}>true</option><option ${v === false ? 'selected' : ''}>false</option></select></div>`;
    if (t === 'number' || t === 'integer') return `<div class="f-row">${label}<input id="${id(path)}" ${data} data-t="number" type="number" value="${v ?? ''}"></div>`;
    if (t === 'string' || (union && (v === undefined || typeof v !== 'object')))
      return `<div class="f-row">${label}<input id="${id(path)}" ${data} data-t="${union ? `union:${union.join(',')}` : 'string'}" value="${h(v ?? '')}" placeholder="${h(s.default ?? '')}"></div>`;
    if (t === 'object' && (s.properties || (s.additionalProperties && typeof s.additionalProperties === 'object')) && (v === undefined || (v && typeof v === 'object' && !Array.isArray(v))))
      return `<details class="f-obj" ${v !== undefined && path.length < 2 ? 'open' : ''}><summary${tip(s)}>${h(key)}${v === undefined ? ' <span class="f-help">(not set)</span>' : ''}</summary>${object(s, path)}</details>`;
    // lists, steps, objects of free shape, mixed unions: a JSON box
    return `<div class="f-row f-json">${label}<textarea id="${id(path)}" ${data} data-t="json" rows="${v === undefined ? 1 : Math.min(10, JSON.stringify(v, null, 2).split('\n').length)}" spellcheck="false" placeholder="JSON">${h(v === undefined ? '' : JSON.stringify(v, null, 2))}</textarea></div>`;
  }

  function object(s, path) {
    s = resolve(s);
    const v = get(path) ?? {};
    const props = Object.entries(s.properties ?? {}).filter(([k]) => k !== '$schema');
    const extra = s.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : null;
    const extraKeys = extra ? Object.keys(v).filter(k => !(k in (s.properties ?? {}))) : [];
    return `<div class="f-fields">${props.map(([k, ps]) => field(k, ps, [...path, k])).join('')}
      ${extraKeys.map(k => `<div class="f-extra">${field(k, extra, [...path, k])}<button class="f-remove" data-remove='${h(JSON.stringify([...path, k]))}' title="Remove ${h(k)}">✕</button></div>`).join('')}
      ${extra ? `<div class="f-add"><input placeholder="new name" data-addname='${h(JSON.stringify(path))}' size="14"><button data-add='${h(JSON.stringify(path))}' data-addtype="${h(typeOf(extra) ?? '')}">+ add</button></div>` : ''}</div>`;
  }

  const draw = () => {
    box.innerHTML = `<div class="schema-form">${object(schema, [])}</div>`;
    wire();
  };
  function wire() {
    box.querySelectorAll('[data-path]').forEach(el => {
      const path = JSON.parse(el.dataset.path), t = el.dataset.t;
      el.onchange = el.oninput = () => {
        const raw = el.value;
        el.classList.remove('f-bad');
        if (raw === '') set(path, undefined);
        else if (t === 'enum') set(path, JSON.parse(raw));
        else if (t === 'bool') set(path, raw === 'true');
        else if (t === 'number') set(path, Number(raw));
        else if (t.startsWith('union:')) set(path, t.includes('number') && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : t.includes('boolean') && /^(true|false)$/.test(raw) ? raw === 'true' : raw);
        else if (t === 'json') { try { set(path, JSON.parse(raw)); } catch { el.classList.add('f-bad'); return; } }
        else set(path, raw);
        onChange(doc);
      };
    });
    box.querySelectorAll('[data-remove]').forEach(b => (b.onclick = () => { set(JSON.parse(b.dataset.remove), undefined); onChange(doc); draw(); }));
    box.querySelectorAll('[data-add]').forEach(b => (b.onclick = () => {
      const path = JSON.parse(b.dataset.add), input = b.previousElementSibling, k = input.value.trim();
      if (!/^[\w.-]+$/.test(k) || get([...path, k]) !== undefined) { input.classList.add('f-bad'); return; }
      const t = b.dataset.addtype;
      // set() drops empty objects, so a new map entry starts with one placeholder key the person fills in or removes
      set([...path, k], t === 'object' ? { comment: '' } : t === 'number' ? 0 : t === 'boolean' ? false : '');
      onChange(doc); draw();
      box.querySelector(`#${CSS.escape(id([...path, k]))}`)?.closest('details')?.setAttribute('open', '');
    }));
  }
  draw();
  return { redraw(next) { doc = next; draw(); } };
}
