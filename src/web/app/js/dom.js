/** Tiny DOM helpers. Everything in the app is built with these. */

/**
 * `h('div.card', { onclick }, [child, 'text'])`
 * The tag accepts `tag.class.class#id` shorthand.
 */
export function h(spec, attrs = null, children = []) {
  const [head, ...classes] = String(spec).split('.');
  const [tag, id] = head.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (attrs && (Array.isArray(attrs) || typeof attrs === 'string' || attrs instanceof Node)) {
    children = attrs;
    attrs = null;
  }
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

/** Replace a node's contents. Unlike `replaceChildren`, nulls are dropped. */
export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/* ------------------------------------------------------------ overlays */

let openOverlay = null;

/** Close whatever drawer or modal is open. */
export function closeOverlay() {
  if (!openOverlay) return;
  openOverlay.forEach((n) => n.remove());
  openOverlay = null;
  document.removeEventListener('keydown', onEscape);
}

function onEscape(event) {
  if (event.key === 'Escape') closeOverlay();
}

function present(panel) {
  closeOverlay();
  const scrim = h('div.scrim', { onclick: closeOverlay });
  document.body.append(scrim, panel);
  openOverlay = [scrim, panel];
  document.addEventListener('keydown', onEscape);
  return panel;
}

/** A right-hand detail panel. `render` receives a refresh callback. */
export function drawer({ title, subtitle, body, footer }) {
  return present(h('div.drawer', { role: 'dialog', 'aria-modal': 'true' }, [
    h('header', [
      h('div', [
        h('h2', title),
        subtitle ? h('div.subtitle', { style: { fontSize: '12px', color: 'var(--muted)' } }, subtitle) : null,
      ]),
      h('div.spacer'),
      h('button.btn.ghost', { onclick: closeOverlay, title: 'Close' }, '✕'),
    ]),
    h('div.body', body),
    footer ? h('footer', footer) : null,
  ]));
}

/** A centred dialog. Returns the element so callers can query its inputs. */
export function modal({ title, body, footer }) {
  return present(h('div.modal', { role: 'dialog', 'aria-modal': 'true' }, [
    h('div.sheet', [
      h('header', [h('h2', title), h('div.spacer'), h('button.btn.ghost', { onclick: closeOverlay }, '✕')]),
      h('div.body', body),
      footer ? h('footer', footer) : null,
    ]),
  ]));
}

/** Ask for confirmation. Resolves true when the caller confirms. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeOverlay();
      resolve(value);
    };
    modal({
      title,
      body: [h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, message)],
      footer: [
        h('button.btn', { onclick: () => finish(false) }, 'Cancel'),
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => finish(true) }, confirmLabel),
      ],
    });
    // Closing with the scrim or Escape counts as a decline.
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.modal')) {
        observer.disconnect();
        finish(false);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

/* -------------------------------------------------------------- toasts */

export function toast(title, detail, kind = '') {
  const node = h(`div.toast.${kind}`, [
    h('div.title', title),
    detail ? h('div.detail', detail) : null,
  ]);
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, kind === 'bad' ? 7000 : 3600);
}

/* ------------------------------------------------------------ building */

export function field(label, control, note) {
  return h('div.field', [h('label', label), control, note ? h('div.note', note) : null]);
}

export function input(attrs = {}) {
  return h('input', { type: 'text', ...attrs });
}

export function select(options, attrs = {}) {
  const node = h('select', attrs);
  for (const option of options) {
    const { value, label, selected } = typeof option === 'string'
      ? { value: option, label: option }
      : option;
    node.append(h('option', { value, selected: selected || undefined }, label));
  }
  if (attrs.value !== undefined) node.value = attrs.value;
  return node;
}

export function table(columns, rows, { onRow, empty } = {}) {
  if (!rows.length) {
    return emptyState(empty?.title ?? 'Nothing here yet', empty?.detail);
  }
  return h('table.data', [
    h('thead', [h('tr', columns.map((c) => h(`th${c.num ? '.num' : ''}`, { style: c.width ? { width: c.width } : null }, c.label)))]),
    h('tbody', rows.map((row) => {
      const tr = h(`tr${onRow ? '.clickable' : ''}`, onRow ? { onclick: () => onRow(row) } : null,
        columns.map((c) => h(`td${c.num ? '.num' : ''}${c.mono ? '.mono' : ''}`, c.render(row))));
      return tr;
    })),
  ]);
}

export function emptyState(title, detail, glyph = '◌') {
  return h('div.empty', [
    h('div.big', glyph),
    h('p', title),
    detail ? h('p.sub', detail) : null,
  ]);
}

export function skeleton(height = 180) {
  return h('div.skeleton', { style: { height: `${height}px` } });
}

export function card(title, body, actions) {
  return h('section.card', [
    title ? h('header', [h('h2', title), h('div.spacer'), ...(actions ?? [])]) : null,
    h('div.body', body),
  ]);
}

export function chip(label, kind = '') {
  return h(`span.chip${kind ? `.${kind}` : ''}`, label);
}
