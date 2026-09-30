import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arg, register } from '../core/define';
import {
  addDays, businessDate, call, callList, diffDays, listProperties, resolveProperty, window,
} from '../core/context';
import { capped, day, facts, money, percent, person, sections, table } from '../core/render';

/**
 * Read-only analytics. Every tool here is marked `readOnlyHint`, so a client
 * can run them without prompting the user.
 */

const listPropertiesTool = {
  name: 'insight_list_properties',
  title: 'List properties',
  doc: {
    summary: 'List the properties in this account with their codes, currency and time zone.',
    use: [
      'First call in a new conversation, to learn the property ids everything else needs.',
      'Answering "which hotels are there".',
    ],
    avoid: ['Rooms or room types - use insight_property_overview.'],
    returns: 'One row per property: id, name, status, city, currency, time zone and business date.',
    notes: ['Every other tool accepts propertyId; it is only optional when there is exactly one.'],
  },
  input: {},
  annotations: { readOnly: true },
  async handler() {
    const properties = await listProperties();
    if (!properties.length) {
      return { text: 'No properties configured. Seed demo data with `npm run seed`.', data: { properties: [] } };
    }
    const dates = await Promise.all(properties.map((p) => businessDate(p)));
    const rows = properties.map((p, i) => ({ ...p, businessDate: dates[i]! }));
    return {
      text: sections(
        table(rows, [
          { header: 'propertyId', value: (p) => p.id },
          { header: 'name', value: (p) => p.name },
          { header: 'status', value: (p) => p.status },
          { header: 'city', value: (p) => [p.city, p.countryCode].filter(Boolean).join(', ') },
          { header: 'currency', value: (p) => p.currencyCode },
          { header: 'timeZone', value: (p) => p.timeZone },
          { header: 'businessDate', value: (p) => p.businessDate },
        ]),
        properties.length === 1
          ? 'One property, so propertyId may be omitted elsewhere.'
          : 'Pass propertyId explicitly to the other tools.',
      ),
      data: { properties: rows },
    };
  },
};

const propertyOverview = {
  name: 'insight_property_overview',
  title: 'Property overview',
  doc: {
    summary: 'How one property is set up: room types, room count, rate plans, services and taxes.',
    use: [
      'Orienting before doing anything else with an unfamiliar property.',
      'Answering "what room types are there" or "which rate plans exist".',
      'Finding the ids that quoting and booking need.',
    ],
    avoid: [
      'Prices for specific dates - use rates_get_prices.',
      'Free rooms - use insight_availability.',
    ],
    returns: 'Property facts, plus the unit groups, rate plans, services and city taxes configured on it.',
  },
  input: { propertyId: arg.optionalPropertyId },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const [groups, units, plans, services, taxes, date] = await Promise.all([
      callList<any>({ method: 'GET', path: '/inventory/v1/unit-groups', query: { propertyId: property.id, pageSize: 500 } }, 'unitGroups'),
      callList<any>({ method: 'GET', path: '/inventory/v1/units', query: { propertyId: property.id, pageSize: 500 } }, 'units'),
      callList<any>({ method: 'GET', path: '/rateplan/v1/rate-plans', query: { propertyId: property.id, pageSize: 500 } }, 'ratePlans'),
      callList<any>({ method: 'GET', path: '/rateplan/v1/services', query: { propertyId: property.id, pageSize: 500 } }, 'services'),
      callList<any>({ method: 'GET', path: '/settings/v1/city-tax', query: { propertyId: property.id } }, 'cityTaxes'),
      businessDate(property),
    ]);

    const perGroup = new Map<string, number>();
    for (const u of units.items) {
      const key = u.unitGroup?.id ?? '—';
      perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
    }

    return {
      text: sections(
        facts({
          property: `${property.name} (${property.id})`,
          status: property.status,
          location: [property.city, property.countryCode].filter(Boolean).join(', '),
          currency: property.currencyCode,
          timeZone: property.timeZone,
          businessDate: date,
          rooms: units.count,
        }),
        `ROOM TYPES\n${table(groups.items, [
          { header: 'unitGroupId', value: (g: any) => g.id },
          { header: 'code', value: (g: any) => g.code },
          { header: 'name', value: (g: any) => g.name },
          { header: 'maxGuests', value: (g: any) => String(g.maxPersons), align: 'right' },
          { header: 'rooms', value: (g: any) => String(perGroup.get(g.id) ?? 0), align: 'right' },
        ])}`,
        `RATE PLANS\n${table(plans.items, [
          { header: 'ratePlanId', value: (p: any) => p.id },
          { header: 'name', value: (p: any) => p.name },
          { header: 'roomType', value: (p: any) => p.unitGroup?.name ?? '' },
          { header: 'cancellation', value: (p: any) => p.cancellationPolicy?.name ?? '' },
          { header: 'pricing', value: (p: any) => (p.isDerived ? `derived ${p.pricingRule?.value > 0 ? '+' : ''}${p.pricingRule?.value}${p.pricingRule?.type === 'Percent' ? '%' : ''}` : 'own rates') },
          { header: 'cityTax', value: (p: any) => (p.isSubjectToCityTax ? 'yes' : 'no') },
        ])}`,
        services.items.length ? `SERVICES\n${table(services.items, [
          { header: 'serviceId', value: (s: any) => s.id },
          { header: 'name', value: (s: any) => s.name },
          { header: 'price', value: (s: any) => money(s.defaultGrossPrice), align: 'right' },
          { header: 'per', value: (s: any) => s.pricingUnit },
          { header: 'when', value: (s: any) => s.availability?.mode ?? '' },
        ])}` : null,
        taxes.items.length ? `CITY TAX\n${table(taxes.items, [
          { header: 'code', value: (t: any) => t.code },
          { header: 'type', value: (t: any) => t.type },
          { header: 'value', value: (t: any) => (String(t.type).startsWith('Percent') ? `${t.value}%` : String(t.value)) },
        ])}` : null,
      ),
      data: {
        property: { ...property, businessDate: date, roomCount: units.count },
        unitGroups: groups.items.map((g: any) => ({ id: g.id, code: g.code, name: g.name, maxPersons: g.maxPersons })),
        ratePlans: plans.items.map((p: any) => ({ id: p.id, name: p.name, unitGroupId: p.unitGroup?.id, isDerived: p.isDerived })),
        services: services.items.map((s: any) => ({ id: s.id, name: s.name, price: s.defaultGrossPrice })),
      },
    };
  },
};

