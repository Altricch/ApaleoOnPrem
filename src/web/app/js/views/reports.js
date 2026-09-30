import { h, card, input, field, select, emptyState, table, chip } from '../dom.js';
import { api } from '../api.js';
import { state, businessDate } from '../state.js';
import { money, percent, number, date, addDays, parseDate, isWeekend, dayName } from '../format.js';

/**
 * Reporting: the performance numbers a revenue manager checks daily, the
 * revenue tree straight out of the chart of accounts, and proof that the
 * sub-ledger balances.
 */

const view = { from: null, to: null };

export async function render({ context }) {
  if (!view.from) {
    view.from = addDays(businessDate(), -13);
    view.to = businessDate();
  }
  const propertyId = state.property.id;

  const [performance, revenues, aggregate, arrivals] = await Promise.all([
    api.performance(propertyId, view.from, view.to, { expand: 'unitGroups' }),
    api.revenues(propertyId, view.from, view.to),
    api.accountsAggregate(propertyId, view.from, view.to),
    api.arrivalsReport(propertyId, parseDate(view.to).getMonth() + 1, parseDate(view.to).getFullYear()).catch(() => null),
  ]);

  return h('div.grid', [
    toolbarCard(context),
    kpis(performance),
    h('div.grid.cols-2', [
      revenueTree(revenues),
      ledgerCard(aggregate),
    ]),
    perUnitGroup(performance),
    dailyTable(performance),
    arrivals ? arrivalsCard(arrivals) : null,
  ]);
}

function toolbarCard(context) {
  const preset = (label, fromOffset, toOffset) => h('button.btn.sm', {
    onclick: () => {
      view.from = addDays(businessDate(), fromOffset);
      view.to = addDays(businessDate(), toOffset);
      context.reload();
    },
  }, label);

  return h('div.card', [h('div.toolbar', { style: { border: 0, borderRadius: 'var(--radius)' } }, [
    field('From', input({ type: 'date', value: view.from, onchange: (e) => { view.from = e.target.value; context.reload(); } })),
    field('To', input({ type: 'date', value: view.to, onchange: (e) => { view.to = e.target.value; context.reload(); } })),
    h('div.row.tight', [
      preset('Last 7 days', -6, 0),
      preset('Last 14 days', -13, 0),
      preset('Last 30 days', -29, 0),
      preset('Next 30 days', 0, 29),
    ]),
    h('div.spacer'),
    h('span', { style: { fontSize: '12.5px', color: 'var(--muted)' } }, `${date(view.from)} – ${date(view.to)}`),
  ])]);
}

function kpis(p) {
  return h('div.grid.cols-4', [
    h('div.card.stat', [
      h('div.label', 'Occupancy'),
      h('div.value', percent(p.occupancyPercentage)),
      h('div.sub', `${number(p.soldCount)} of ${number(p.houseCount)} room nights`),
      h('div.bar', [h('i', { style: { width: `${Math.min(100, p.occupancyPercentage)}%` } })]),
    ]),
    h('div.card.stat', [
      h('div.label', 'ADR'),
      h('div.value', money(p.grossAdr)),
      h('div.sub', `Net ${money(p.netAdr)}`),
    ]),
    h('div.card.stat', [
      h('div.label', 'RevPAR'),
      h('div.value', money(p.revPar)),
      h('div.sub', 'Revenue per available room'),
    ]),
    h('div.card.stat', [
      h('div.label', 'Room revenue'),
      h('div.value', money(p.grossAccommodationRevenue)),
      h('div.sub', `F&B ${money(p.grossFoodAndBeveragesRevenue)} · other ${money(p.grossOtherRevenue)}`),
    ]),
  ]);
}

function revenueTree(root) {
  const rows = [];
  const walk = (node, depth) => {
    if (!node) return;
    rows.push(h('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', gap: '12px',
        padding: '7px 0', borderBottom: '1px solid var(--line-2)',
        paddingLeft: `${depth * 16}px`,
        fontWeight: depth === 0 ? '650' : '400',
      },
    }, [
      h('span', [
        h('span', { style: { color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: '12px', marginRight: '8px' } },
          node.account.number),
        node.account.name,
      ]),
      h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, money(node.grossAmount)),
    ]));
    for (const child of node.children ?? []) {
      if (child.grossAmount?.amount) walk(child, depth + 1);
    }
  };
  walk(root, 0);

  return card('Revenue by account',
    rows.length > 1 ? rows : emptyState('No revenue in this period', 'Post some charges or run the night audit.', '€'));
}

