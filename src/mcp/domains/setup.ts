import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arg, register, requireConfirmation } from '../core/define';
import { ToolError } from '../core/errors';
import {
  addDays, businessDate, call, callList, callVoid, diffDays, invalidate, resolveProperty, window,
} from '../core/context';
import { capped, day, facts, money, sections, table } from '../core/render';

/**
 * Commercial and physical configuration: rooms, rate plans, prices and
 * extras. These change the shape of what can be sold, so the writing tools
 * here are deliberately few and explicit.
 */

const listUnits = {
  name: 'setup_list_rooms',
  title: 'List rooms',
  doc: {
    summary: 'List the physical rooms of a property with their type, capacity and attributes.',
    use: [
      'Finding a unitId to assign or to take out of service.',
      'Answering "how many rooms of each type are there".',
    ],
    avoid: [
      'Cleanliness and occupancy right now - use operations_room_board.',
      'How many are free on a date - use insight_availability.',
    ],
    returns: 'One row per room: id, name, type, capacity and attributes.',
  },
  input: {
    propertyId: arg.optionalPropertyId,
    unitGroupId: z.string().optional().describe('Restrict to one room type.'),
    includeArchived: z.boolean().default(false).describe('Include rooms taken out of the inventory permanently.'),
    limit: arg.limit(60, 300),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const { items, count } = await callList<any>({
      method: 'GET',
      path: '/inventory/v1/units',
      query: {
        propertyId: property.id,
        unitGroupId: args.unitGroupId,
        includeArchived: args.includeArchived,
        pageSize: Math.min(args.limit, 300),
      },
    }, 'units');
    if (!items.length) return { text: `No rooms at ${property.name} match.`, data: { count: 0, rooms: [] } };
    const { shown, note } = capped(items, count, args.limit);
    return {
      text: sections(
        `${count} room(s) at ${property.name}`,
        table(shown, [
          { header: 'unitId', value: (u: any) => u.id },
          { header: 'room', value: (u: any) => u.name },
          { header: 'type', value: (u: any) => u.unitGroup?.name ?? '' },
          { header: 'maxGuests', value: (u: any) => String(u.maxPersons), align: 'right' },
          { header: 'attributes', value: (u: any) => (u.attributes ?? []).map((a: any) => a.name).join(', ') },
          { header: 'archived', value: (u: any) => (u.isArchived ? 'yes' : '') },
        ]) + note,
      ),
      data: { count, rooms: shown.map((u: any) => ({ id: u.id, name: u.name, unitGroupId: u.unitGroup?.id, maxPersons: u.maxPersons })) },
    };
  },
};

const listRatePlans = {
  name: 'rates_list_plans',
  title: 'List rate plans',
  doc: {
    summary: 'List the rate plans of a property, with their policies and how they are priced.',
    use: [
      'Finding a ratePlanId to read or change prices on.',
      'Understanding which plans are derived from others.',
      'Checking which cancellation policy a rate carries.',
    ],
    avoid: [
      'Prices for dates - use rates_get_prices.',
      'What is bookable right now - use booking_quote_stay, which applies availability and restrictions.',
    ],
    returns: 'One row per plan: id, name, room type, policies, channels and pricing basis.',
    notes: [
      'A derived plan has no prices of its own; it tracks a base plan by a percentage or '
      + 'a fixed amount. Change the base to move both.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    includeArchived: z.boolean().default(false),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const { items, count } = await callList<any>({
      method: 'GET',
      path: '/rateplan/v1/rate-plans',
      query: { propertyId: property.id, includeArchived: args.includeArchived, pageSize: 500 },
    }, 'ratePlans');
    if (!items.length) return { text: `No rate plans at ${property.name}.`, data: { count: 0, ratePlans: [] } };
    return {
      text: sections(
        `${count} rate plan(s) at ${property.name}`,
        table(items, [
          { header: 'ratePlanId', value: (p: any) => p.id },
          { header: 'name', value: (p: any) => p.name },
          { header: 'roomType', value: (p: any) => p.unitGroup?.name ?? '' },
          { header: 'cancellation', value: (p: any) => p.cancellationPolicy?.name ?? '' },
          { header: 'guarantee', value: (p: any) => p.minGuaranteeType },
          {
            header: 'pricing',
            value: (p: any) => (p.isDerived
              ? `derived from ${p.pricingRule?.baseRatePlan?.id} ${p.pricingRule?.value > 0 ? '+' : ''}${p.pricingRule?.value}${p.pricingRule?.type === 'Percent' ? '%' : ''}`
              : 'own rates'),
          },
          { header: 'channels', value: (p: any) => (p.channelCodes ?? []).join('/') },
          { header: 'cityTax', value: (p: any) => (p.isSubjectToCityTax ? 'yes' : 'no') },
        ]),
      ),
      data: { count, ratePlans: items.map((p: any) => ({ id: p.id, name: p.name, isDerived: p.isDerived, unitGroupId: p.unitGroup?.id })) },
    };
  },
};

