import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arg, register, requireConfirmation } from '../core/define';
import { ToolError } from '../core/errors';
import {
  addDays, businessDate, call, callList, callVoid, diffDays, invalidate,
  resolveProperty, services as listServices, window,
} from '../core/context';
import { capped, day, facts, money, person, sections, table } from '../core/render';

/**
 * Selling and operating reservations: shopping for a rate, taking the
 * booking, and walking the stay through its lifecycle.
 *
 * The lifecycle is a state machine, so each transition is its own tool rather
 * than one `perform_action` with an enum. That is what lets check-in be
 * marked read-safe-to-retry while cancelling is marked destructive and gated
 * behind a confirmation - a single tool could only carry one set of hints.
 */

const CHANNELS = [
  'Direct', 'BookingCom', 'Ibe', 'ChannelManager', 'Expedia',
  'Homelike', 'Hrs', 'Airbnb', 'Agoda', 'Hostelworld', 'Other',
] as const;

const STATUSES = ['Confirmed', 'InHouse', 'CheckedOut', 'NoShow', 'Canceled'] as const;

/* -------------------------------------------------------------- shopping */

const quoteStay = {
  name: 'booking_quote_stay',
  title: 'Quote a stay',
  doc: {
    summary: 'Price a stay and see which rate plans can actually be sold for those dates.',
    use: [
      'A guest asks what a stay would cost, or which rooms are free.',
      'Before booking, to obtain the ratePlanId that booking_create needs.',
      'To check whether a rate is bookable and, if not, exactly why.',
    ],
    avoid: [
      'Counting free rooms across a date range - use insight_availability.',
      'Changing an existing stay - use booking_amend_stay, which re-prices it.',
      'Reading prices without occupancy - use rates_get_prices.',
    ],
    returns:
      'One row per rate plan: total price, price per night, rooms available, the '
      + 'cancellation fee, and any reason the rate cannot be booked.',
    notes: [
      'Offers that fail validation are still returned, marked with the reason, so the '
      + 'user can be told why rather than just "nothing available".',
      'The total already includes city tax and any service included in the rate.',
      'departure is the morning the guest leaves, so 3 Jan -> 5 Jan is two nights.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    arrival: arg.date('First night of the stay, YYYY-MM-DD.'),
    departure: arg.date('Morning the guest leaves, YYYY-MM-DD. Must be after arrival.'),
    adults: z.number().int().min(1).max(10).default(1).describe('Number of adults sharing the room.'),
    childrenAges: z.array(z.number().int().min(0).max(17)).optional()
      .describe('Ages of accompanying children, e.g. [4, 9]. Ages drive both the price and the city tax.'),
    channelCode: z.enum(CHANNELS).default('Direct')
      .describe('Sales channel. Rate plans can be restricted to channels, and some city taxes are not charged on OTA bookings.'),
    promoCode: z.string().optional().describe('Reveals rate plans hidden behind a promotional code.'),
    corporateCode: z.string().optional().describe('Reveals a negotiated company rate.'),
    includeUnavailable: z.boolean().default(true)
      .describe('Keep rates that cannot currently be sold, annotated with the reason. Set false for bookable rates only.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    if (diffDays(args.arrival, args.departure) < 1) {
      throw new ToolError(
        `departure (${args.departure}) must be at least one day after arrival (${args.arrival}).`,
      );
    }
    const nights = diffDays(args.arrival, args.departure);

    const payload = await call<any>({
      method: 'GET',
      path: '/booking/v1/offers',
      query: {
        propertyId: property.id,
        arrival: args.arrival,
        departure: args.departure,
        adults: args.adults,
        childrenAges: args.childrenAges,
        channelCode: args.channelCode,
        promoCode: args.promoCode,
        corporateCode: args.corporateCode,
        includeUnavailable: args.includeUnavailable,
      },
    });

    const offers: any[] = payload?.offers ?? [];
    if (!offers.length) {
      return {
        text: `No rate plans are configured or loaded with prices for ${args.arrival} to `
          + `${args.departure} at ${property.name}. Check rates_list_plans and rates_get_prices.`,
        data: { offers: [] },
      };
    }

    const rows = offers
      .map((offer) => ({
        ratePlanId: offer.ratePlan.id,
        ratePlan: offer.ratePlan.name ?? offer.ratePlan.id,
        unitGroup: offer.unitGroup?.name ?? '',
        available: offer.availableUnits,
        total: offer.totalGrossAmount,
        perNight: { amount: offer.totalGrossAmount.amount / nights, currency: offer.totalGrossAmount.currency },
        cancellationFee: offer.cancellationFee?.fee,
        cityTax: offer.cityTaxes?.[0]?.totalGrossAmount,
        blocked: (offer.validationMessages ?? []).map((m: any) => m.message),
      }))
      .sort((a, b) => a.total.amount - b.total.amount);

    const text = sections(
      `${property.name} · ${args.arrival} to ${args.departure} · ${nights} night(s) · `
      + `${args.adults} adult(s)${args.childrenAges?.length ? ` + ${args.childrenAges.length} child(ren)` : ''}`,
      table(rows, [
        { header: 'ratePlanId', value: (r) => r.ratePlanId },
        { header: 'rate plan', value: (r) => r.ratePlan },
        { header: 'room type', value: (r) => r.unitGroup },
        { header: 'free', value: (r) => String(r.available), align: 'right' },
        { header: 'total', value: (r) => money(r.total), align: 'right' },
        { header: '/night', value: (r) => money(r.perNight), align: 'right' },
        { header: 'cxl fee', value: (r) => money(r.cancellationFee), align: 'right' },
        { header: 'city tax', value: (r) => money(r.cityTax), align: 'right' },
      ]),
      rows.some((r) => r.blocked.length)
        ? `Cannot be sold:\n${rows.filter((r) => r.blocked.length)
          .map((r) => `- ${r.ratePlanId}: ${r.blocked.join('; ')}`).join('\n')}`
        : null,
      'Pass a ratePlanId from the first column to booking_create.',
    );
    return { text, data: { property: property.id, nights, offers: rows } };
  },
};

/* --------------------------------------------------------------- reading */

const findReservations = {
  name: 'booking_find_reservations',
  title: 'Find reservations',
  doc: {
    summary: 'Search reservations by date, status, guest name, room, or channel.',
    use: [
      'Answering "who arrives today", "who is in house", "what is booked next week".',
      'Finding a reservation id from a guest name or an external reference.',
      'Listing cancellations or no-shows over a period.',
    ],
    avoid: [
      'Reading one reservation in full - use booking_get_reservation.',
      'Occupancy or revenue figures - use insight_performance.',
      'Housekeeping status per room - use operations_room_board.',
    ],
    returns: 'One row per reservation: id, guest, status, stay, room, rate plan, total and balance.',
    notes: [
      'dateFilter chooses which date the from/to window applies to. Arrival is the default; '
      + 'use Stay to catch everyone present during the window, including guests who arrived earlier.',
      'Omitting from/to searches the next 30 days from the property business date.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    dateFilter: z.enum(['Arrival', 'Departure', 'Stay', 'Creation', 'Modification', 'Cancellation'])
      .default('Arrival')
      .describe('Which date the from/to window filters on. Stay = present at any point in the window.'),
    from: arg.optionalDate('Window start, YYYY-MM-DD. Defaults to the property business date.'),
    to: arg.optionalDate('Window end, YYYY-MM-DD. Defaults to 30 days after `from`.'),
    status: z.array(z.enum(STATUSES)).optional()
      .describe('Keep only these statuses. Omit for all. Cancelled and no-show stays are included unless you filter them out.'),
    search: z.string().optional()
      .describe('Free text over guest name, reservation id, booking id and external code.'),
    unitId: z.string().optional().describe('Only reservations assigned to this room.'),
    channelCode: z.array(z.enum(CHANNELS)).optional().describe('Only these sales channels.'),
    unpaidOnly: z.boolean().default(false).describe('Only reservations with an outstanding balance.'),
    limit: arg.limit(25, 200),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const range = await window(property, args.from, args.to, 30);

    const { items, count } = await callList<any>({
      method: 'GET',
      path: '/booking/v1/reservations',
      query: {
        propertyIds: property.id,
        dateFilter: args.dateFilter,
        from: range.from,
        to: range.to,
        status: args.status,
        textSearch: args.search,
        unitIds: args.unitId,
        channelCode: args.channelCode,
        balanceFilter: args.unpaidOnly ? 'Positive' : undefined,
        sort: 'arrival:asc',
        pageSize: Math.min(args.limit, 200),
      },
    }, 'reservations');

    if (!items.length) {
      return {
        text: `No reservations at ${property.name} with ${args.dateFilter.toLowerCase()} between `
          + `${range.from} and ${range.to}${args.status ? ` in status ${args.status.join('/')}` : ''}.`,
        data: { count: 0, reservations: [] },
      };
    }

    const { shown, note } = capped(items, count, args.limit);
    const rows = shown.map((r) => ({
      id: r.id,
      guest: person(r.primaryGuest) || '(no name)',
      status: r.status,
      arrival: day(r.arrival),
      departure: day(r.departure),
      room: r.unit?.name ?? '',
      unitGroup: r.unitGroup?.name ?? '',
      ratePlan: r.ratePlan?.code ?? '',
      total: r.totalGrossAmount,
      balance: r.balance,
    }));

    return {
      text: sections(
        `${count} reservation(s) at ${property.name} · ${args.dateFilter.toLowerCase()} ${range.from} to ${range.to}`,
        table(rows, [
          { header: 'id', value: (r) => r.id },
          { header: 'guest', value: (r) => r.guest },
          { header: 'status', value: (r) => r.status },
          { header: 'arrival', value: (r) => r.arrival },
          { header: 'departure', value: (r) => r.departure },
          { header: 'room', value: (r) => r.room },
          { header: 'type', value: (r) => r.unitGroup },
          { header: 'rate', value: (r) => r.ratePlan },
          { header: 'total', value: (r) => money(r.total), align: 'right' },
          { header: 'balance', value: (r) => money(r.balance), align: 'right' },
        ]) + note,
      ),
      data: { count, reservations: rows },
    };
  },
};

const getReservation = {
  name: 'booking_get_reservation',
  title: 'Read a reservation',
  doc: {
    summary: 'Read one reservation in full, including what may be done to it next.',
    use: [
      'Before any lifecycle action, to see whether it is currently permitted.',
      'Answering a detailed question about one stay: nightly prices, services, balance.',
      'Finding the folio id to post a charge or payment against.',
    ],
    avoid: [
      'Scanning many reservations - use booking_find_reservations.',
      'Full folio history - use finance_get_folio.',
    ],
    returns:
      'The stay, guest, per-night prices, booked services, folio balance, and the list of '
      + 'allowed and blocked actions with the reason each is blocked.',
    notes: [
      'The allowed-actions list is authoritative: if it says check-in is blocked, calling '
      + 'booking_check_in will fail with the same reason.',
    ],
  },
  input: {
    reservationId: arg.reservationId,
    detail: arg.detail,
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const r = await call<any>(
      { method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}`, query: { expand: 'actions' } },
      { subject: `Reservation '${args.reservationId}'`, discoverWith: 'booking_find_reservations' },
    );

    const actions: any[] = r.actions ?? [];
    const allowed = actions.filter((a) => a.isAllowed).map((a) => a.action);
    const blocked = actions.filter((a) => !a.isAllowed && a.reasons?.length)
      .map((a) => `${a.action}: ${a.reasons[0].message}`);

    const head = facts({
      reservation: r.id,
      booking: r.bookingId,
      status: r.status,
      guest: person(r.primaryGuest),
      email: r.primaryGuest?.email,
      stay: `${day(r.arrival)} to ${day(r.departure)} (${diffDays(day(r.arrival), day(r.departure))} nights)`,
      occupancy: `${r.adults} adult(s)${r.childrenAges?.length ? `, children aged ${r.childrenAges.join('/')}` : ''}`,
      room: r.unit ? `${r.unit.name} (${r.unit.id})` : 'not assigned',
      roomType: r.unitGroup?.name,
      ratePlan: `${r.ratePlan?.name ?? ''} (${r.ratePlan?.id ?? ''})`,
      channel: [r.channelCode, r.source].filter(Boolean).join(' / '),
      total: money(r.totalGrossAmount),
      balance: money(r.balance),
      cancellationFee: r.cancellationFee?.fee?.amount ? money(r.cancellationFee.fee) : undefined,
      noShowFee: r.noShowFee?.fee?.amount ? money(r.noShowFee.fee) : undefined,
      checkedIn: r.checkInTime,
      checkedOut: r.checkOutTime,
      cancelled: r.cancellationTime,
      comment: r.comment,
    });

    const nights = (r.timeSlices ?? []).map((t: any) => ({
      date: t.serviceDate,
      ratePlan: t.ratePlan?.code ?? '',
      amount: t.totalGrossAmount,
    }));

    const svc = (r.services ?? []).map((s: any) => ({
      code: s.service?.code ?? s.service?.id,
      name: s.service?.name ?? '',
      dates: s.dates.length,
      total: { amount: s.totalAmount.grossAmount, currency: s.totalAmount.currency },
      includedInRate: s.dates.some((d: any) => d.isMandatory),
    }));

    const folios = await callList<any>(
      { method: 'GET', path: '/finance/v1/folios', query: { reservationIds: r.id } },
      'folios',
    );

    return {
      text: sections(
        head,
        nights.length ? `NIGHTS\n${table(nights, [
          { header: 'date', value: (n: any) => n.date },
          { header: 'rate', value: (n: any) => n.ratePlan },
          { header: 'amount', value: (n: any) => money(n.amount), align: 'right' },
        ])}` : null,
        svc.length ? `SERVICES\n${table(svc, [
          { header: 'code', value: (s: any) => s.code },
          { header: 'name', value: (s: any) => s.name },
          { header: 'dates', value: (s: any) => String(s.dates), align: 'right' },
          { header: 'total', value: (s: any) => money(s.total), align: 'right' },
          { header: 'in rate', value: (s: any) => (s.includedInRate ? 'yes' : '') },
        ])}` : null,
        folios.items.length ? `FOLIOS\n${table(folios.items, [
          { header: 'folioId', value: (f: any) => f.id },
          { header: 'status', value: (f: any) => f.status },
          { header: 'balance', value: (f: any) => money(f.balance), align: 'right' },
        ])}` : null,
        allowed.length ? `ALLOWED NOW: ${allowed.join(', ')}` : 'ALLOWED NOW: (none)',
        blocked.length ? `BLOCKED\n${blocked.map((b) => `- ${b}`).join('\n')}` : null,
        args.detail === 'full' ? `RAW\n${JSON.stringify(r, null, 1)}` : null,
      ),
      data: {
        reservation: r,
        folios: folios.items.map((f: any) => ({ id: f.id, status: f.status, balance: f.balance })),
        allowedActions: allowed,
        blockedActions: blocked,
      },
    };
  },
};

/* --------------------------------------------------------------- booking */

const guestSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().describe('Required. The only guest field apaleo insists on.'),
  email: z.string().optional(),
  phone: z.string().optional(),
  nationalityCountryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2, e.g. "DE".'),
}).describe('Guest details.');

const createBooking = {
  name: 'booking_create',
  title: 'Create a booking',
  doc: {
    summary: 'Create a booking containing one or more reservations.',
    use: [
      'Taking a new booking once booking_quote_stay has produced a ratePlanId.',
      'Booking several rooms for the same guest in one transaction.',
    ],
    avoid: [
      'Changing an existing stay - use booking_amend_stay.',
      'Adding an extra to a stay that already exists - use booking_manage_services.',
    ],
    returns: 'The booking id and the id of each reservation created.',
    notes: [
      'Quote first. A ratePlanId that is not sellable for those dates is rejected, and the '
      + 'quote explains why before you waste a call.',
      'The same rate plan is applied to every night of a stay.',
      'A room is not assigned automatically. Call booking_assign_room afterwards, or the '
      + 'guest cannot be checked in.',
      'force=true books past a sold-out or restricted rate. Use it only when the user has '
      + 'explicitly accepted overbooking.',
    ],
  },
  input: {
    booker: guestSchema.describe('Who is making the booking. Used as the guest when a stay omits one.'),
    stays: z.array(z.object({
      arrival: arg.date('First night, YYYY-MM-DD.'),
      departure: arg.date('Morning of departure, YYYY-MM-DD.'),
      ratePlanId: z.string().describe('From booking_quote_stay. Determines the room type, price and policies.'),
      adults: z.number().int().min(1).max(10).default(1),
      childrenAges: z.array(z.number().int().min(0).max(17)).optional(),
      guest: guestSchema.optional().describe('Occupant, when different from the booker.'),
      serviceIds: z.array(z.string()).optional()
        .describe('Extras to add at booking time, e.g. ["MUC-BRKF"]. From rates_list_services.'),
      channelCode: z.enum(CHANNELS).default('Direct'),
      comment: z.string().optional().describe('Internal note for the front desk.'),
      travelPurpose: z.enum(['Business', 'Leisure']).optional(),
    })).min(1).max(20).describe('One entry per room to book.'),
    comment: z.string().optional().describe('Note on the booking as a whole.'),
    force: z.boolean().default(false)
      .describe('Book even when the rate is sold out or restricted. Overbooks the property.'),
  },
  annotations: { destructive: false, idempotent: false },
  async handler(args: any) {
    const reservations = args.stays.map((stay: any) => {
      const nights = diffDays(stay.arrival, stay.departure);
      if (nights < 1) {
        throw new ToolError(`departure (${stay.departure}) must be after arrival (${stay.arrival}).`);
      }
      return {
        arrival: stay.arrival,
        departure: stay.departure,
        adults: stay.adults,
        childrenAges: stay.childrenAges,
        channelCode: stay.channelCode,
        primaryGuest: stay.guest ?? args.booker,
        timeSlices: Array.from({ length: nights }, () => ({ ratePlanId: stay.ratePlanId })),
        services: stay.serviceIds?.map((serviceId: string) => ({ serviceId })),
        comment: stay.comment,
        travelPurpose: stay.travelPurpose,
      };
    });

    const created = await call<any>({
      method: 'POST',
      path: args.force ? '/booking/v1/bookings/$force' : '/booking/v1/bookings',
      body: { booker: args.booker, comment: args.comment, reservations },
    });

    const ids: string[] = (created.reservationIds ?? []).map((x: any) => x.id);
    const detail = await Promise.all(ids.map((id) =>
      call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(id)}` })));

    return {
      text: sections(
        `Booking ${created.id} created with ${ids.length} reservation(s).`,
        table(detail, [
          { header: 'reservationId', value: (r: any) => r.id },
          { header: 'guest', value: (r: any) => person(r.primaryGuest) },
          { header: 'stay', value: (r: any) => `${day(r.arrival)} to ${day(r.departure)}` },
          { header: 'type', value: (r: any) => r.unitGroup?.name ?? '' },
          { header: 'total', value: (r: any) => money(r.totalGrossAmount), align: 'right' },
        ]),
        detail.some((r: any) => r.validationMessages?.length)
          ? `Booked with warnings:\n${detail.flatMap((r: any) =>
            (r.validationMessages ?? []).map((m: any) => `- ${r.id}: ${m.message}`)).join('\n')}`
          : null,
        'No room is assigned yet. Call booking_assign_room before check-in.',
      ),
      data: { bookingId: created.id, reservationIds: ids },
    };
  },
};

