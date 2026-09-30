/**
 * Application shell: session handling, the sidebar, and a hash router.
 *
 * Views are loaded lazily so the first paint after sign-in only pays for the
 * screen being shown.
 */
import { h, mount, clear, toast, closeOverlay, select, skeleton } from './dom.js';
import { api, session, ApiError } from './api.js';
import { state, loadProperties, selectProperty, refreshProperty, resolveName } from './state.js';
import { date } from './format.js';
import { loginView } from './views/login.js';

const root = document.getElementById('root');

const ROUTES = [
  { path: 'dashboard', title: 'Dashboard', icon: '◉', section: 'Operate', load: () => import('./views/dashboard.js') },
  { path: 'calendar', title: 'Room plan', icon: '▦', section: 'Operate', load: () => import('./views/calendar.js') },
  { path: 'reservations', title: 'Reservations', icon: '☰', section: 'Operate', load: () => import('./views/reservations.js') },
  { path: 'housekeeping', title: 'Housekeeping', icon: '✽', section: 'Operate', load: () => import('./views/housekeeping.js') },

  { path: 'chat', title: 'Assistant', icon: '✦', section: 'Assist', load: () => import('./views/chat.js') },

  { path: 'availability', title: 'Availability', icon: '▤', section: 'Revenue', load: () => import('./views/availability.js') },
  { path: 'rates', title: 'Rates', icon: '€', section: 'Revenue', load: () => import('./views/rates.js') },

  { path: 'finance', title: 'Folios', icon: '❑', section: 'Finance', load: () => import('./views/finance.js') },
  { path: 'invoices', title: 'Invoices', icon: '⎙', section: 'Finance', load: () => import('./views/invoices.js') },
  { path: 'reports', title: 'Reports', icon: '◪', section: 'Finance', load: () => import('./views/reports.js') },

  { path: 'property', title: 'Property', icon: '⌂', section: 'Setup', load: () => import('./views/property.js') },
];

/* --------------------------------------------------------------- boot */

async function boot() {
  mount(root, h('div.login', [h('div.login-card', [skeleton(220)])]));
  try {
    await loadProperties();
    renderShell();
  } catch (err) {
    // 401 simply means we are not signed in yet and anonymous access is off.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) showLogin();
    else {
      showLogin();
      toast('Could not reach the server', err.message, 'bad');
    }
  }
}

function showLogin() {
  session.clear();
  mount(root, loginView(async () => {
    await loadProperties();
    renderShell();
  }));
}

async function signOut() {
  session.clear();
  state.property = null;
  state.properties = [];
  state.cache.clear();
  window.location.hash = '';
  showLogin();
}

/* -------------------------------------------------------------- shell */

let outlet = null;
let titleEl = null;
let businessDateEl = null;

function renderShell() {
  if (!state.property) {
    mount(root, h('div.login', [h('div.login-card', [
      h('h1', { style: { fontSize: '16px', margin: '0 0 8px' } }, 'No properties'),
      h('p', { style: { color: 'var(--muted)', fontSize: '13px' } },
        'This installation has no properties yet. Run `npm run seed` to load the demo data.'),
    ])]));
    return;
  }

  titleEl = h('h1', 'Dashboard');
  businessDateEl = h('span.businessdate');
  outlet = h('main.content');

  mount(root, h('div.shell', [
    h('aside.sidebar', [
      h('div.sidebar-brand', [h('div.glyph', 'a'), h('strong', 'apaleo clone')]),
      propertySwitcher(),
      buildMenu(),
      h('div.sidebar-foot', [
        h('div.avatar', 'AC'),
        h('div.who', [
          h('strong', state.account?.name ?? 'Local account'),
          h('span', session.token ? 'signed in' : 'anonymous access'),
        ]),
        h('button.btn.ghost.sm', { onclick: signOut, title: 'Sign out' }, '⏻'),
      ]),
    ]),
    h('div.workspace', [
      h('header.topbar', [
        titleEl,
        h('div.spacer'),
        businessDateEl,
        h('a.btn.sm', { href: '/docs/', target: '_blank' }, 'API'),
      ]),
      outlet,
    ]),
  ]));

  paintBusinessDate();
  window.addEventListener('hashchange', route);
  route();
}

