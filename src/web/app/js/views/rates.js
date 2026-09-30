import { mount, h, input, field, select, emptyState, modal, closeOverlay, toast, chip } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate, cached, invalidate } from '../state.js';
import { addDays, eachDay, isWeekend, dayName, parseDate, money, date, number } from '../format.js';

/**
 * The rate grid. Prices are editable in place; edits are collected and sent
 * as one JSON Patch per changed date, which is how the API expects bulk rate
 * changes. Derived rate plans are read-only — their prices come from a base
 * plan, so editing them here would be a lie.
 */

const view = { from: null, days: 21, ratePlanIds: [] };
const pending = new Map(); // `${ratePlanId}|${date}` -> new price

export async function render({ context }) {
  if (!view.from) view.from = businessDate();
  pending.clear();

  const { items: plans } = await cached('ratePlans', () => api.ratePlans(state.property.id));
  if (!plans.length) {
    return emptyState('No rate plans', 'Create a rate plan before you can load prices.', '€');
  }
  if (!view.ratePlanIds.length) view.ratePlanIds = plans.slice(0, 6).map((p) => p.id);

  const from = view.from;
  const to = addDays(from, view.days - 1);
  const shown = plans.filter((p) => view.ratePlanIds.includes(p.id));

  const loaded = await Promise.all(shown.map(async (plan) => ({
    plan,
    rates: (await api.rates(plan.id, from, to)).items,
  })));

  const days = eachDay(from, addDays(to, 1));
  const saveBar = h('div.toolbar', { style: { display: 'none' } });

  const container = h('section.card', [
    h('header', [
      h('h2', 'Rates'),
      h('div.spacer'),
      h('button.btn.sm', { onclick: () => bulkDialog(shown, context) }, 'Bulk update…'),
    ]),
    toolbar(plans, context, from, to),
    saveBar,
    h('div.matrix-wrap', [grid(days, loaded, saveBar, context)]),
    h('div.legend', [
      h('span', 'Click a price to edit it. Derived plans are calculated from their base plan and cannot be edited directly.'),
    ]),
  ]);
  return container;
}

function toolbar(plans, context, from, to) {
  return h('div.toolbar', [
    h('div.row.tight', [
      h('button.btn.sm', { onclick: () => { view.from = addDays(view.from, -view.days); context.reload(); } }, '«'),
      h('button.btn.sm', { onclick: () => { view.from = businessDate(); context.reload(); } }, 'Today'),
      h('button.btn.sm', { onclick: () => { view.from = addDays(view.from, view.days); context.reload(); } }, '»'),
    ]),
    field('From', input({
      type: 'date', value: from, onchange: (e) => { view.from = e.target.value; context.reload(); },
    })),
    field('Days', select(['14', '21', '31'], {
      value: String(view.days), onchange: (e) => { view.days = Number(e.target.value); context.reload(); },
    })),
    field('Rate plans', h('button.btn.sm', {
      onclick: () => choosePlans(plans, context),
    }, `${view.ratePlanIds.length} of ${plans.length} shown`)),
    h('div.spacer'),
    h('span', { style: { fontSize: '12.5px', color: 'var(--muted)' } }, `${date(from)} – ${date(to)}`),
  ]);
}

function choosePlans(plans, context) {
  const boxes = plans.map((plan) => {
    const box = h('input', {
      type: 'checkbox',
      style: { width: 'auto' },
      checked: view.ratePlanIds.includes(plan.id) || undefined,
      value: plan.id,
    });
    return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } }, [
      box,
      h('span', [plan.name, h('span', { style: { color: 'var(--muted)' } }, ` · ${plan.unitGroup?.name ?? ''}`)]),
      plan.isDerived ? chip('derived', 'violet') : null,
    ]);
  });

  modal({
    title: 'Rate plans to show',
    body: boxes,
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: () => {
          const checked = [...document.querySelectorAll('.modal input[type=checkbox]')]
            .filter((b) => b.checked).map((b) => b.value);
          if (!checked.length) {
            toast('Pick at least one rate plan', null, 'bad');
            return;
          }
          view.ratePlanIds = checked;
          closeOverlay();
          context.reload();
        },
      }, 'Show'),
    ],
  });
}