const amendStay = {
  name: 'booking_amend_stay',
  title: 'Amend a stay',
  doc: {
    summary: 'Change the dates or occupancy of an existing reservation and re-price it.',
    use: [
      'A guest extends, shortens, or shifts their stay.',
      'The number of adults or children changes.',
    ],
    avoid: [
      'Adding or removing an extra - use booking_manage_services.',
      'Moving the guest to another room - use booking_assign_room.',
      'Cancelling - use booking_cancel.',
    ],
    returns: 'The new stay dates, nightly prices and total.',
    notes: [
      'The stay is re-quoted at current rates, so the total can move even when only the '
      + 'occupancy changed. Quote first if the user needs the new price before agreeing.',
      'Nights that have already been posted to the folio cannot be removed.',
    ],
  },
  input: {
    reservationId: arg.reservationId,
    arrival: arg.optionalDate('New first night. Omit to keep the current one.'),
    departure: arg.optionalDate('New departure morning. Omit to keep the current one.'),
    adults: z.number().int().min(1).max(10).optional().describe('New adult count. Omit to keep.'),
    childrenAges: z.array(z.number().int().min(0).max(17)).optional().describe('New children ages. Omit to keep.'),
    ratePlanId: z.string().optional().describe('Move the stay onto another rate plan. Omit to keep the current one.'),
  },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    const current = await call<any>(
      { method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` },
      { subject: `Reservation '${args.reservationId}'`, discoverWith: 'booking_find_reservations' },
    );

    const arrival = args.arrival ?? day(current.arrival);
    const departure = args.departure ?? day(current.departure);
    const nights = diffDays(arrival, departure);
    if (nights < 1) throw new ToolError(`departure (${departure}) must be after arrival (${arrival}).`);

    const ratePlanId = args.ratePlanId ?? current.ratePlan.id;
    await callVoid({
      method: 'PUT',
      path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/amend`,
      body: {
        arrival,
        departure,
        adults: args.adults ?? current.adults,
        childrenAges: args.childrenAges ?? current.childrenAges ?? [],
        timeSlices: Array.from({ length: nights }, () => ({ ratePlanId })),
      },
    }, { subject: `Reservation '${args.reservationId}'` });

    const updated = await call<any>(
      { method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` },
    );

    return {
      text: sections(
        `${updated.id} amended.`,
        facts({
          stay: `${day(updated.arrival)} to ${day(updated.departure)} (${nights} nights)`,
          occupancy: `${updated.adults} adult(s)`,
          ratePlan: updated.ratePlan?.name,
          was: money(current.totalGrossAmount),
          now: money(updated.totalGrossAmount),
          balance: money(updated.balance),
        }),
        updated.unit ? null : 'The room assignment was cleared or never made; check booking_assign_room.',
      ),
      data: { reservation: updated.id, previousTotal: current.totalGrossAmount, total: updated.totalGrossAmount },
    };
  },
};

/* ------------------------------------------------------------ operations */

const assignRoom = {
  name: 'booking_assign_room',
  title: 'Assign a room',
  doc: {
    summary: 'Give a reservation a room, either a specific one or the best available.',
    use: [
      'Before check-in: a room must be assigned for the whole stay.',
      'Moving a guest to a different room.',
    ],
    avoid: [
      'Taking a room away - use booking_release_room.',
      'Changing the room type - that is a re-price, use booking_amend_stay.',
    ],
    returns: 'The room assigned, with its housekeeping condition.',
    notes: [
      'With no unitId, the cleanest free room in the booked room type is chosen.',
      'Assignment fails if the room is not free for every night of the stay.',
    ],
  },
  input: {
    reservationId: arg.reservationId,
    unitId: z.string().optional()
      .describe('Specific room id, e.g. "MUC-MTA". Omit to auto-assign the best free room.'),
    conditions: z.array(z.enum(['Clean', 'CleanToBeInspected', 'Dirty'])).optional()
      .describe('Restrict auto-assignment to rooms in these housekeeping conditions.'),
  },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    const subject = `Reservation '${args.reservationId}'`;
    if (args.unitId) {
      await callVoid({
        method: 'PUT',
        path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}`
          + `/assign-unit/${encodeURIComponent(args.unitId)}`,
      }, { subject });
    } else {
      await callVoid({
        method: 'PUT',
        path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/assign-unit`,
        query: { unitConditions: args.conditions },
      }, { subject });
    }
    const r = await call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` });
    return {
      text: `${r.id} assigned to room ${r.unit?.name ?? '(unknown)'} (${r.unit?.id ?? ''}).`,
      data: { reservationId: r.id, unit: r.unit },
    };
  },
};