function propertySwitcher() {
  const picker = select(
    state.properties.map((p) => ({
      value: p.id,
      label: `${p.name} · ${p.id}`,
      selected: p.id === state.property.id,
    })),
    {
      onchange: async (event) => {
        await selectProperty(event.target.value);
        renderShell();
      },
    },
  );
  const property = state.properties.find((p) => p.id === state.property.id);
  return h('div.property-switch', [
    h('label', 'Property'),
    picker,
    h('div.meta', [
      h('span', property?.location ? `${property.location.city}, ${property.location.countryCode}` : ''),
      h('span.chip', { class: property?.status === 'Live' ? 'ok' : 'warn' }, property?.status ?? ''),
    ]),
  ]);
}

function buildMenu() {
  const nav = h('nav.menu');
  let section = null;
  for (const route of ROUTES) {
    if (route.section !== section) {
      section = route.section;
      nav.append(h('div.section', section));
    }
    nav.append(h('a', {
      href: `#/${route.path}`,
      'data-route': route.path,
    }, [h('span.ico', route.icon), route.title]));
  }
  return nav;
}

function paintBusinessDate() {
  mount(businessDateEl, [
    'Business date',
    h('b', date(state.property.businessDate)),
  ]);
}

/* ------------------------------------------------------------- router */

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, ...rest] = raw.split('/');
  return { path: path || 'dashboard', params: rest };
}

let currentToken = 0;

async function route() {
  closeOverlay();
  const { path, params } = parseHash();
  const match = ROUTES.find((r) => r.path === path) ?? ROUTES[0];

  for (const link of document.querySelectorAll('nav.menu a')) {
    link.classList.toggle('active', link.dataset.route === match.path);
  }
  titleEl.textContent = match.title;
  outlet.className = 'content';
  mount(outlet, h('div.grid', [skeleton(90), skeleton(260)]));

  const token = ++currentToken;
  try {
    const module = await match.load();
    if (token !== currentToken) return;
    const view = await module.render({ params, outlet, context });
    if (token !== currentToken) return;
    if (view) mount(outlet, view);
  } catch (err) {
    if (token !== currentToken) return;
    mount(outlet, errorPanel(err));
  }
}

function errorPanel(err) {
  const messages = err instanceof ApiError ? err.messages : [String(err?.message ?? err)];
  return h('section.card', [
    h('header', [h('h2', 'Something went wrong')]),
    h('div.body', [
      h('div.warnings', [
        h('div', { style: { fontWeight: 600 } }, err instanceof ApiError ? `${err.status} from the API` : 'Unexpected error'),
        h('ul', messages.map((m) => h('li', m))),
      ]),
      h('div', { style: { marginTop: '12px' } }, [
        h('button.btn', { onclick: route }, 'Retry'),
      ]),
    ]),
  ]);
}

/**
 * Handed to every view: navigation, refresh, and the shared plumbing a view
 * needs so it does not have to import the shell.
 */
export const context = {
  go(path) {
    window.location.hash = `#/${path}`;
  },
  reload: () => route(),
  async refreshProperty() {
    await refreshProperty();
    paintBusinessDate();
  },
  setTitle(text) {
    if (titleEl) titleEl.textContent = text;
  },
  /** Run an API call with a toast on failure; returns undefined when it fails. */
  async attempt(promise, { success, failure = 'Action failed' } = {}) {
    try {
      const result = await promise;
      if (success) toast(success, null, 'ok');
      return result ?? true;
    } catch (err) {
      const detail = err instanceof ApiError ? err.messages.join('\n') : String(err?.message ?? err);
      toast(failure, detail, 'bad');
      return undefined;
    }
  },
  toast,
  resolveName,
  api,
};

boot();
