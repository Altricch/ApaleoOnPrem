/**
 * A small API explorer for the clone. It reads the same OpenAPI documents the
 * server implements, renders each operation's contract, and lets you run it
 * against this host. No bundler, no CDN: the docs work offline.
 */
'use strict';

const state = {
  specs: [],            // [{ key, title, doc }]
  operations: [],       // flattened, in nav order
  current: null,
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];

/* ------------------------------------------------------------ bootstrap */

async function boot() {
  await Promise.all([loadHealth(), loadSpecs()]);
  renderNav();
  document.getElementById('search').addEventListener('input', renderNav);
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}

async function loadHealth() {
  const pill = document.getElementById('health');
  const coverage = document.getElementById('coverage');
  try {
    const res = await fetch('/health');
    const body = await res.json();
    pill.textContent = 'server ok';
    pill.className = 'pill ok';
    coverage.textContent = `${body.operations.implemented} / ${body.operations.documented} operations`;
  } catch {
    pill.textContent = 'server unreachable';
    pill.className = 'pill bad';
    coverage.textContent = '';
  }
}

async function loadSpecs() {
  const index = await (await fetch('/swagger/index.json')).json();
  // The stable v1 surface first; the preview specs after it.
  const refs = index.urls
    .map((u) => ({ ...u, key: /\/swagger\/([^/]+)\/swagger\.json/.exec(u.url)[1] }))
    .sort((a, b) => {
      const av = a.key.endsWith('-v1') ? 0 : 1;
      const bv = b.key.endsWith('-v1') ? 0 : 1;
      return av - bv || a.key.localeCompare(b.key);
    });

  const docs = await Promise.all(refs.map(async (ref) => {
    const doc = await (await fetch(ref.url)).json();
    return { key: ref.key, title: doc.info?.title ?? ref.name, doc };
  }));

  state.specs = docs;
  state.operations = docs.flatMap(({ key, doc }) =>
    Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      METHODS.filter((m) => item[m]).map((method) => ({
        specKey: key,
        method: method.toUpperCase(),
        path,
        op: item[method],
        tag: (item[method].tags ?? ['Other'])[0],
        id: item[method].operationId ?? `${method}:${path}`,
      }))));
}

/* ------------------------------------------------------------------ nav */

function renderNav() {
  const query = document.getElementById('search').value.trim().toLowerCase();
  const nav = document.getElementById('nav');
  nav.textContent = '';

  for (const spec of state.specs) {
    const ops = state.operations
      .filter((o) => o.specKey === spec.key)
      .filter((o) => !query
        || o.path.toLowerCase().includes(query)
        || o.id.toLowerCase().includes(query)
        || (o.op.summary ?? '').toLowerCase().includes(query));
    if (!ops.length) continue;

    const group = el('details', { class: 'group' });
    // Open the stable specs by default, and everything while filtering.
    group.open = !!query || spec.key.endsWith('-v1');
    group.append(el('summary', {}, [
      text(spec.title.replace(/^apaleo /, '')),
      el('span', { class: 'count' }, [text(String(ops.length))]),
    ]));

    const byTag = new Map();
    for (const o of ops) {
      if (!byTag.has(o.tag)) byTag.set(o.tag, []);
      byTag.get(o.tag).push(o);
    }

    for (const [tag, list] of byTag) {
      const tagEl = el('details', { class: 'tag' });
      tagEl.open = !!query || byTag.size <= 3;
      tagEl.append(el('summary', {}, [text(`${tag} · ${list.length}`)]));
      for (const o of list) {
        const button = el('button', {
          class: 'op-link',
          type: 'button',
          'data-id': o.id,
          'aria-current': String(state.current?.id === o.id),
        }, [
          el('span', { class: `verb ${o.method}` }, [text(o.method)]),
          el('span', { class: 'path' }, [text(shortPath(o.path))]),
        ]);
        button.addEventListener('click', () => { window.location.hash = o.id; });
        tagEl.append(button);
      }
      group.append(tagEl);
    }
    nav.append(group);
  }
}

/** Trim the `/booking/v1` prefix; the group already says which API it is. */
function shortPath(path) {
  return path.replace(/^\/[a-z]+\/v\d+/, '') || '/';
}

/* ------------------------------------------------------------ operation */

function openFromHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  const operation = state.operations.find((o) => o.id === id);
  if (!operation) return;
  state.current = operation;
  renderOperation(operation);
  renderNav();
  document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderOperation(entry) {
  const { op, method, path, specKey } = entry;
  const spec = state.specs.find((s) => s.key === specKey);
  const main = document.getElementById('main');
  main.textContent = '';

  main.append(el('div', { class: 'op-header' }, [
    el('span', { class: `verb ${method}` }, [text(method)]),
    el('span', { class: 'route' }, [text(path)]),
    el('span', { class: 'op-id' }, [text(entry.id)]),
  ]));
  if (op.summary) main.append(el('p', { class: 'op-summary' }, [text(op.summary)]));
  if (op.description) {
    const desc = el('p', { class: 'op-desc' });
    desc.innerHTML = sanitize(op.description);
    main.append(desc);
  }

  const scopes = extractScopes(op.description ?? '');
  if (scopes.length) {
    main.append(el('div', { class: 'scopes' },
      scopes.map((s) => el('span', { class: 'scope' }, [text(s)]))));
  }

  const params = op.parameters ?? [];
  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  const bodyParam = params.find((p) => p.in === 'body');

  if (pathParams.length || queryParams.length) {
    main.append(parameterTable([...pathParams, ...queryParams]));
  }
  if (bodyParam) main.append(bodySection(bodyParam, spec));
  main.append(responseTable(op.responses ?? {}));
  main.append(tryItPanel(entry, pathParams, queryParams, bodyParam, spec));
}

function parameterTable(params) {
  const rows = params.map((p) => el('tr', {}, [
    el('td', {}, [
      text(p.name),
      ...(p.required ? [el('span', { class: 'req' }, [text(' *')])] : []),
    ]),
    el('td', {}, [text(describeType(p))]),
    el('td', {}, [text(p.in)]),
    el('td', { class: 'desc' }, [text(stripTags(p.description ?? ''))]),
  ]));
  return el('section', { class: 'panel' }, [
    el('h2', {}, [text('Parameters')]),
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Name', 'Type', 'In', 'Description']
        .map((h) => el('th', {}, [text(h)])))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

function describeType(p) {
  if (p.type === 'array') return `${p.items?.type ?? 'string'}[]`;
  if (p.enum) return p.enum.join(' | ');
  return p.type ?? 'object';
}

function bodySection(bodyParam, spec) {
  const example = exampleFor(bodyParam.schema, spec.doc, 0);
  return el('section', { class: 'panel' }, [
    el('h2', {}, [text(`Request body${bodyParam.required ? ' (required)' : ''}`)]),
    el('p', { class: 'hint' }, [text(refLabel(bodyParam.schema))]),
    el('pre', {}, [el('code', {}, [text(JSON.stringify(example, null, 2))])]),
  ]);
}

function responseTable(responses) {
  const rows = Object.entries(responses)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, r]) => el('tr', {}, [
      el('td', {}, [text(code)]),
      el('td', { class: 'desc' }, [text(stripTags(r.description ?? ''))]),
      el('td', {}, [text(refLabel(r.schema) || '—')]),
    ]));
  return el('section', { class: 'panel' }, [
    el('h2', {}, [text('Responses')]),
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Status', 'Description', 'Schema']
        .map((h) => el('th', {}, [text(h)])))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

/* -------------------------------------------------------------- try it */

function tryItPanel(entry, pathParams, queryParams, bodyParam, spec) {
  const panel = el('section', { class: 'panel' }, [el('h2', {}, [text('Try it')])]);
  const inputs = new Map();

  for (const p of [...pathParams, ...queryParams]) {
    const input = el('input', {
      type: 'text',
      placeholder: p.required ? 'required' : (p.default !== undefined ? String(p.default) : 'optional'),
      value: p.default !== undefined && p.in === 'query' ? '' : '',
    });
    if (p.enum) {
      const select = el('select', {});
      select.append(el('option', { value: '' }, [text(p.required ? '— choose —' : '(omit)')]));
      for (const value of p.enum) select.append(el('option', { value }, [text(value)]));
      inputs.set(p, select);
      panel.append(el('div', { class: 'field' }, [
        el('label', {}, [text(p.name + (p.required ? ' *' : ''))]),
        select,
      ]));
      continue;
    }
    inputs.set(p, input);
    panel.append(el('div', { class: 'field' }, [
      el('label', {}, [text(p.name + (p.required ? ' *' : ''))]),
      input,
    ]));
  }

  let bodyBox = null;
  if (bodyParam) {
    bodyBox = el('textarea', { spellcheck: 'false' });
    bodyBox.value = JSON.stringify(exampleFor(bodyParam.schema, spec.doc, 0), null, 2);
    panel.append(bodyBox);
  }

  const status = el('span', { class: 'status' });
  const output = el('div', { class: 'response' });

  const run = el('button', { class: 'run', type: 'button' }, [text(`Send ${entry.method}`)]);
  const copy = el('button', { class: 'ghost', type: 'button' }, [text('Copy as curl')]);

  const buildUrl = () => {
    let url = entry.path;
    const query = new URLSearchParams();
    for (const [p, input] of inputs) {
      const value = input.value.trim();
      if (!value) continue;
      if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(value));
      // A repeated query parameter is expressed as comma-separated input.
      else if (p.type === 'array') value.split(',').forEach((v) => query.append(p.name, v.trim()));
      else query.set(p.name, value);
    }
    url = url.replace(/\{[^}]+\}/g, '');
    return url + (query.toString() ? `?${query}` : '');
  };

  run.addEventListener('click', async () => {
    const url = buildUrl();
    status.textContent = 'running…';
    status.className = 'status';
    output.textContent = '';
    try {
      const init = { method: entry.method };
      if (bodyBox && bodyBox.value.trim()) {
        init.headers = { 'content-type': 'application/json' };
        init.body = bodyBox.value;
      }
      const started = performance.now();
      const res = await fetch(url, init);
      const ms = Math.round(performance.now() - started);
      status.textContent = `${res.status} ${res.statusText} · ${ms} ms`;
      status.className = `status s${String(res.status)[0]}`;

      const type = res.headers.get('content-type') ?? '';
      let rendered;
      if (res.status === 204) rendered = '(no content)';
      else if (type.includes('json')) rendered = JSON.stringify(await res.json(), null, 2);
      else if (type.includes('pdf')) rendered = `(${(await res.arrayBuffer()).byteLength} bytes of PDF)`;
      else rendered = await res.text();
      output.append(el('pre', {}, [el('code', {}, [text(rendered)])]));
    } catch (err) {
      status.textContent = 'request failed';
      status.className = 'status s5';
      output.append(el('pre', {}, [el('code', {}, [text(String(err))])]));
    }
  });

  copy.addEventListener('click', async () => {
    const url = window.location.origin + buildUrl();
    const parts = [`curl -s -X ${entry.method} '${url}'`];
    if (bodyBox && bodyBox.value.trim()) {
      parts.push(`  -H 'content-type: application/json'`);
      parts.push(`  -d '${bodyBox.value.replace(/\n\s*/g, '')}'`);
    }
    await navigator.clipboard.writeText(parts.join(' \\\n'));
    copy.textContent = 'copied';
    setTimeout(() => { copy.textContent = 'Copy as curl'; }, 1200);
  });

  panel.append(el('div', { class: 'actions' }, [run, copy, status]));
  panel.append(output);
  return panel;
}

