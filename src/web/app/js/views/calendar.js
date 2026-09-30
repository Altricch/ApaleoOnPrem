import { h, chip, select, input, field, toast } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate, cached } from '../state.js';
import {
  addDays, diffDays, eachDay, isWeekend, dayName, parseDate, guestName, money, label, tone, date,
} from '../format.js';
import { openReservation } from './reservation-detail.js';

/**
 * The room plan: units down the side, dates across the top, stays drawn as
 * bars. This is the view a front desk lives in, so it has to be correct about
 * two things — a stay occupies the nights from arrival up to but not including
 * departure, and unassigned reservations still consume inventory.
 */

const view = { days: 21, from: null };

export async function render({ context }) {
  if (!view.from) view.from = addDays(businessDate(), -1);
  const propertyId = state.property.id;
  const from = view.from;
  const to = addDays(from, view.days);

  const [groups, units, reservations, maintenances, blocks, availability] = await Promise.all([
    cached('unitGroups', () => api.unitGroups(propertyId)),
    cached('units', () => api.units({ propertyId })),
    api.reservations({
      propertyIds: propertyId,
      dateFilter: 'Stay',
      from,
      to: addDays(to, -1),
      status: ['Confirmed', 'InHouse', 'CheckedOut'],
      pageSize: 500,
    }),
    api.maintenances({ propertyId, from, to }),
    api.blocks({ propertyIds: propertyId, from, to }),
    api.availability(propertyId, from, to),
  ]);

  const days = eachDay(from, to);
  const container = h('section.card');
  container.append(
    toolbar(context, from, to),
    h('div.calendar-wrap', [
      buildGrid({ days, groups: groups.items, units: units.items, reservations: reservations.items, maintenances: maintenances.items, availability: availability.items, context }),
    ]),
    legend(blocks.items.length),
  );
  return container;
}

function toolbar(context, from, to) {
  const jump = (days) => { view.from = addDays(view.from, days); context.reload(); };
  return h('div.toolbar', [
    h('div.row.tight', [
      h('button.btn.sm', { onclick: () => jump(-view.days) }, '«'),
      h('button.btn.sm', { onclick: () => jump(-7) }, '‹ Week'),
      h('button.btn.sm', {
        onclick: () => { view.from = addDays(businessDate(), -1); context.reload(); },
      }, 'Today'),
      h('button.btn.sm', { onclick: () => jump(7) }, 'Week ›'),
      h('button.btn.sm', { onclick: () => jump(view.days) }, '»'),
    ]),
    field('Start', input({
      type: 'date', value: from,
      onchange: (e) => { view.from = e.target.value; context.reload(); },
    })),
    field('Span', select(
      [{ value: '14', label: '2 weeks' }, { value: '21', label: '3 weeks' }, { value: '31', label: 'A month' }, { value: '45', label: '6 weeks' }],
      { value: String(view.days), onchange: (e) => { view.days = Number(e.target.value); context.reload(); } },
    )),
    h('div.spacer'),
    h('span', { style: { fontSize: '12.5px', color: 'var(--muted)' } },
      `${date(from)} – ${date(addDays(to, -1))}`),
  ]);
}

function buildGrid({ days, groups, units, reservations, maintenances, availability, context }) {
  const today = businessDate();

  // Index stays by the unit they occupy; anything unassigned is collected
  // per unit group and drawn in its own row.
  const byUnit = new Map();
  const unassignedByGroup = new Map();
  for (const r of reservations) {
    if (r.unit?.id) {
      if (!byUnit.has(r.unit.id)) byUnit.set(r.unit.id, []);
      byUnit.get(r.unit.id).push(r);
    } else {
      const key = r.unitGroup?.id ?? 'other';
      if (!unassignedByGroup.has(key)) unassignedByGroup.set(key, []);
      unassignedByGroup.get(key).push(r);
    }
  }

  const maintenanceByUnit = new Map();
  for (const m of maintenances) {
    if (!maintenanceByUnit.has(m.unit.id)) maintenanceByUnit.set(m.unit.id, []);
    maintenanceByUnit.get(m.unit.id).push(m);
  }

  const availabilityByDate = new Map();
  for (const slice of availability) {
    const day = String(slice.from).slice(0, 10);
    const perGroup = new Map();
    for (const entry of slice.unitGroups ?? []) perGroup.set(entry.unitGroup.id, entry);
    availabilityByDate.set(day, perGroup);
  }

  const head = h('thead', [
    h('tr', [
      h('th.rowhead.corner', 'Room'),
      ...days.map((day) => h(`th${day === today ? '.today' : isWeekend(day) ? '.weekend' : ''}`, [
        h('span.dow', dayName(day)),
        h('span.dom', String(parseDate(day).getDate())),
      ])),
    ]),
  ]);

  const rows = [];
  const sortedGroups = [...groups].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.code.localeCompare(b.code));

  for (const group of sortedGroups) {
    // Group header row carries the availability for each night.
    rows.push(h('tr.group-row', [
      h('th.rowhead', `${group.name} · ${group.code}`),
      ...days.map((day) => {
        const entry = availabilityByDate.get(day)?.get(group.id);
        const free = entry?.availableCount ?? 0;
        return h(`td${free === 0 ? '.none' : ''}`, { title: entry
          ? `${entry.soldCount} sold · ${entry.sellableCount} sellable · ${entry.houseCount} in house`
          : '' }, String(free));
      }),
    ]));

    const groupUnits = units
      .filter((u) => u.unitGroup?.id === group.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const unit of groupUnits) {
      rows.push(unitRow(unit, days, byUnit.get(unit.id) ?? [], maintenanceByUnit.get(unit.id) ?? [], context));
    }

    const unassigned = unassignedByGroup.get(group.id) ?? [];
    if (unassigned.length) {
      rows.push(unassignedRow(group, days, unassigned, context));
    }
  }

  const orphans = units.filter((u) => !u.unitGroup);
  for (const unit of orphans) {
    rows.push(unitRow(unit, days, byUnit.get(unit.id) ?? [], maintenanceByUnit.get(unit.id) ?? [], context));
  }

  return h('table.calendar', [head, h('tbody', rows)]);
}

