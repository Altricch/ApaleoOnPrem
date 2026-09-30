import { h, card, chip, table, emptyState, confirmDialog } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate } from '../state.js';
import {
  money, percent, number, date, guestName, label, tone, addDays, nights,
} from '../format.js';
import { openReservation } from './reservation-detail.js';

/**
 * The front-desk home screen: how full the house is today, who is arriving
 * and leaving, and the one operation that has to happen every night.
 */
export async function render({ context }) {
  const propertyId = state.property.id;
  const today = businessDate();
  const tomorrow = addDays(today, 1);

  const [availability, arrivals, departures, inHouse, performance, audits] = await Promise.all([
    api.availability(propertyId, today, tomorrow),
    api.reservations({ propertyIds: propertyId, dateFilter: 'Arrival', from: today, to: today, status: ['Confirmed', 'InHouse'] }),
    api.reservations({ propertyIds: propertyId, dateFilter: 'Departure', from: today, to: today, status: ['InHouse', 'CheckedOut'] }),
    api.reservations({ propertyIds: propertyId, status: 'InHouse' }),
    api.performance(propertyId, today, today).catch(() => null),
    api.nightAuditLogs(propertyId),
  ]);

  const slice = availability.items[0]?.property ?? {
    houseCount: 0, soldCount: 0, sellableCount: 0, occupancy: 0,
    maintenance: { outOfService: 0, outOfOrder: 0, outOfInventory: 0 },
  };

  const pendingArrivals = arrivals.items.filter((r) => r.status === 'Confirmed');
  const pendingDepartures = departures.items.filter((r) => r.status === 'InHouse');
  const unassigned = pendingArrivals.filter((r) => !r.unit);
  const lastAudit = audits.items[0];

  return h('div.grid', [
    statRow(slice, performance, inHouse.count),
    unassigned.length ? unassignedNotice(unassigned, context) : null,

    h('div.grid.cols-2', [
      arrivalsCard(arrivals.items, pendingArrivals.length, context),
      departuresCard(departures.items, pendingDepartures.length, context),
    ]),

    h('div.grid.cols-2', [
      inHouseCard(inHouse.items, context),
      nightAuditCard(lastAudit, today, pendingArrivals.length, pendingDepartures.length, context),
    ]),
  ]);
}

function statRow(slice, performance, inHouseCount) {
  const occupancy = slice.houseCount ? (slice.soldCount / slice.houseCount) * 100 : 0;
  const outOfOrder = slice.maintenance.outOfService + slice.maintenance.outOfOrder;

  return h('div.grid.cols-4', [
    h('div.card.stat', [
      h('div.label', 'Occupancy today'),
      h('div.value', percent(occupancy)),
      h('div.sub', `${slice.soldCount} of ${slice.houseCount} rooms sold`),
      h('div.bar', [h('i', { style: { width: `${Math.min(100, occupancy)}%` } })]),
    ]),
    h('div.card.stat', [
      h('div.label', 'Available tonight'),
      h('div.value', number(slice.sellableCount)),
      h('div.sub', outOfOrder ? `${outOfOrder} room${outOfOrder === 1 ? '' : 's'} out of order` : 'All rooms sellable'),
    ]),
    h('div.card.stat', [
      h('div.label', 'In house'),
      h('div.value', number(inHouseCount)),
      h('div.sub', 'Guests currently staying'),
    ]),
    h('div.card.stat', [
      h('div.label', 'ADR today'),
      h('div.value', performance ? money(performance.grossAdr) : '—'),
      h('div.sub', performance ? `RevPAR ${money(performance.revPar)}` : 'No revenue posted yet'),
    ]),
  ]);
}

function unassignedNotice(unassigned, context) {
  return h('div.card', { style: { borderLeft: '3px solid var(--warn)' } }, [
    h('div.body', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, [
      h('div', [
        h('strong', `${unassigned.length} arrival${unassigned.length === 1 ? '' : 's'} without a room`),
        h('div', { style: { color: 'var(--muted)', fontSize: '12.5px', marginTop: '2px' } },
          'A room has to be assigned for the whole stay before a guest can be checked in.'),
      ]),
      h('div.spacer'),
      h('button.btn.primary', {
        onclick: async () => {
          let assigned = 0;
          for (const reservation of unassigned) {
            const ok = await context.attempt(
              api.reservationAction(reservation.id, 'assign-unit'),
              { failure: `Could not assign a room to ${reservation.id}` },
            );
            if (ok) assigned += 1;
          }
          if (assigned) context.toast(`Assigned ${assigned} room${assigned === 1 ? '' : 's'}`, null, 'ok');
          context.reload();
        },
      }, 'Auto-assign all'),
    ]),
  ]);
}

