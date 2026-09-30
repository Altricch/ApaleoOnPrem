import { h, card, input, field, select, modal, closeOverlay, emptyState } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate } from '../state.js';
import { addDays, eachDay, isWeekend, dayName, parseDate, percent, date } from '../format.js';

/**
 * The availability grid a revenue manager reads: one row per unit group,
 * one column per night, plus the property roll-up and the overbooking
 * allowance that lets a property sell past its physical inventory.
 */

const view = { from: null, days: 28, metric: 'availableCount' };

const METRICS = [
  { value: 'availableCount', label: 'Available' },
  { value: 'sellableCount', label: 'Sellable' },
  { value: 'soldCount', label: 'Sold' },
  { value: 'occupancy', label: 'Occupancy %' },
];

export async function render({ context }) {
  if (!view.from) view.from = businessDate();
  const from = view.from;
  const to = addDays(from, view.days);

  const { items } = await api.availability(state.property.id, from, to);
  if (!items.length) return emptyState('No availability data', 'Add unit groups and units to this property first.');

  const days = eachDay(from, to);
  const byDate = new Map(items.map((slice) => [String(slice.from).slice(0, 10), slice]));
  const groups = items[0].unitGroups.map((entry) => entry.unitGroup);

  return h('div.grid', [
    h('section.card', [
      h('header', [h('h2', 'Availability'), h('div.spacer'),
        h('div.segmented', METRICS.map((m) => h(`button${view.metric === m.value ? '.on' : ''}`, {
          onclick: () => { view.metric = m.value; context.reload(); },
        }, m.label)))]),
      toolbar(context, from, to),
      h('div.matrix-wrap', [grid(days, byDate, groups)]),
      h('div.legend', [
        h('span', 'Property row totals every unit group. Cells in red are sold out.'),
        h('div.spacer'),
        h('button.btn.sm', { onclick: () => overbookingDialog(groups, context) }, 'Set overbooking…'),
      ]),
    ]),
  ]);
}

function toolbar(context, from, to) {
  return h('div.toolbar', [
    h('div.row.tight', [
      h('button.btn.sm', { onclick: () => { view.from = addDays(view.from, -view.days); context.reload(); } }, '«'),
      h('button.btn.sm', { onclick: () => { view.from = businessDate(); context.reload(); } }, 'Today'),
      h('button.btn.sm', { onclick: () => { view.from = addDays(view.from, view.days); context.reload(); } }, '»'),
    ]),
    field('From', input({
      type: 'date', value: from, onchange: (e) => { view.from = e.target.value; context.reload(); },
    })),
    field('Nights', select(['14', '28', '60', '90'], {
      value: String(view.days), onchange: (e) => { view.days = Number(e.target.value); context.reload(); },
    })),
    h('div.spacer'),
    h('span', { style: { fontSize: '12.5px', color: 'var(--muted)' } }, `${date(from)} – ${date(addDays(to, -1))}`),
  ]);
}

function grid(days, byDate, groups) {
  const head = h('thead', [h('tr', [
    h('th.rowhead.corner', 'Unit group'),
    ...days.map((day) => h(`th${isWeekend(day) ? '.weekend' : ''}`, [
      h('div', { style: { fontSize: '9.5px', opacity: '.75' } }, dayName(day)),
      h('div', String(parseDate(day).getDate())),
    ])),
  ])]);

  const rows = groups.map((group) => h('tr', [
    h('th.rowhead', group.name ?? group.id),
    ...days.map((day) => {
      const entry = byDate.get(day)?.unitGroups.find((x) => x.unitGroup.id === group.id);
      return metricCell(entry, entry ? entry.houseCount : 0);
    }),
  ]));

  rows.push(h('tr', { style: { fontWeight: '600' } }, [
    h('th.rowhead', { style: { background: 'var(--panel-2)' } }, 'Property'),
    ...days.map((day) => {
      const slice = byDate.get(day)?.property;
      return metricCell(slice, slice?.houseCount ?? 0, true);
    }),
  ]));

  return h('table.matrix', [head, h('tbody', rows)]);
}

function metricCell(entry, houseCount, isTotal = false) {
  if (!entry) return h('td', '—');
  let value;
  let className = '';

  if (view.metric === 'occupancy') {
    const occupancy = houseCount ? (entry.soldCount / houseCount) * 100 : 0;
    value = percent(occupancy);
    if (occupancy >= 100) className = '.zero';
    else if (occupancy >= 85) className = '.low';
  } else {
    const raw = view.metric === 'availableCount' && isTotal
      ? entry.sellableCount + (entry.allowedOverbookingCount ?? 0)
      : entry[view.metric];
    value = raw ?? 0;
    if (view.metric !== 'soldCount') {
      if (raw <= 0) className = '.zero';
      else if (raw <= 2) className = '.low';
    }
  }

  const title = [
    `House ${entry.houseCount}`,
    `Sold ${entry.soldCount}`,
    `Sellable ${entry.sellableCount}`,
    entry.allowedOverbookingCount ? `Overbooking +${entry.allowedOverbookingCount}` : null,
    entry.maintenance?.outOfOrder || entry.maintenance?.outOfService
      ? `Out of order ${entry.maintenance.outOfOrder + entry.maintenance.outOfService}` : null,
    entry.block?.remaining ? `Blocked ${entry.block.remaining}` : null,
  ].filter(Boolean).join(' · ');

  return h(`td${className}`, { title }, String(value));
}

function overbookingDialog(groups, context) {
  const group = select(groups.map((g) => ({ value: g.id, label: g.name ?? g.id })));
  const from = input({ type: 'date', value: view.from });
  const to = input({ type: 'date', value: addDays(view.from, 7) });
  const count = input({ type: 'number', min: '0', value: '1' });

  modal({
    title: 'Allow overbooking',
    body: [
      h('p', { style: { margin: 0, color: 'var(--muted)', fontSize: '12.5px' } },
        'Overbooking lets the property sell beyond its physical inventory for the nights you choose. Set it to 0 to remove the allowance.'),
      field('Unit group', group),
      h('div.row', [
        h('div', { style: { flex: '1' } }, field('From', from)),
        h('div', { style: { flex: '1' } }, field('To', to)),
      ]),
      field('Extra rooms', count),
    ],
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const ok = await context.attempt(
            api.setOverbooking(group.value, from.value, to.value, Number(count.value) || 0),
            { success: 'Overbooking updated', failure: 'Could not set overbooking' },
          );
          if (ok) {
            closeOverlay();
            context.reload();
          }
        },
      }, 'Apply'),
    ],
  });
}

export { card };