function unitRow(unit, days, stays, maintenances, context) {
  const cells = days.map((day) => {
    const blocked = maintenances.some((m) => inRange(day, m.from, m.to));
    const cell = h(`td.cell${isWeekend(day) ? '.weekend' : ''}${blocked ? '.oos' : ''}`, {
      'data-day': day,
      title: blocked ? maintenances.find((m) => inRange(day, m.from, m.to))?.type : '',
    });
    return cell;
  });

  const row = h('tr', [
    h('th.rowhead', [
      h('span', { style: { fontWeight: 600 } }, unit.name),
      h('span', { style: { color: 'var(--muted)', marginLeft: '8px', fontSize: '11px' } },
        unit.status?.condition === 'Dirty' ? '● dirty' : ''),
    ]),
    ...cells,
  ]);

  placeBars(cells, days, stays, context);
  return row;
}

function unassignedRow(group, days, stays, context) {
  const cells = days.map((day) => h(`td.cell${isWeekend(day) ? '.weekend' : ''}`));
  const row = h('tr', [
    h('th.rowhead', [
      h('span', { style: { color: 'var(--warn)', fontWeight: 600 } }, 'Unassigned'),
      h('span', { style: { color: 'var(--muted)', marginLeft: '6px', fontSize: '11px' } }, `${stays.length}`),
    ]),
    ...cells,
  ]);
  placeBars(cells, days, stays, context);
  return row;
}

/**
 * Lay stays into the row. A stay spanning several visible nights is drawn as
 * one bar anchored on its first visible night and widened across the rest,
 * which is why the cells need to be positioned rather than filled.
 */
function placeBars(cells, days, stays, context) {
  const windowStart = days[0];
  const windowEnd = addDays(days[days.length - 1], 1);

  for (const stay of stays) {
    const arrival = String(stay.arrival).slice(0, 10);
    const departure = String(stay.departure).slice(0, 10);
    const start = arrival < windowStart ? windowStart : arrival;
    const end = departure > windowEnd ? windowEnd : departure;
    const span = diffDays(start, end);
    if (span <= 0) continue;

    const index = diffDays(windowStart, start);
    const cell = cells[index];
    if (!cell) continue;

    const continuesLeft = arrival < windowStart;
    const continuesRight = departure > windowEnd;

    const bar = h(`div.stay.${stay.status}`, {
      style: {
        width: `calc(${span * 100}% + ${(span - 1) * 1}px - 2px)`,
        borderTopLeftRadius: continuesLeft ? '0' : null,
        borderBottomLeftRadius: continuesLeft ? '0' : null,
        borderTopRightRadius: continuesRight ? '0' : null,
        borderBottomRightRadius: continuesRight ? '0' : null,
        zIndex: '1',
      },
      title: [
        guestName(stay.primaryGuest),
        `${date(stay.arrival)} → ${date(stay.departure)}`,
        `${label(stay.status)} · ${money(stay.totalGrossAmount)}`,
        stay.balance?.amount ? `Balance ${money(stay.balance)}` : null,
      ].filter(Boolean).join('\n'),
      onclick: (event) => {
        event.stopPropagation();
        openReservation(stay.id, context);
      },
    }, guestName(stay.primaryGuest));

    cell.append(bar);
  }
}

function inRange(day, from, to) {
  return day >= String(from).slice(0, 10) && day < String(to).slice(0, 10);
}

function legend(blockCount) {
  const swatch = (cls, text) => h('span', [
    h('i', { style: { background: `var(--${cls})` } }), text,
  ]);
  return h('div.legend', [
    swatch('accent-soft', 'Confirmed'),
    swatch('ok-soft', 'In house'),
    swatch('line-2', 'Checked out'),
    swatch('bad-soft', 'No show'),
    h('span', [h('i', { style: { background: 'repeating-linear-gradient(135deg, var(--line), var(--line) 3px, transparent 3px, transparent 6px)' } }), 'Out of order']),
    h('div.spacer'),
    h('span', 'Numbers on the group row are rooms still available that night.'),
    blockCount ? chip(`${blockCount} block${blockCount === 1 ? '' : 's'} in range`, 'violet') : null,
  ]);
}

export { toast };
