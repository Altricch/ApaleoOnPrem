import { h, card, chip, table, emptyState } from '../dom.js';
import { api } from '../api.js';
import { state, cached } from '../state.js';
import { money, date, label, tone, number } from '../format.js';

/** A read-only look at how the active property is configured. */
export async function render() {
  const propertyId = state.property.id;
  const p = state.property;

  const [groups, units, plans, services, taxes, policies, segments] = await Promise.all([
    cached('unitGroups', () => api.unitGroups(propertyId)),
    cached('units', () => api.units({ propertyId })),
    cached('ratePlans', () => api.ratePlans(propertyId)),
    cached('services', () => api.services(propertyId)),
    api.cityTaxes(propertyId),
    api.cancellationPolicies(propertyId),
    api.marketSegments(propertyId),
  ]);

  const unitsByGroup = new Map();
  for (const unit of units.items) {
    const key = unit.unitGroup?.id ?? '—';
    unitsByGroup.set(key, (unitsByGroup.get(key) ?? 0) + 1);
  }

  return h('div.grid', [
    h('div.grid.cols-2', [
      card('Property', h('dl.kv', [
        h('dt', 'Name'), h('dd', h('strong', state.property.displayName ?? p.id)),
        h('dt', 'Code'), h('dd', h('span.mono', p.code)),
        h('dt', 'Status'), h('dd', chip(p.status, p.status === 'Live' ? 'ok' : 'warn')),
        h('dt', 'Business date'), h('dd', date(p.businessDate)),
        h('dt', 'Time zone'), h('dd', p.timeZone),
        h('dt', 'Currency'), h('dd', p.currencyCode),
        h('dt', 'Check in / out'), h('dd', `${p.defaultCheckInTime ?? '—'} / ${p.defaultCheckOutTime ?? '—'}`),
        h('dt', 'Address'), h('dd', [
          p.location.addressLine1, h('br'),
          `${p.location.postalCode} ${p.location.city}`, h('br'),
          p.location.countryCode,
        ]),
      ])),
      card('Legal & banking', h('dl.kv', [
        h('dt', 'Company'), h('dd', p.companyName),
        h('dt', 'Managing directors'), h('dd', p.managingDirectors ?? '—'),
        h('dt', 'Register entry'), h('dd', p.commercialRegisterEntry),
        h('dt', 'Tax ID'), h('dd', h('span.mono', p.taxId)),
        h('dt', 'IBAN'), h('dd', h('span.mono', p.bankAccount?.iban ?? '—')),
        h('dt', 'BIC'), h('dd', h('span.mono', p.bankAccount?.bic ?? '—')),
        h('dt', 'Bank'), h('dd', p.bankAccount?.bank ?? '—'),
      ])),
    ]),

    card('Unit groups', h('div', { style: { margin: '-16px' } }, [
      table([
        { label: 'Code', mono: true, render: (g) => g.code },
        { label: 'Name', render: (g) => g.name },
        { label: 'Type', render: (g) => chip(g.type, 'info') },
        { label: 'Max guests', num: true, render: (g) => number(g.maxPersons) },
        { label: 'Rooms', num: true, render: (g) => number(unitsByGroup.get(g.id) ?? 0) },
      ], groups.items),
    ])),

    card('Rate plans', h('div', { style: { margin: '-16px' } }, [
      table([
        { label: 'Code', mono: true, render: (r) => r.code },
        { label: 'Name', render: (r) => r.name },
        { label: 'Unit group', render: (r) => r.unitGroup?.name ?? '—' },
        { label: 'Cancellation', render: (r) => r.cancellationPolicy?.name ?? '—' },
        {
          label: 'Pricing',
          render: (r) => r.isDerived
            ? chip(`derived ${r.pricingRule.value > 0 ? '+' : ''}${r.pricingRule.value}${r.pricingRule.type === 'Percent' ? '%' : ''}`, 'violet')
            : chip('own rates', 'accent'),
        },
        { label: 'City tax', render: (r) => r.isSubjectToCityTax ? 'Yes' : 'No' },
        { label: 'Channels', render: (r) => (r.channelCodes ?? []).join(', ') || '—' },
      ], plans.items),
    ])),

    h('div.grid.cols-2', [
      card('Services', h('div', { style: { margin: '-16px' } }, [
        table([
          { label: 'Code', mono: true, render: (s) => s.code },
          { label: 'Name', render: (s) => s.name },
          { label: 'Price', num: true, render: (s) => money(s.defaultGrossPrice) },
          { label: 'Per', render: (s) => s.pricingUnit },
          { label: 'When', render: (s) => s.availability?.mode ?? '—' },
        ], services.items, { empty: { title: 'No services' } }),
      ])),
      card('City tax', h('div', { style: { margin: '-16px' } }, [
        table([
          { label: 'Code', mono: true, render: (t) => t.code },
          { label: 'Name', render: (t) => t.name },
          { label: 'Type', render: (t) => t.type },
          { label: 'Value', num: true, render: (t) => t.type.startsWith('Percent') ? `${t.value}%` : money({ amount: t.value, currency: state.property.currencyCode }) },
        ], taxes.items, { empty: { title: 'No city tax configured' } }),
      ])),
    ]),

    h('div.grid.cols-2', [
      card('Cancellation policies', h('div', { style: { margin: '-16px' } }, [
        table([
          { label: 'Code', mono: true, render: (c) => c.code },
          { label: 'Name', render: (c) => c.name },
          {
            label: 'Fee',
            render: (c) => c.fee?.fixedValue
              ? money(c.fee.fixedValue)
              : c.fee?.percentValue
                ? `${c.fee.percentValue.percent}%${c.fee.percentValue.limit ? ` of the first ${c.fee.percentValue.limit} night(s)` : ' of the stay'}`
                : '—',
          },
        ], policies.items, { empty: { title: 'No policies' } }),
      ])),
      card('Market segments', h('div', { style: { margin: '-16px' } }, [
        table([
          { label: 'Code', mono: true, render: (m) => m.code },
          { label: 'Name', render: (m) => m.name },
        ], segments.items, { empty: { title: 'No market segments' } }),
      ])),
    ]),

    card('Rooms', h('div.unit-grid', units.items
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((unit) => h(`div.unit-tile.${unit.status.condition}`, { style: { cursor: 'default' } }, [
        h('div.name', unit.name),
        h('div.grp', unit.unitGroup?.name ?? '—'),
        h('div.grp', `${unit.maxPersons} guest${unit.maxPersons === 1 ? '' : 's'}`),
        chip(label(unit.status.condition), tone(unit.status.condition)),
      ])))),
  ]);
}

export { emptyState };