const releaseRoom = {
  name: 'booking_release_room',
  title: 'Release a room',
  doc: {
    summary: 'Take the assigned room back off a reservation, returning it to inventory.',
    use: ['Freeing a specific room so it can be given to another guest.'],
    avoid: ['Moving a guest - booking_assign_room reassigns in one step.'],
    returns: 'Confirmation that the reservation has no room.',
    notes: ['Only possible while the reservation is still Confirmed - not after check-in.'],
  },
  input: { reservationId: arg.reservationId },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    await callVoid({
      method: 'PUT',
      path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/unassign-units`,
    }, { subject: `Reservation '${args.reservationId}'` });
    return { text: `${args.reservationId} no longer holds a room.`, data: { reservationId: args.reservationId } };
  },
};

const checkIn = {
  name: 'booking_check_in',
  title: 'Check in',
  doc: {
    summary: 'Check a guest in, moving the reservation to InHouse and posting the stay so far.',
    use: ['The guest has arrived and a room is assigned.'],
    avoid: [
      'Checking out - use booking_check_out.',
      'Reversing a check-in - use booking_revert_check_in.',
    ],
    returns: 'The new status, the room, and the folio balance after posting.',
    notes: [
      'Requires a room assigned for the whole stay, and the arrival date to have been reached.',
      'Charges due up to the business date are posted to the folio, so the balance moves.',
      'The room is marked dirty.',
    ],
  },
  input: {
    reservationId: arg.reservationId,
    withCityTax: z.boolean().optional()
      .describe('Set false to check in without city tax, e.g. an exempt guest. Defaults to the rate plan setting.'),
  },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    await callVoid({
      method: 'PUT',
      path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/checkin`,
      query: args.withCityTax === undefined ? undefined : { withCityTax: args.withCityTax },
    }, { subject: `Reservation '${args.reservationId}'` });
    const r = await call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` });
    return {
      text: sections(
        `${r.id} checked in.`,
        facts({
          guest: person(r.primaryGuest),
          room: r.unit?.name,
          status: r.status,
          balance: money(r.balance),
          departs: day(r.departure),
        }),
      ),
      data: { reservationId: r.id, status: r.status, unit: r.unit, balance: r.balance },
    };
  },
};

const revertCheckIn = {
  name: 'booking_revert_check_in',
  title: 'Undo a check-in',
  doc: {
    summary: 'Reverse a check-in made in error, returning the reservation to Confirmed.',
    use: ['A guest was checked in by mistake and nothing has been charged yet.'],
    avoid: ['A guest who has genuinely left - use booking_check_out.'],
    returns: 'The reverted status.',
    notes: ['Refused once charges have been posted; correct the folio first.'],
  },
  input: { reservationId: arg.reservationId },
  annotations: { destructive: true, idempotent: true },
  async handler(args: any) {
    await callVoid({
      method: 'PUT',
      path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/revert-checkin`,
    }, { subject: `Reservation '${args.reservationId}'` });
    return { text: `${args.reservationId} is Confirmed again.`, data: { reservationId: args.reservationId } };
  },
};

