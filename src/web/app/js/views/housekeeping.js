import { mount, h, card, chip, select, input, field, confirmDialog, emptyState, modal, closeOverlay } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate, invalidate } from '../state.js';
import { date, label, tone, addDays, guestName } from '../format.js';

/**
 * Housekeeping: room conditions and maintenance. Rooms are selectable so a
 * housekeeper can mark a whole floor clean in one call, which is what the
 * bulk `units-condition` endpoint exists for.
 */

const CONDITIONS = ['Clean', 'CleanToBeInspected', 'Dirty'];
const selected = new Set();
let filterCondition = '';

export async function render({ context }) {
  const propertyId = state.property.id;
  const today = businessDate();

  const [units, groups, maintenances, departures, arrivals] = await Promise.all([
    api.units({ propertyId, includeArchived: false }),
    api.unitGroups(propertyId),
    api.maintenances({ propertyId, from: today, to: addDays(today, 30) }),
    api.reservations({ propertyIds: propertyId, dateFilter: 'Departure', from: today, to: today, status: ['InHouse', 'CheckedOut'] }),
    api.reservations({ propertyIds: propertyId, dateFilter: 'Arrival', from: today, to: today, status: ['Confirmed', 'InHouse'] }),
  ]);

  selected.clear();
  const arrivalsByUnit = new Map(arrivals.items.filter((r) => r.unit).map((r) => [r.unit.id, r]));
  const departuresByUnit = new Map(departures.items.filter((r) => r.unit).map((r) => [r.unit.id, r]));
  const groupName = new Map(groups.items.map((g) => [g.id, g.name]));

  const counts = CONDITIONS.reduce((acc, c) => {
    acc[c] = units.items.filter((u) => u.status.condition === c).length;
    return acc;
  }, {});

  return h('div.grid', [
    h('div.grid.cols-4', CONDITIONS.map((condition) => h('div.card.stat', [
      h('div.label', label(condition)),
      h('div.value', String(counts[condition])),
      h('div.sub', condition === 'Dirty' ? 'Need attention' : condition === 'Clean' ? 'Ready to sell' : 'Awaiting inspection'),
    ])).concat([
      h('div.card.stat', [
        h('div.label', 'Out of order'),
        h('div.value', String(maintenances.items.filter((m) => m.from.slice(0, 10) <= today && m.to.slice(0, 10) > today).length)),
        h('div.sub', `${maintenances.items.length} window(s) scheduled`),
      ]),
    ])),

    roomBoard(units.items, groupName, arrivalsByUnit, departuresByUnit, context),
    maintenanceCard(maintenances.items, units.items, context),
  ]);
}

function roomBoard(units, groupName, arrivalsByUnit, departuresByUnit, context) {
  const container = h('section.card');
  const grid = h('div.unit-grid');
  const bulkBar = h('div.toolbar', { style: { display: 'none' } });

  const visible = () => units
    .filter((u) => !filterCondition || u.status.condition === filterCondition)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  function paintBulk() {
    if (!selected.size) {
      bulkBar.style.display = 'none';
      return;
    }
    bulkBar.style.display = '';
    mount(bulkBar, 
      h('strong', { style: { fontSize: '13px' } }, `${selected.size} room${selected.size === 1 ? '' : 's'} selected`),
      h('div.spacer'),
      ...CONDITIONS.map((condition) => h('button.btn.sm', {
        onclick: async () => {
          const ok = await context.attempt(
            api.setUnitConditions([...selected].map((id) => ({ id, condition }))),
            { success: `Marked ${selected.size} room(s) ${label(condition).toLowerCase()}`, failure: 'Could not update the rooms' },
          );
          if (ok) {
            invalidate('units');
            context.reload();
          }
        },
      }, `Mark ${label(condition).toLowerCase()}`)),
      h('button.btn.ghost.sm', {
        onclick: () => { selected.clear(); paint(); },
      }, 'Clear'),
    );
  }

  function paint() {
    mount(grid, ...visible().map((unit) => {
      const arriving = arrivalsByUnit.get(unit.id);
      const departing = departuresByUnit.get(unit.id);
      const tile = h(`button.unit-tile.${unit.status.condition}${selected.has(unit.id) ? '.selected' : ''}`, {
        type: 'button',
        onclick: () => {
          if (selected.has(unit.id)) selected.delete(unit.id);
          else selected.add(unit.id);
          paint();
        },
      }, [
        h('div.name', unit.name),
        h('div.grp', groupName.get(unit.unitGroup?.id) ?? '—'),
        h('div.row.tight', [
          chip(label(unit.status.condition), tone(unit.status.condition)),
          unit.status.isOccupied ? chip('occupied', 'info') : null,
        ]),
        departing ? h('div.grp', { style: { color: 'var(--warn)' } }, `↑ ${guestName(departing.primaryGuest)}`) : null,
        arriving && !departing ? h('div.grp', { style: { color: 'var(--accent)' } }, `↓ ${guestName(arriving.primaryGuest)}`) : null,
        unit.status.maintenance ? h('div.grp', { style: { color: 'var(--bad)' } }, unit.status.maintenance.type) : null,
      ]);
      return tile;
    }));
    if (!visible().length) mount(grid, emptyState('No rooms match', 'Change the condition filter.'));
    paintBulk();
  }

  container.append(
    h('header', [
      h('h2', 'Room board'),
      h('div.spacer'),
      h('div.segmented', [
        h(`button${filterCondition === '' ? '.on' : ''}`, {
          onclick: () => { filterCondition = ''; context.reload(); },
        }, 'All'),
        ...CONDITIONS.map((condition) => h(`button${filterCondition === condition ? '.on' : ''}`, {
          onclick: () => { filterCondition = condition; context.reload(); },
        }, label(condition))),
      ]),
    ]),
    bulkBar,
    h('div.body', [
      h('p', { style: { color: 'var(--muted)', fontSize: '12.5px', margin: '0 0 12px' } },
        'Select rooms to change their condition in bulk. Arrows show who is leaving (↑) or arriving (↓) today.'),
      grid,
    ]),
  );
  paint();
  return container;
}