const availability = {
  name: 'insight_availability',
  title: 'Availability by night',
  doc: {
    summary: 'How many rooms are free, sold and sellable per night, by room type.',
    use: [
      'Answering "are we full", "how many rooms are left on Friday".',
      'Finding the dates that block a longer stay.',
      'Checking the effect of maintenance or a block on inventory.',
    ],
    avoid: [
      'Prices - use booking_quote_stay or rates_get_prices.',
      'Historical occupancy - use insight_performance, which counts departed stays.',
    ],
    returns: 'A night-by-night grid per room type: house count, sold, sellable, and out-of-order.',
    notes: [
      'This is forward-looking inventory: a departed stay no longer holds a room, so past '
      + 'dates read as empty here. For historical occupancy use insight_performance.',
      'sellable already has maintenance and block holds deducted; available adds any '
      + 'overbooking allowance on top.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    from: arg.optionalDate('First night. Defaults to the business date.'),
    to: arg.optionalDate('Last night, exclusive. Defaults to 14 nights after `from`.'),
    unitGroupId: z.string().optional().describe('Restrict to one room type.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const range = await window(property, args.from, args.to, 14);
    if (diffDays(range.from, range.to) > 120) {
      return { text: 'Range too wide: ask for at most 120 nights at a time.', data: {} };
    }

    const { items } = await callList<any>({
      method: 'GET',
      path: '/availability/v1/unit-groups',
      query: {
        propertyId: property.id,
        from: range.from,
        to: range.to,
        unitGroupIds: args.unitGroupId,
        pageSize: 500,
      },
    }, 'timeSlices');

    if (!items.length) {
      return { text: `No availability data for ${property.name} between ${range.from} and ${range.to}.`, data: {} };
    }

    const rows = items.flatMap((slice: any) =>
      (slice.unitGroups ?? []).map((entry: any) => ({
        date: day(slice.from),
        unitGroup: entry.unitGroup.name ?? entry.unitGroup.id,
        house: entry.houseCount,
        sold: entry.soldCount,
        sellable: entry.sellableCount,
        available: entry.availableCount,
        outOfOrder: entry.maintenance.outOfService + entry.maintenance.outOfOrder,
        blocked: entry.block.remaining,
        occupancy: entry.occupancy,
      })));

    const soldOut = rows.filter((r) => r.available <= 0);
    return {
      text: sections(
        `${property.name} · ${range.from} to ${range.to}`,
        table(rows, [
          { header: 'date', value: (r) => r.date },
          { header: 'room type', value: (r) => r.unitGroup },
          { header: 'house', value: (r) => String(r.house), align: 'right' },
          { header: 'sold', value: (r) => String(r.sold), align: 'right' },
          { header: 'sellable', value: (r) => String(r.sellable), align: 'right' },
          { header: 'available', value: (r) => String(r.available), align: 'right' },
          { header: 'ooo', value: (r) => (r.outOfOrder ? String(r.outOfOrder) : ''), align: 'right' },
          { header: 'blocked', value: (r) => (r.blocked ? String(r.blocked) : ''), align: 'right' },
          { header: 'occ', value: (r) => percent(r.occupancy), align: 'right' },
        ]),
        soldOut.length
          ? `Sold out: ${[...new Set(soldOut.map((r) => `${r.date} ${r.unitGroup}`))].join(', ')}`
          : 'Nothing is sold out in this range.',
      ),
      data: { from: range.from, to: range.to, nights: rows },
    };
  },
};

const performance = {
  name: 'insight_performance',
  title: 'Performance',
  doc: {
    summary: 'Occupancy, ADR, RevPAR and revenue for a period, overall and per day.',
    use: [
      'Answering "how did last week go", "what is our ADR".',
      'Comparing room revenue against food and beverage.',
      'Historical occupancy, including stays that have already departed.',
    ],
    avoid: [
      'Forward-looking free rooms - use insight_availability.',
      'Money by ledger account - use finance_ledger.',
    ],
    returns: 'Headline metrics, a per-room-type split, and a day-by-day table.',
    notes: [
      'Counts stays that departed, so past occupancy is correct. This is the opposite of '
      + 'insight_availability, which deliberately excludes them.',
      'Room nights are summed across the range, so houseCount over 7 days at a 20-room hotel is 140.',
      'ADR is room revenue over rooms sold; RevPAR is room revenue over rooms available.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    from: arg.optionalDate('Period start. Defaults to 13 days before the business date.'),
    to: arg.optionalDate('Period end, inclusive. Defaults to the business date.'),
    byDay: z.boolean().default(true).describe('Include the day-by-day table. Set false for headline figures only.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const to = args.to ?? await businessDate(property);
    const from = args.from ?? addDays(to, -13);
    if (diffDays(from, to) < 0) {
      return { text: `'to' (${to}) must not be before 'from' (${from}).`, data: {} };
    }

    const report = await call<any>({
      method: 'GET',
      path: '/reports/v1/reports/property-performance',
      query: { propertyId: property.id, from, to, expand: 'unitGroups' },
    });

    const perGroup = new Map<string, any>();
    for (const d of report.businessDays ?? []) {
      for (const entry of d.unitGroups ?? []) {
        const key = entry.unitGroup.id;
        const acc = perGroup.get(key) ?? {
          name: entry.unitGroup.name ?? key, house: 0, sold: 0, revenue: 0,
          currency: entry.grossAccommodationRevenue.currency,
        };
        acc.house += entry.houseCount;
        acc.sold += entry.soldCount;
        acc.revenue += entry.grossAccommodationRevenue.amount;
        perGroup.set(key, acc);
      }
    }

    return {
      text: sections(
        `${property.name} · ${from} to ${to}`,
        facts({
          occupancy: `${percent(report.occupancyPercentage)} (${report.soldCount} of ${report.houseCount} room nights)`,
          ADR: money(report.grossAdr),
          RevPAR: money(report.revPar),
          roomRevenue: money(report.grossAccommodationRevenue),
          foodAndBeverage: money(report.grossFoodAndBeveragesRevenue),
          otherRevenue: money(report.grossOtherRevenue),
          arrivals: report.arrivalsCount,
          departures: report.departuresCount,
          noShows: report.noShowsCount || undefined,
          cancellations: report.cancellationsCount || undefined,
        }),
        perGroup.size ? `BY ROOM TYPE\n${table([...perGroup.values()], [
          { header: 'room type', value: (g: any) => g.name },
          { header: 'nights', value: (g: any) => String(g.house), align: 'right' },
          { header: 'sold', value: (g: any) => String(g.sold), align: 'right' },
          { header: 'occ', value: (g: any) => percent(g.house ? (g.sold / g.house) * 100 : 0), align: 'right' },
          { header: 'revenue', value: (g: any) => money({ amount: g.revenue, currency: g.currency }), align: 'right' },
          { header: 'ADR', value: (g: any) => money({ amount: g.sold ? g.revenue / g.sold : 0, currency: g.currency }), align: 'right' },
        ])}` : null,
        args.byDay && report.businessDays?.length
          ? `BY DAY\n${table(report.businessDays, [
            { header: 'date', value: (d: any) => d.businessDay },
            { header: 'sold', value: (d: any) => `${d.soldCount}/${d.houseCount}`, align: 'right' },
            { header: 'occ', value: (d: any) => percent(d.occupancyPercentage), align: 'right' },
            { header: 'ADR', value: (d: any) => money(d.grossAdr), align: 'right' },
            { header: 'RevPAR', value: (d: any) => money(d.revPar), align: 'right' },
            { header: 'room rev', value: (d: any) => money(d.grossAccommodationRevenue), align: 'right' },
            { header: 'arr/dep', value: (d: any) => `${d.arrivalsCount}/${d.departuresCount}`, align: 'right' },
          ])}`
          : null,
      ),
      data: {
        from, to,
        occupancyPercentage: report.occupancyPercentage,
        adr: report.grossAdr,
        revPar: report.revPar,
        roomRevenue: report.grossAccommodationRevenue,
        businessDays: args.byDay ? report.businessDays : undefined,
      },
    };
  },
};

const revenue = {
  name: 'insight_revenue',
  title: 'Revenue by account',
  doc: {
    summary: 'Revenue for a period, broken down by the chart of accounts.',
    use: [
      'Answering "where did the money come from".',
      'Splitting accommodation from food and beverage and other revenue.',
    ],
    avoid: [
      'Occupancy or ADR - use insight_performance.',
      'Payments and VAT as well as revenue - use finance_ledger.',
    ],
    returns: 'A revenue tree: parent accounts with their children and gross totals.',
  },
  input: {
    propertyId: arg.optionalPropertyId,
    from: arg.optionalDate('Period start. Defaults to 30 days before the business date.'),
    to: arg.optionalDate('Period end, inclusive. Defaults to the business date.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const to = args.to ?? await businessDate(property);
    const from = args.from ?? addDays(to, -30);

    const tree = await call<any>({
      method: 'GET',
      path: '/reports/v1/reports/revenues',
      query: { propertyId: property.id, from, to },
    });

    const lines: string[] = [];
    const walk = (node: any, depth: number) => {
      if (!node || !node.grossAmount?.amount) return;
      lines.push(`${'  '.repeat(depth)}${node.account.number}  ${node.account.name}`.padEnd(46)
        + money(node.grossAmount).padStart(14));
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    walk(tree, 0);

    return {
      text: sections(
        `${property.name} · revenue ${from} to ${to}`,
        lines.length ? lines.join('\n') : 'No revenue posted in this period.',
      ),
      data: { from, to, revenue: tree },
    };
  },
};

const history = {
  name: 'insight_history',
  title: 'Audit trail',
  doc: {
    summary: 'The audit trail for a reservation or a folio: what changed, when, and by whom.',
    use: [
      'Investigating a disputed charge or an unexpected status.',
      'Answering "who cancelled this" or "when was this posted".',
    ],
    avoid: ['Current state - use booking_get_reservation or finance_get_folio.'],
    returns: 'Events in reverse chronological order with their type, time and detail.',
    notes: ['Exactly one of reservationId or folioId must be given.'],
  },
  input: {
    reservationId: z.string().optional().describe('Reservation to trace. Mutually exclusive with folioId.'),
    folioId: z.string().optional().describe('Folio to trace. Mutually exclusive with reservationId.'),
    limit: arg.limit(30, 100),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    if (!args.reservationId === !args.folioId) {
      return { text: 'Give exactly one of reservationId or folioId.', data: {} };
    }
    const isReservation = Boolean(args.reservationId);
    const { items, count } = await callList<any>({
      method: 'GET',
      path: isReservation ? '/logs/v1/booking/reservation' : '/logs/v1/finance/folio',
      query: isReservation
        ? { reservationIds: args.reservationId, pageSize: Math.min(args.limit, 100) }
        : { folioIds: args.folioId, pageSize: Math.min(args.limit, 100) },
    }, 'logEntries');

    if (!items.length) {
      return {
        text: `No events recorded for ${args.reservationId ?? args.folioId}.`,
        data: { count: 0, events: [] },
      };
    }
    const { shown, note } = capped(items, count, args.limit);
    return {
      text: sections(
        `${count} event(s) for ${args.reservationId ?? args.folioId}`,
        table(shown, [
          { header: 'when', value: (e: any) => String(e.created).replace('T', ' ').slice(0, 19) },
          { header: 'event', value: (e: any) => e.eventType },
          { header: 'by', value: (e: any) => e.clientId ?? '' },
          { header: 'amount', value: (e: any) => money(e.amount), align: 'right' },
          { header: 'detail', value: (e: any) => e.message ?? e.relatedEntityDescription ?? '' },
        ]) + note,
      ),
      data: { count, events: shown },
    };
  },
};

export function registerInsight(server: McpServer): void {
  for (const spec of [
    listPropertiesTool, propertyOverview, availability, performance, revenue, history,
  ]) {
    register(server, spec as never);
  }
}

export { person };