const checkOut = {
  name: 'booking_check_out',
  title: 'Check out',
  doc: {
    summary: 'Check a guest out, posting everything outstanding and closing the folio.',
    use: ['The guest is leaving and the bill is settled.'],
    avoid: ['Taking payment - use finance_post_payment first.'],
    returns: 'The new status, or the exact amount still owed if it is refused.',
    notes: [
      'Remaining nights are posted before the balance is checked, so the first attempt on '
      + 'an unsettled folio reports the amount to collect. That posting is kept - settle it '
      + 'with finance_post_payment and call again.',
      'Only a company flagged for accounts-receivable settlement may leave a balance open.',
    ],
  },
  input: { reservationId: arg.reservationId },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    try {
      await callVoid({
        method: 'PUT',
        path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/checkout`,
      }, { subject: `Reservation '${args.reservationId}'` });
    } catch (err) {
      // An unsettled folio is the normal case, not a failure to hide: report
      // the amount so the model can collect it and retry.
      const folios = await callList<any>(
        { method: 'GET', path: '/finance/v1/folios', query: { reservationIds: args.reservationId } },
        'folios',
      );
      const owing = folios.items.filter((f: any) => Math.abs(f.balance.amount) > 0.005);
      if (owing.length) {
        throw new ToolError(
          `Check-out refused: ${owing.map((f: any) => `folio ${f.id} owes ${money(f.balance)}`).join(', ')}. `
          + 'Take payment with finance_post_payment, then call booking_check_out again. '
          + 'The outstanding nights have already been posted.',
        );
      }
      throw err;
    }
    const r = await call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` });
    return {
      text: `${r.id} checked out. Balance ${money(r.balance)}. Room ${r.unit?.name ?? ''} is now dirty.`,
      data: { reservationId: r.id, status: r.status, balance: r.balance },
    };
  },
};