function grid(days, loaded, saveBar, context) {
  const head = h('thead', [h('tr', [
    h('th.rowhead.corner', 'Rate plan'),
    ...days.map((day) => h(`th${isWeekend(day) ? '.weekend' : ''}`, [
      h('div', { style: { fontSize: '9.5px', opacity: '.75' } }, dayName(day)),
      h('div', String(parseDate(day).getDate())),
    ])),
  ])]);

  const rows = loaded.map(({ plan, rates }) => {
    // Rates come back as time slices; index them by their starting date.
    const byDate = new Map(rates.map((rate) => [String(rate.from).slice(0, 10), rate]));

    return h('tr', [
      h('th.rowhead', [
        h('div', { style: { fontWeight: 550 } }, plan.name),
        h('div', { style: { fontSize: '11px', color: 'var(--muted)' } }, [
          plan.unitGroup?.name ?? '',
          plan.isDerived ? ' · derived' : '',
        ]),
      ]),
      ...days.map((day) => {
        const rate = byDate.get(day);
        if (plan.isDerived) {
          return h('td', { style: { color: 'var(--muted)' } }, rate ? number(rate.price.amount, 0) : '—');
        }
        return editableCell(plan, day, rate, saveBar, context);
      }),
    ]);
  });

  return h('table.matrix', [head, h('tbody', rows)]);
}

function editableCell(plan, day, rate, saveBar, context) {
  const key = `${plan.id}|${day}`;
  const cell = h('td.editable');
  const box = h('input', {
    type: 'number',
    step: '1',
    value: rate ? String(rate.price.amount) : '',
    placeholder: '—',
    oninput: () => {
      const value = box.value.trim();
      const original = rate ? String(rate.price.amount) : '';
      if (value === original) pending.delete(key);
      else pending.set(key, { ratePlanId: plan.id, date: day, price: Number(value), currency: rate?.price.currency ?? state.property.currencyCode });
      cell.classList.toggle('dirty', pending.has(key));
      paintSaveBar(saveBar, context);
    },
  });
  cell.append(box);
  return cell;
}

function paintSaveBar(saveBar, context) {
  if (!pending.size) {
    saveBar.style.display = 'none';
    return;
  }
  saveBar.style.display = '';
  mount(saveBar, 
    h('strong', { style: { fontSize: '13px' } }, `${pending.size} price${pending.size === 1 ? '' : 's'} changed`),
    h('div.spacer'),
    h('button.btn.sm', { onclick: () => context.reload() }, 'Discard'),
    h('button.btn.primary.sm', {
      onclick: async () => {
        // One patch call per date keeps each change atomic and gives a
        // precise error when a particular day is rejected.
        let saved = 0;
        for (const change of pending.values()) {
          const ok = await context.attempt(
            api.patchRates([change.ratePlanId], change.date, change.date,
              [{ op: 'replace', path: '/price/amount', value: change.price }]),
            { failure: `Could not save ${change.date}` },
          );
          if (ok) saved += 1;
        }
        if (saved) context.toast(`Saved ${saved} price${saved === 1 ? '' : 's'}`, null, 'ok');
        pending.clear();
        invalidate('ratePlans');
        context.reload();
      },
    }, 'Save changes'),
  );
}

function bulkDialog(plans, context) {
  const plan = select(plans.filter((p) => !p.isDerived).map((p) => ({ value: p.id, label: p.name })));
  const from = input({ type: 'date', value: view.from });
  const to = input({ type: 'date', value: addDays(view.from, 13) });
  const price = input({ type: 'number', step: '1', placeholder: '129' });
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayBoxes = weekdays.map((day) => {
    const box = h('input', { type: 'checkbox', style: { width: 'auto' }, value: day });
    return h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12.5px', marginRight: '10px' } },
      [box, day.slice(0, 3)]);
  });

  modal({
    title: 'Bulk rate update',
    body: [
      field('Rate plan', plan),
      h('div.row', [
        h('div', { style: { flex: '1' } }, field('From', from)),
        h('div', { style: { flex: '1' } }, field('To', to)),
      ]),
      field('Price', price, 'Applied to every selected day in the range.'),
      h('div.field', [h('label', 'Weekdays'), h('div', dayBoxes),
        h('div.note', 'Leave all unticked to apply to every day.')]),
    ],
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          if (!price.value) {
            toast('Enter a price', null, 'bad');
            return;
          }
          const days = dayBoxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
          const ok = await context.attempt(
            api.patchRates([plan.value], from.value, to.value,
              [{ op: 'replace', path: '/price/amount', value: Number(price.value) }],
              days.length ? days : undefined),
            { success: 'Rates updated', failure: 'Could not update the rates' },
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

export { money };