function ledgerCard(aggregate) {
  const balanced = Math.abs(aggregate.total.balance.amount) < 0.005;
  const rows = (aggregate.aggregations ?? [])
    .filter((a) => Math.abs(a.debitedAmount.amount) > 0.005 || Math.abs(a.creditedAmount.amount) > 0.005)
    .filter((a) => /^\d/.test(a.account.number))
    .sort((a, b) => a.account.number.localeCompare(b.account.number));

  return card('Sub-ledger',
    h('div', { style: { margin: '-16px' } }, [
      table([
        { label: 'Account', mono: true, render: (a) => a.account.number },
        { label: 'Name', render: (a) => a.account.name },
        { label: 'Debit', num: true, render: (a) => a.debitedAmount.amount ? money(a.debitedAmount) : '—' },
        { label: 'Credit', num: true, render: (a) => a.creditedAmount.amount ? money(a.creditedAmount) : '—' },
      ], rows, { empty: { title: 'No postings in this period' } }),
      h('div.legend', [
        h('span', `Debits ${money(aggregate.total.debitedAmount)} · credits ${money(aggregate.total.creditedAmount)}`),
        h('div.spacer'),
        chip(balanced ? 'Balanced' : `Out by ${money(aggregate.total.balance)}`, balanced ? 'ok' : 'bad'),
      ]),
    ]),
  );
}

function perUnitGroup(performance) {
  // The per-group figures live on each business day; roll them up.
  const totals = new Map();
  for (const day of performance.businessDays ?? []) {
    for (const entry of day.unitGroups ?? []) {
      const key = entry.unitGroup.id;
      const acc = totals.get(key) ?? {
        unitGroup: entry.unitGroup, houseCount: 0, soldCount: 0, revenue: 0,
        currency: entry.grossAccommodationRevenue.currency,
      };
      acc.houseCount += entry.houseCount;
      acc.soldCount += entry.soldCount;
      acc.revenue += entry.grossAccommodationRevenue.amount;
      totals.set(key, acc);
    }
  }
  const rows = [...totals.values()];
  if (!rows.length) return null;

  return card('By unit group', h('div', { style: { margin: '-16px' } }, [
    table([
      { label: 'Unit group', render: (r) => r.unitGroup.name ?? r.unitGroup.id },
      { label: 'Room nights', num: true, render: (r) => number(r.houseCount) },
      { label: 'Sold', num: true, render: (r) => number(r.soldCount) },
      { label: 'Occupancy', num: true, render: (r) => percent(r.houseCount ? (r.soldCount / r.houseCount) * 100 : 0) },
      { label: 'Revenue', num: true, render: (r) => money({ amount: r.revenue, currency: r.currency }) },
      { label: 'ADR', num: true, render: (r) => money({ amount: r.soldCount ? r.revenue / r.soldCount : 0, currency: r.currency }) },
    ], rows),
  ]));
}

function dailyTable(performance) {
  const days = performance.businessDays ?? [];
  if (!days.length) return null;
  const max = Math.max(...days.map((d) => d.grossAccommodationRevenue.amount), 1);

  return card('Day by day', h('div', { style: { margin: '-16px' } }, [
    table([
      {
        label: 'Business day',
        render: (d) => h('span', { style: { color: isWeekend(d.businessDay) ? 'var(--accent)' : 'inherit' } },
          `${dayName(d.businessDay)} ${date(d.businessDay)}`),
      },
      { label: 'Sold', num: true, render: (d) => `${d.soldCount} / ${d.houseCount}` },
      { label: 'Occupancy', num: true, render: (d) => percent(d.occupancyPercentage) },
      { label: 'ADR', num: true, render: (d) => money(d.grossAdr) },
      { label: 'RevPAR', num: true, render: (d) => money(d.revPar) },
      {
        label: 'Room revenue',
        render: (d) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' } }, [
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, money(d.grossAccommodationRevenue)),
          h('span', {
            style: {
              display: 'inline-block', height: '6px', borderRadius: '3px', background: 'var(--accent)',
              width: `${Math.max(2, (d.grossAccommodationRevenue.amount / max) * 70)}px`, opacity: '.7',
            },
          }),
        ]),
        num: true,
      },
      { label: 'Arr / Dep', num: true, render: (d) => `${d.arrivalsCount} / ${d.departuresCount}` },
    ], days),
  ]));
}

function arrivalsCard(report) {
  if (!report.total) return null;
  const bar = (entry, total) => h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' },
  }, [
    h('span', { style: { width: '90px', fontSize: '13px' } }, entry.countryCode ?? entry.purpose ?? 'Unknown'),
    h('span', {
      style: {
        height: '8px', borderRadius: '4px', background: 'var(--accent)',
        width: `${Math.max(3, (entry.number / total) * 220)}px`,
      },
    }),
    h('span', { style: { fontSize: '12.5px', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' } },
      `${entry.number} · ${percent(entry.percent)}`),
  ]);

  return h('div.grid.cols-2', [
    card(`Arrivals this month · ${report.total}`, [
      h('p', { style: { color: 'var(--muted)', fontSize: '12.5px', margin: '0 0 10px' } },
        `${report.totalAdults} adults, ${report.totalChildren} children`),
      ...(report.travelPurposeBreakdown ?? []).map((e) => bar(e, report.total)),
    ]),
    card('By nationality', (report.nationalityBreakdown ?? []).slice(0, 8).map((e) => bar(e, report.total))),
  ]);
}