/* ------------------------------------------------------------ examples */

/** Build a plausible request body from a Swagger 2.0 schema. */
function exampleFor(schema, doc, depth) {
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    const target = doc.definitions?.[name];
    if (target?.example !== undefined) return target.example;
    return exampleFor(target, doc, depth + 1);
  }
  if (schema.type === 'array') return [exampleFor(schema.items, doc, depth + 1)].filter((x) => x !== null);
  if (schema.type === 'object' || schema.properties) {
    const out = {};
    // Required members first so the shape reads like the documentation.
    const names = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    for (const name of [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))]) {
      const prop = schema.properties[name];
      if (prop.readOnly) continue;
      if (!required.has(name) && depth > 1) continue;
      out[name] = exampleFor(prop, doc, depth + 1);
    }
    return out;
  }
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'date-time') return '2026-01-01T15:00:00+01:00';
      return '';
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    default: return null;
  }
}

function refLabel(schema) {
  if (!schema) return '';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array' && schema.items?.$ref) return `${schema.items.$ref.split('/').pop()}[]`;
  return schema.type ?? '';
}

function extractScopes(description) {
  const quoted = /scopes?:\s*'([^']+)'/i.exec(description);
  const bare = /scopes?:\s*([a-z0-9_.,\s-]+)/i.exec(description);
  const match = quoted ?? bare;
  if (!match) return [];
  return match[1].split(',').map((s) => s.trim().replace(/[^a-z0-9_.-]/gi, '')).filter(Boolean);
}

/* -------------------------------------------------------------- helpers */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of children) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

const text = (value) => document.createTextNode(value);

/** The specs carry a little HTML in their descriptions; keep only links and breaks. */
function sanitize(html) {
  return String(html)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/&lt;b&gt;/gi, '<strong>')
    .replace(/&lt;\/b&gt;/gi, '</strong>')
    .replace(/'([a-z0-9_.,\s-]+)'/gi, '<code>$1</code>');
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

boot();