function arrivalsCard(items, pending, context) {
  return card(
    'Arrivals today',
    h('div', { style: { margin: '-16px' } }, [
      table([
        { label: 'Guest', render: (r) => h('div', [
          h('div', { style: { fontWeight: 550 } }, guestName(r.primaryGuest)),
          h('div', { style: { fontSize: '11.5px', color: 'var(--muted)' } },
            `${r.unitGroup?.name ?? ''} · ${nights(r.arrival, r.departure)}`),
        ]) },
        { label: 'Room', render: (r) => r.unit ? h('span.mono', r.unit.name) : chip('unassigned', 'warn') },
        { label: 'Status', render: (r) => chip(label(r.status), tone(r.status)) },
        { label: 'Amount', num: true, render: (r) => money(r.totalGrossAmount) },
      ], items, {
        onRow: (r) => openReservation(r.id, context),
        empty: { title: 'No arrivals today', detail: 'Nothing is due to check in on this business date.' },
      }),
    ]),
    [chip(`${pending} to check in`, pending ? 'accent' : '')],
  );
}

function departuresCard(items, pending, context) {
  return card(
    'Departures today',
    h('div', { style: { margin: '-16px' } }, [
      table([
        { label: 'Guest', render: (r) => h('div', [
          h('div', { style: { fontWeight: 550 } }, guestName(r.primaryGuest)),
          h('div', { style: { fontSize: '11.5px', color: 'var(--muted)' } }, r.unitGroup?.name ?? ''),
        ]) },
        { label: 'Room', render: (r) => r.unit ? h('span.mono', r.unit.name) : '—' },
        { label: 'Status', render: (r) => chip(label(r.status), tone(r.status)) },
        { label: 'Balance', num: true, render: (r) => h('span', {
          style: { color: r.balance?.amount > 0 ? 'var(--bad)' : 'var(--muted)' },
        }, money(r.balance)) },
      ], items, {
        onRow: (r) => openReservation(r.id, context),
        empty: { title: 'No departures today', detail: 'Nobody is due to check out on this business date.' },
      }),
    ]),
    [chip(`${pending} to check out`, pending ? 'accent' : '')],
  );
}

function inHouseCard(items, context) {
  const owing = items.filter((r) => (r.balance?.amount ?? 0) > 0);
  return card(
    'In house',
    h('div', { style: { margin: '-16px' } }, [
      table([
        { label: 'Room', render: (r) => h('span.mono', r.unit?.name ?? '—') },
        { label: 'Guest', render: (r) => guestName(r.primaryGuest) },
        { label: 'Departs', render: (r) => date(r.departure) },
        { label: 'Balance', num: true, render: (r) => h('span', {
          style: { color: r.balance?.amount > 0 ? 'var(--bad)' : 'var(--muted)' },
        }, money(r.balance)) },
      ], items.slice(0, 12), {
        onRow: (r) => openReservation(r.id, context),
        empty: { title: 'The house is empty', detail: 'No reservation is currently checked in.' },
      }),
    ]),
    [owing.length ? chip(`${owing.length} with an open balance`, 'warn') : null],
  );
}

function nightAuditCard(lastAudit, today, arrivalsPending, departuresPending, context) {
  const body = [
    h('dl.kv', [
      h('dt', 'Business date'), h('dd', h('strong', date(today))),
      h('dt', 'Last run'), h('dd', lastAudit ? `${date(lastAudit.businessDate)} · ${lastAudit.status}` : 'Never'),
      h('dt', 'Still to arrive'), h('dd', arrivalsPending
        ? h('span', { style: { color: 'var(--warn)' } }, `${arrivalsPending} — these become no-shows`)
        : 'None'),
      h('dt', 'Still to depart'), h('dd', departuresPending
        ? h('span', { style: { color: 'var(--warn)' } }, `${departuresPending} — will be flagged`)
        : 'None'),
    ]),
    h('p', { style: { color: 'var(--muted)', fontSize: '12.5px', margin: '12px 0 0' } },
      'The night audit posts the closing day for everyone in house, turns unclaimed arrivals into no-shows, '
      + 'and moves the property to the next business date.'),
    h('div.row', { style: { marginTop: '14px' } }, [
      h('button.btn.primary', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Run the night audit for ${date(today)}?`,
            message: arrivalsPending
              ? `${arrivalsPending} reservation(s) that have not arrived will be set to no-show, and the property moves to ${date(addDays(today, 1))}.`
              : `The property will move to ${date(addDays(today, 1))}.`,
            confirmLabel: 'Run night audit',
          });
          if (!ok) return;
          const done = await context.attempt(api.nightAudit(state.property.id), {
            success: 'Night audit complete',
            failure: 'Night audit failed',
          });
          if (done) {
            await context.refreshProperty();
            context.reload();
          }
        },
      }, 'Run night audit'),
      h('button.btn', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Run without marking no-shows?',
            message: 'Reservations that have not arrived stay confirmed and roll into the next day.',
            confirmLabel: 'Run',
          });
          if (!ok) return;
          const done = await context.attempt(api.nightAudit(state.property.id, false), {
            success: 'Night audit complete',
            failure: 'Night audit failed',
          });
          if (done) {
            await context.refreshProperty();
            context.reload();
          }
        },
      }, 'Keep arrivals open'),
    ]),
  ];
  return card('Night audit', body);
}

export { emptyState };