const cancelReservation = {
  name: 'booking_cancel',
  title: 'Cancel a reservation',
  doc: {
    summary: 'Cancel a reservation, posting the cancellation fee its policy requires.',
    use: ['A guest cancels a confirmed booking.'],
    avoid: [
      'A guest who never arrived - use booking_mark_no_show, which applies the no-show fee.',
      'Shortening a stay - use booking_amend_stay.',
    ],
    returns: 'The cancellation fee charged and the resulting balance.',
    notes: [
      'Irreversible. There is no un-cancel; the stay would have to be re-booked.',
      'The fee comes from the rate plan policy. Read it with booking_get_reservation first '
      + 'so the guest can be told what they will be charged.',
      'The room is released back to inventory.',
    ],
  },
  input: { reservationId: arg.reservationId, confirm: arg.confirm },
  annotations: { destructive: true, idempotent: false, requiresConfirmation: true },
  async handler(args: any) {
    const r = await call<any>(
      { method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` },
      { subject: `Reservation '${args.reservationId}'`, discoverWith: 'booking_find_reservations' },
    );
    const fee = r.cancellationFee?.fee;
    requireConfirmation(
      args.confirm,
      `Cancelling ${r.id} (${person(r.primaryGuest)}, ${day(r.arrival)} to ${day(r.departure)}) would charge `
      + `a cancellation fee of ${fee?.amount ? money(fee) : 'nothing'} and cannot be undone.`,
    );

    await callVoid({
      method: 'PUT',
      path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/cancel`,
    }, { subject: `Reservation '${args.reservationId}'` });

    const after = await call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` });
    return {
      text: sections(
        `${after.id} cancelled.`,
        facts({
          guest: person(after.primaryGuest),
          cancellationFee: fee?.amount ? money(fee) : 'none',
          balanceNow: money(after.balance),
          room: 'released',
        }),
      ),
      data: { reservationId: after.id, status: after.status, cancellationFee: fee, balance: after.balance },
    };
  },
};

const markNoShow = {
  name: 'booking_mark_no_show',
  title: 'Mark a no-show',
  doc: {
    summary: 'Record that a guest never arrived, posting the no-show fee.',
    use: ['The arrival date has passed and the guest did not appear.'],
    avoid: [
      'A guest who cancelled in advance - use booking_cancel.',
      'Marking every unclaimed arrival at once - operations_run_night_audit does that.',
    ],
    returns: 'The no-show fee charged and the resulting balance.',
    notes: [
      'Irreversible.',
      'Only possible on or after the arrival date.',
    ],
  },
  input: { reservationId: arg.reservationId, confirm: arg.confirm },
  annotations: { destructive: true, idempotent: false, requiresConfirmation: true },
  async handler(args: any) {
    const r = await call<any>(
      { method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` },
      { subject: `Reservation '${args.reservationId}'`, discoverWith: 'booking_find_reservations' },
    );
    const fee = r.noShowFee?.fee;
    requireConfirmation(
      args.confirm,
      `Marking ${r.id} (${person(r.primaryGuest)}) as a no-show would charge `
      + `${fee?.amount ? money(fee) : 'nothing'} and cannot be undone.`,
    );
    await callVoid({
      method: 'PUT',
      path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/noshow`,
    }, { subject: `Reservation '${args.reservationId}'` });
    const after = await call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` });
    return {
      text: `${after.id} marked as a no-show. Fee ${fee?.amount ? money(fee) : 'none'}. Balance ${money(after.balance)}.`,
      data: { reservationId: after.id, status: after.status, noShowFee: fee, balance: after.balance },
    };
  },
};