function maintenanceCard(maintenances, units, context) {
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  return card(
    'Maintenance',
    h('div', { style: { margin: '-16px' } }, [
      maintenances.length
        ? h('table.data', [
          h('thead', [h('tr', ['Room', 'Type', 'From', 'To', 'Description', ''].map((t) => h('th', t)))]),
          h('tbody', maintenances.map((m) => h('tr', [
            h('td.mono', unitName.get(m.unit.id) ?? m.unit.id),
            h('td', chip(m.type, m.type === 'OutOfInventory' ? 'bad' : 'warn')),
            h('td', date(m.from)),
            h('td', date(m.to)),
            h('td', { style: { color: 'var(--muted)' } }, m.description ?? '—'),
            h('td', { style: { textAlign: 'right' } }, h('button.btn.ghost.sm', {
              onclick: async () => {
                const ok = await confirmDialog({
                  title: 'Remove this maintenance window?',
                  message: `${unitName.get(m.unit.id)} becomes sellable again from ${date(m.from)}.`,
                  confirmLabel: 'Remove',
                  danger: true,
                });
                if (!ok) return;
                const done = await context.attempt(api.deleteMaintenance(m.id), {
                  success: 'Maintenance removed', failure: 'Could not remove it',
                });
                if (done) context.reload();
              },
            }, 'Remove')),
          ]))),
        ])
        : emptyState('No maintenance scheduled', 'Rooms taken out of service will show up here.'),
    ]),
    [h('button.btn.sm', { onclick: () => scheduleMaintenance(units, context) }, '+ Schedule')],
  );
}

function scheduleMaintenance(units, context) {
  const unit = select(
    units.map((u) => ({ value: u.id, label: `${u.name} · ${u.unitGroup?.name ?? ''}` })),
  );
  const type = select([
    { value: 'OutOfService', label: 'Out of service — small repair' },
    { value: 'OutOfOrder', label: 'Out of order — cannot be sold' },
    { value: 'OutOfInventory', label: 'Out of inventory — remove from house count' },
  ]);
  const from = input({ type: 'date', value: businessDate() });
  const to = input({ type: 'date', value: addDays(businessDate(), 1) });
  const description = input({ placeholder: 'e.g. Bathroom refurbishment' });

  modal({
    title: 'Schedule maintenance',
    body: [
      field('Room', unit),
      field('Type', type),
      h('div.row', [
        h('div', { style: { flex: '1' } }, field('From', from)),
        h('div', { style: { flex: '1' } }, field('To', to)),
      ]),
      field('Description', description),
    ],
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const ok = await context.attempt(api.createMaintenance({
            unitId: unit.value,
            type: type.value,
            from: `${from.value}T00:00:00Z`,
            to: `${to.value}T00:00:00Z`,
            description: description.value.trim() || undefined,
          }), { success: 'Maintenance scheduled', failure: 'Could not schedule it' });
          if (ok) {
            closeOverlay();
            context.reload();
          }
        },
      }, 'Schedule'),
    ],
  });
}