const getPrices = {
  name: 'rates_get_prices',
  title: 'Read prices',
  doc: {
    summary: 'Read the nightly price of a rate plan over a date range.',
    use: [
      'Reviewing what is loaded before changing prices.',
      'Answering "what do we charge on Saturdays next month".',
      'Checking a derived plan is tracking its base correctly.',
    ],
    avoid: [
      'Quoting a guest - use booking_quote_stay, which applies occupancy, taxes and availability.',
      'Changing prices - use rates_set_prices.',
    ],
    returns: 'One row per night: date, weekday, price, and any restriction on it.',
    notes: [
      'This is the list price for the base occupancy. The price a guest actually pays adds '
      + 'occupancy surcharges, services and city tax - quote to see that.',
    ],
  },
  input: {
    ratePlanId: z.string().describe('From rates_list_plans.'),
    from: arg.date('First date, YYYY-MM-DD.'),
    to: arg.date('Last date, inclusive, YYYY-MM-DD.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const span = diffDays(args.from, args.to);
    if (span < 0) throw new ToolError(`'to' (${args.to}) must not be before 'from' (${args.from}).`);
    if (span > 120) throw new ToolError('Ask for at most 120 days at a time.');

    const { items, count } = await callList<any>({
      method: 'GET',
      path: `/rateplan/v1/rate-plans/${encodeURIComponent(args.ratePlanId)}/rates`,
      query: { from: args.from, to: args.to, pageSize: 500 },
    }, 'rates', { subject: `Rate plan '${args.ratePlanId}'`, discoverWith: 'rates_list_plans' });

    if (!items.length) {
      return {
        text: `No prices loaded for ${args.ratePlanId} between ${args.from} and ${args.to}. `
          + 'Load them with rates_set_prices, or check the plan is not derived from one with no rates.',
        data: { count: 0, rates: [] },
      };
    }

    const rows = items.map((r: any) => ({
      date: day(r.from),
      weekday: new Date(`${day(r.from)}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      price: r.price,
      restrictions: [
        r.restrictions?.closed && 'closed',
        r.restrictions?.closedOnArrival && 'no arrival',
        r.restrictions?.closedOnDeparture && 'no departure',
        r.restrictions?.minLengthOfStay && `min ${r.restrictions.minLengthOfStay}n`,
        r.restrictions?.maxLengthOfStay && `max ${r.restrictions.maxLengthOfStay}n`,
      ].filter(Boolean).join(', '),
    }));

    const prices = rows.map((r) => r.price.amount);
    return {
      text: sections(
        `${args.ratePlanId} · ${args.from} to ${args.to} · ${count} night(s) · `
        + `low ${Math.min(...prices)} high ${Math.max(...prices)}`,
        table(rows, [
          { header: 'date', value: (r) => r.date },
          { header: 'day', value: (r) => r.weekday },
          { header: 'price', value: (r) => money(r.price), align: 'right' },
          { header: 'restrictions', value: (r) => r.restrictions },
        ]),
      ),
      data: { ratePlanId: args.ratePlanId, count, rates: rows },
    };
  },
};

const setPrices = {
  name: 'rates_set_prices',
  title: 'Set prices',
  doc: {
    summary: 'Set the nightly price of a rate plan across a date range, optionally only on chosen weekdays.',
    use: [
      'Raising weekend rates for a season.',
      'Loading prices for a period that has none.',
      'Applying a single price across a promotional window.',
    ],
    avoid: [
      'A derived plan - it has no prices of its own; change its base instead.',
      'Quoting or booking - this only changes what is loaded.',
    ],
    returns: 'How many nights were changed, with the range and the new price.',
    notes: [
      'Overwrites every matching night in the range. Read the current prices first if the '
      + 'user needs to know what is being replaced.',
      'Derived plans follow automatically once the base changes.',
      'weekdays lets you move only Fridays and Saturdays without touching the rest.',
    ],
  },
  input: {
    ratePlanId: z.string().describe('From rates_list_plans. Must not be a derived plan.'),
    from: arg.date('First date to change, YYYY-MM-DD.'),
    to: arg.date('Last date to change, inclusive, YYYY-MM-DD.'),
    price: z.number().positive().describe('Gross nightly price in the property currency.'),
    weekdays: z.array(z.enum([
      'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    ])).optional().describe('Only these weekdays. Omit to change every night in the range.'),
    confirm: arg.confirm,
  },
  annotations: { destructive: true, idempotent: true, requiresConfirmation: true },
  async handler(args: any) {
    const span = diffDays(args.from, args.to);
    if (span < 0) throw new ToolError(`'to' (${args.to}) must not be before 'from' (${args.from}).`);

    const plan = await call<any>(
      { method: 'GET', path: `/rateplan/v1/rate-plans/${encodeURIComponent(args.ratePlanId)}` },
      { subject: `Rate plan '${args.ratePlanId}'`, discoverWith: 'rates_list_plans' },
    );
    if (plan.isDerived) {
      throw new ToolError(
        `${args.ratePlanId} is derived from ${plan.pricingRule?.baseRatePlan?.id}; its prices are calculated. `
        + `Set prices on ${plan.pricingRule?.baseRatePlan?.id} instead.`,
      );
    }

    const days = args.weekdays?.length ? `${args.weekdays.join(', ')} only` : 'every night';
    requireConfirmation(
      args.confirm,
      `This overwrites the price on ${plan.name} for ${days} between ${args.from} and ${args.to} `
      + `(${span + 1} day window), setting it to ${args.price}.`,
    );

    await callVoid({
      method: 'PATCH',
      path: '/rateplan/v1/rates',
      query: { ratePlanIds: args.ratePlanId, from: args.from, to: args.to, weekDays: args.weekdays },
      body: [{ op: 'replace', path: '/price/amount', value: args.price }],
    }, { subject: `Rate plan '${args.ratePlanId}'` });

    invalidate(`ratePlans:${plan.property?.id ?? ''}`);
    const after = await callList<any>({
      method: 'GET',
      path: `/rateplan/v1/rate-plans/${encodeURIComponent(args.ratePlanId)}/rates`,
      query: { from: args.from, to: args.to, pageSize: 500 },
    }, 'rates');
    const changed = after.items.filter((r: any) => r.price.amount === args.price).length;

    return {
      text: `Set ${plan.name} to ${args.price} for ${days} between ${args.from} and ${args.to}. `
        + `${changed} of ${after.count} night(s) in the range now carry that price.`,
      data: { ratePlanId: args.ratePlanId, from: args.from, to: args.to, price: args.price, nightsAtPrice: changed },
    };
  },
};

const listServices = {
  name: 'rates_list_services',
  title: 'List services',
  doc: {
    summary: 'List the extras a property sells: breakfast, parking, late check-out and so on.',
    use: [
      'Finding a serviceId for booking_manage_services or booking_create.',
      'Answering "what extras do we offer and what do they cost".',
    ],
    avoid: ['Ad-hoc charges with no service behind them - use finance_post_charge.'],
    returns: 'One row per service: id, name, price, pricing unit and when it applies.',
    notes: [
      'pricingUnit Person multiplies by the number of guests; Room charges once.',
      'The availability mode decides which nights it lands on.',
    ],
  },
  input: { propertyId: arg.optionalPropertyId },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const { items, count } = await callList<any>({
      method: 'GET',
      path: '/rateplan/v1/services',
      query: { propertyId: property.id, pageSize: 500 },
    }, 'services');
    if (!items.length) return { text: `No services configured at ${property.name}.`, data: { count: 0, services: [] } };
    return {
      text: sections(
        `${count} service(s) at ${property.name}`,
        table(items, [
          { header: 'serviceId', value: (s: any) => s.id },
          { header: 'code', value: (s: any) => s.code },
          { header: 'name', value: (s: any) => s.name },
          { header: 'price', value: (s: any) => money(s.defaultGrossPrice), align: 'right' },
          { header: 'per', value: (s: any) => s.pricingUnit },
          { header: 'when', value: (s: any) => s.availability?.mode ?? '' },
          { header: 'vat', value: (s: any) => s.vatType ?? '' },
        ]),
      ),
      data: { count, services: items.map((s: any) => ({ id: s.id, code: s.code, name: s.name, price: s.defaultGrossPrice, pricingUnit: s.pricingUnit })) },
    };
  },
};

const setOverbooking = {
  name: 'rates_set_overbooking',
  title: 'Set overbooking',
  doc: {
    summary: 'Allow a room type to be sold beyond its physical inventory for chosen nights.',
    use: [
      'Deliberately overselling a night with a high expected cancellation rate.',
      'Removing an allowance set earlier.',
    ],
    avoid: ['Forcing one booking past a sold-out rate - booking_create has force for that.'],
    returns: 'The nights and the allowance applied.',
    notes: [
      'Set count to 0 to remove the allowance.',
      'Overbooking raises what can be sold; it does not create rooms. Somebody has to be walked '
      + 'if the rooms do not free up.',
    ],
  },
  input: {
    unitGroupId: z.string().describe('Room type id, e.g. "MUC-DBL". From insight_property_overview.'),
    from: arg.date('First night, YYYY-MM-DD.'),
    to: arg.date('Last night, exclusive, YYYY-MM-DD.'),
    count: z.number().int().min(0).max(50).describe('Extra rooms sellable per night. 0 removes the allowance.'),
    confirm: arg.confirm,
  },
  annotations: { destructive: true, idempotent: true, requiresConfirmation: true },
  async handler(args: any) {
    requireConfirmation(
      args.confirm,
      args.count === 0
        ? `This removes the overbooking allowance on ${args.unitGroupId} from ${args.from} to ${args.to}.`
        : `This lets ${args.unitGroupId} be oversold by ${args.count} room(s) per night from `
          + `${args.from} to ${args.to}, which can leave guests without a room.`,
    );
    await callVoid({
      method: 'PATCH',
      path: `/availability/v1/unit-groups/${encodeURIComponent(args.unitGroupId)}`,
      query: { from: args.from, to: args.to, timeSliceTemplate: 'OverNight' },
      body: [{ op: 'replace', path: '/allowedOverbookingCount', value: args.count }],
    }, { subject: `Unit group '${args.unitGroupId}'`, discoverWith: 'insight_property_overview' });

    return {
      text: args.count === 0
        ? `Overbooking removed on ${args.unitGroupId} from ${args.from} to ${args.to}.`
        : `${args.unitGroupId} may now be oversold by ${args.count} per night from ${args.from} to ${args.to}.`,
      data: { unitGroupId: args.unitGroupId, from: args.from, to: args.to, count: args.count },
    };
  },
};

export function registerSetup(server: McpServer): void {
  for (const spec of [
    listUnits, listRatePlans, getPrices, setPrices, listServices, setOverbooking,
  ]) {
    register(server, spec as never);
  }
}

export { addDays, businessDate, facts, window };