const manageServices = {
  name: 'booking_manage_services',
  title: 'Add or remove an extra',
  doc: {
    summary: 'Add a service to a reservation, or take one off it.',
    use: [
      'A guest adds breakfast, parking or a late check-out.',
      'Removing an extra the guest no longer wants.',
    ],
    avoid: [
      'A one-off charge that is not a configured service - use finance_post_charge.',
      'Discounting something already posted - use finance_post_allowance.',
    ],
    returns: 'The reservation services after the change, with the new total.',
    notes: [
      'Only services configured on the property can be added. List them with rates_list_services.',
      'A service included in the rate plan cannot be removed.',
      'Adding a service that is already booked replaces its dates rather than duplicating it.',
    ],
  },
  input: {
    reservationId: arg.reservationId,
    action: z.enum(['add', 'remove']).describe('Whether to add the service or take it off.'),
    serviceId: z.string().describe('Service id, e.g. "MUC-BRKF". From rates_list_services.'),
    dates: z.array(arg.date('Service date')).optional()
      .describe('add only: specific dates. Omit to use the service default across the stay.'),
    unitPrice: z.number().optional()
      .describe('add only: override the gross price per unit for this booking.'),
  },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    const subject = `Reservation '${args.reservationId}'`;
    if (args.action === 'add') {
      const property = (await call<any>(
        { method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` },
        { subject, discoverWith: 'booking_find_reservations' },
      )).property.id;
      const known = await listServices(property);
      if (!known.some((s) => s.id === args.serviceId)) {
        throw new ToolError(
          `No service '${args.serviceId}' at ${property}. Available: `
          + `${known.map((s) => s.id).join(', ') || '(none configured)'}.`,
        );
      }
      await callVoid({
        method: 'PUT',
        path: `/booking/v1/reservation-actions/${encodeURIComponent(args.reservationId)}/book-service`,
        body: {
          serviceId: args.serviceId,
          dates: args.dates,
          ...(args.unitPrice === undefined ? {} : { amount: { amount: args.unitPrice, currency: 'EUR' } }),
        },
      }, { subject });
    } else {
      await callVoid({
        method: 'DELETE',
        path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}/services`,
        query: { serviceId: args.serviceId },
      }, { subject });
    }

    const r = await call<any>({ method: 'GET', path: `/booking/v1/reservations/${encodeURIComponent(args.reservationId)}` });
    const rows = (r.services ?? []).map((s: any) => ({
      code: s.service?.code ?? s.service?.id,
      dates: s.dates.length,
      total: { amount: s.totalAmount.grossAmount, currency: s.totalAmount.currency },
    }));
    return {
      text: sections(
        `${args.action === 'add' ? 'Added' : 'Removed'} ${args.serviceId} on ${r.id}.`,
        rows.length ? table(rows, [
          { header: 'service', value: (s: any) => s.code },
          { header: 'dates', value: (s: any) => String(s.dates), align: 'right' },
          { header: 'total', value: (s: any) => money(s.total), align: 'right' },
        ]) : 'No services on this reservation.',
        `Reservation total is now ${money(r.totalGrossAmount)}.`,
      ),
      data: { reservationId: r.id, services: rows, total: r.totalGrossAmount },
    };
  },
};

/** Registered in a fixed order: the spec asks for deterministic tool listing. */
export function registerBooking(server: McpServer): void {
  for (const spec of [
    quoteStay, findReservations, getReservation, createBooking, amendStay,
    assignRoom, releaseRoom, checkIn, revertCheckIn, checkOut,
    cancelReservation, markNoShow, manageServices,
  ]) {
    register(server, spec as never);
  }
}

export { addDays, businessDate, invalidate };
