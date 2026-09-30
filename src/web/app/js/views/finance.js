import { mount, h, chip, table, input, select, field, emptyState, confirmDialog } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { money, date, label, tone, guestName, debitorName } from '../format.js';
import { openReservation } from './reservation-detail.js';

/**
 * Folios: the guest accounts money actually sits on. From here a supervisor
 * can see what is open, what is still owed, and turn a settled folio into an
 * invoice.
 */

const filters = { status: '', balance: '', textSearch: '' };

export async function render({ context }) {
  const container = h('section.card');
  const body = h('div.body.flush');
  const countChip = h('span.chip', '…');

  const rerender = async () => {
    mount(body, h('div.skeleton', { style: { height: '240px', margin: '16px' } }));
    const { items, count } = await api.folios({
      propertyIds: state.property.id,
      status: filters.status || undefined,
      balanceFilter: filters.balance || undefined,
      textSearch: filters.textSearch || undefined,
      pageSize: 100,
    });
    countChip.textContent = `${count} folio${count === 1 ? '' : 's'}`;
    mount(body, folioTable(items, context, rerender), summary(items));
  };

  container.append(
    h('header', [h('h2', 'Folios'), countChip]),
    toolbar(rerender),
    body,
  );
  await rerender();
  return container;
}

function toolbar(rerender) {
  const search = input({ type: 'search', placeholder: 'Folio id, guest, reservation…' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { filters.textSearch = search.value.trim(); rerender(); }, 250);
  });
  return h('div.toolbar', [
    field('Status', select([
      { value: '', label: 'All' }, { value: 'Open', label: 'Open' }, { value: 'Closed', label: 'Closed' },
    ], { value: filters.status, onchange: (e) => { filters.status = e.target.value; rerender(); } })),
    field('Balance', select([
      { value: '', label: 'Any' },
      { value: 'Positive', label: 'Owing' },
      { value: 'Zero', label: 'Settled' },
      { value: 'Negative', label: 'In credit' },
    ], { value: filters.balance, onchange: (e) => { filters.balance = e.target.value; rerender(); } })),
    h('div.field.grow', [h('label', 'Search'), search]),
  ]);
}

function folioTable(items, context, rerender) {
  return table([
    { label: 'Folio', mono: true, render: (f) => f.id },
    {
      label: 'Debitor',
      render: (f) => h('div', [
        h('div', debitorName(f.debitor)),
        f.debitor?.company?.name ? h('div', { style: { fontSize: '11.5px', color: 'var(--muted)' } }, f.debitor.company.name) : null,
      ]),
    },
    { label: 'Type', render: (f) => chip(f.type, f.type === 'Guest' ? 'accent' : 'violet') },
    { label: 'Status', render: (f) => chip(label(f.status), tone(f.status)) },
    { label: 'Created', render: (f) => date(f.created) },
    {
      label: 'Balance',
      num: true,
      render: (f) => h('strong', { style: { color: f.balance.amount > 0 ? 'var(--bad)' : f.balance.amount < 0 ? 'var(--ok)' : 'inherit' } },
        money(f.balance)),
    },
    {
      label: '',
      render: (f) => h('div.row.tight', { style: { justifyContent: 'flex-end' } }, [
        f.reservation
          ? h('button.btn.ghost.sm', {
            onclick: (e) => { e.stopPropagation(); openReservation(f.reservation.id, { ...context, reload: rerender }); },
          }, 'Reservation')
          : null,
        f.allowedActions?.includes('CreateInvoice')
          ? h('button.btn.sm', {
            onclick: async (e) => {
              e.stopPropagation();
              const ok = await confirmDialog({
                title: 'Create an invoice?',
                message: `The folio will be closed and an invoice raised over ${money(f.balance)} of charges.`,
                confirmLabel: 'Create invoice',
              });
              if (!ok) return;
              const created = await context.attempt(api.createInvoice(f.id), {
                success: 'Invoice created', failure: 'Could not create the invoice',
              });
              if (created) rerender();
            },
          }, 'Invoice')
          : null,
      ]),
    },
  ], items, {
    onRow: (f) => openFolio(f.id, context, rerender),
    empty: { title: 'No folios match', detail: 'Folios are created automatically with every reservation.' },
  });
}

function summary(items) {
  const currency = items[0]?.balance.currency ?? state.property.currencyCode;
  const owing = items.filter((f) => f.balance.amount > 0);
  const total = owing.reduce((sum, f) => sum + f.balance.amount, 0);
  if (!items.length) return null;
  return h('div.legend', [
    h('span', `${owing.length} folio${owing.length === 1 ? '' : 's'} with an open balance`),
    h('div.spacer'),
    h('strong', `Outstanding ${money({ amount: total, currency })}`),
  ]);
}

/** Opening a folio reuses the reservation drawer when there is one. */
async function openFolio(folioId, context, rerender) {
  const folio = await api.folio(folioId);
  if (folio.reservation) {
    openReservation(folio.reservation.id, { ...context, reload: rerender });
    return;
  }
  const { drawer } = await import('../dom.js');
  drawer({
    title: 'Folio',
    subtitle: folio.id,
    body: [
      h('section.card', [h('div.body', [
        h('dl.kv', [
          h('dt', 'Debitor'), h('dd', debitorName(folio.debitor)),
          h('dt', 'Type'), h('dd', folio.type),
          h('dt', 'Status'), h('dd', chip(label(folio.status), tone(folio.status))),
          h('dt', 'Balance'), h('dd', h('strong', money(folio.balance))),
        ]),
      ])]),
      h('section.card', [
        h('header', [h('h2', 'Charges')]),
        h('div.body', (folio.charges ?? []).length
          ? folio.charges.map((c) => h('div.folio-line', [
            h('div.date', date(c.serviceDate, { day: '2-digit', month: 'short' })),
            h('div', [c.name, h('div.meta', c.serviceType)]),
            h('div.amt', money({ amount: c.amount.grossAmount, currency: c.amount.currency })),
          ]))
          : h('div', { style: { color: 'var(--muted)', fontSize: '13px' } }, 'Nothing posted.')),
      ]),
    ],
  });
}

export { emptyState, guestName };
