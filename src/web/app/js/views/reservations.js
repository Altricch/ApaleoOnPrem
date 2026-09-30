import { mount, h, card, chip, table, input, select, field, emptyState } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate } from '../state.js';
import { money, date, guestName, label, tone, addDays, nights } from '../format.js';
import { openReservation } from './reservation-detail.js';
import { openNewBooking } from './new-booking.js';

/**
 * The reservations list. Filters map one-to-one onto the API's own query
 * parameters, so what you see here is exactly what a client would get.
 */

const STATUSES = ['Confirmed', 'InHouse', 'CheckedOut', 'NoShow', 'Canceled'];
const DATE_FILTERS = [
  { value: 'Arrival', label: 'Arrival' },
  { value: 'Departure', label: 'Departure' },
  { value: 'Stay', label: 'Staying' },
  { value: 'Creation', label: 'Booked on' },
  { value: 'Modification', label: 'Modified' },
];

const filters = {
  dateFilter: 'Arrival',
  from: null,
  to: null,
  status: [],
  textSearch: '',
  sort: 'arrival:asc',
  pageNumber: 1,
};

export async function render({ context }) {
  if (!filters.from) {
    filters.from = businessDate();
    filters.to = addDays(businessDate(), 30);
  }

  const container = h('section.card');
  const body = h('div.body.flush');

  const rerender = async () => {
    mount(body, h('div.skeleton', { style: { height: '240px', margin: '16px' } }));
    const { items, count } = await api.reservations({
      propertyIds: state.property.id,
      dateFilter: filters.dateFilter,
      from: filters.from,
      to: filters.to,
      status: filters.status.length ? filters.status : undefined,
      textSearch: filters.textSearch || undefined,
      sort: filters.sort,
      pageNumber: filters.pageNumber,
      pageSize: 50,
    });
    mount(body, resultTable(items, context, rerender), pager(count, rerender));
    countChip.textContent = `${count} reservation${count === 1 ? '' : 's'}`;
  };

  const countChip = h('span.chip', '…');

  container.append(
    h('header', [
      h('h2', 'Reservations'),
      countChip,
      h('div.spacer'),
      h('button.btn.primary', { onclick: () => openNewBooking(context) }, '+ New booking'),
    ]),
    toolbar(rerender),
    body,
  );

  await rerender();
  return container;
}

function toolbar(rerender) {
  const apply = () => { filters.pageNumber = 1; rerender(); };

  const dateFilter = select(DATE_FILTERS, {
    value: filters.dateFilter,
    onchange: (e) => { filters.dateFilter = e.target.value; apply(); },
  });
  const from = input({
    type: 'date', value: filters.from,
    onchange: (e) => { filters.from = e.target.value; apply(); },
  });
  const to = input({
    type: 'date', value: filters.to,
    onchange: (e) => { filters.to = e.target.value; apply(); },
  });
  const search = input({
    type: 'search', placeholder: 'Name, reservation id, external code…', value: filters.textSearch,
  });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { filters.textSearch = search.value.trim(); apply(); }, 250);
  });

  const statusChips = h('div.row.tight', STATUSES.map((status) => {
    const on = filters.status.includes(status);
    return h(`button.chip${on ? `.${tone(status) || 'accent'}` : ''}`, {
      type: 'button',
      style: { cursor: 'pointer', border: '1px solid var(--line)' },
      onclick: (event) => {
        const index = filters.status.indexOf(status);
        if (index >= 0) filters.status.splice(index, 1);
        else filters.status.push(status);
        event.currentTarget.className = `chip${filters.status.includes(status) ? ` ${tone(status) || 'accent'}` : ''}`;
        apply();
      },
    }, label(status));
  }));

  return h('div.toolbar', [
    field('Date filter', dateFilter),
    field('From', from),
    field('To', to),
    h('div.field.grow', [h('label', 'Search'), search]),
    h('div.field', [h('label', 'Status'), statusChips]),
    h('div.spacer'),
    h('div.field', [
      h('label', 'Sort'),
      select([
        { value: 'arrival:asc', label: 'Arrival ↑' },
        { value: 'arrival:desc', label: 'Arrival ↓' },
        { value: 'created:desc', label: 'Newest first' },
        { value: 'lastName:asc', label: 'Guest A–Z' },
      ], { value: filters.sort, onchange: (e) => { filters.sort = e.target.value; apply(); } }),
    ]),
  ]);
}

function resultTable(items, context, rerender) {
  return table([
    {
      label: 'Guest',
      render: (r) => h('div', [
        h('div', { style: { fontWeight: 550 } }, guestName(r.primaryGuest)),
        h('div', { style: { fontSize: '11.5px', color: 'var(--muted)' } }, r.id),
      ]),
    },
    { label: 'Status', render: (r) => chip(label(r.status), tone(r.status)) },
    {
      label: 'Stay',
      render: (r) => h('div', [
        h('div', `${date(r.arrival, { day: '2-digit', month: 'short' })} → ${date(r.departure, { day: '2-digit', month: 'short' })}`),
        h('div', { style: { fontSize: '11.5px', color: 'var(--muted)' } }, nights(r.arrival, r.departure)),
      ]),
    },
    { label: 'Room', render: (r) => r.unit ? h('span.mono', r.unit.name) : h('span', { style: { color: 'var(--muted)' } }, '—') },
    {
      label: 'Unit group',
      render: (r) => h('div', [
        r.unitGroup?.name ?? '—',
        h('div', { style: { fontSize: '11.5px', color: 'var(--muted)' } }, r.ratePlan?.code ?? ''),
      ]),
    },
    { label: 'Channel', render: (r) => r.channelCode },
    { label: 'Total', num: true, render: (r) => money(r.totalGrossAmount) },
    {
      label: 'Balance',
      num: true,
      render: (r) => h('span', { style: { color: r.balance?.amount > 0 ? 'var(--bad)' : 'var(--muted)' } }, money(r.balance)),
    },
  ], items, {
    onRow: (r) => openReservation(r.id, { ...context, reload: rerender }),
    empty: {
      title: 'No reservations match these filters',
      detail: 'Widen the date range, or clear the status chips.',
    },
  });
}

function pager(count, rerender) {
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  if (pages <= 1) return null;
  return h('div.row', { style: { padding: '12px 16px', borderTop: '1px solid var(--line)' } }, [
    h('button.btn.sm', {
      disabled: filters.pageNumber <= 1,
      onclick: () => { filters.pageNumber -= 1; rerender(); },
    }, '← Previous'),
    h('span', { style: { fontSize: '12.5px', color: 'var(--muted)' } }, `Page ${filters.pageNumber} of ${pages}`),
    h('button.btn.sm', {
      disabled: filters.pageNumber >= pages,
      onclick: () => { filters.pageNumber += 1; rerender(); },
    }, 'Next →'),
  ]);
}

export { emptyState, card };
