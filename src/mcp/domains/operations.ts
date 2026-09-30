import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arg, register, requireConfirmation } from '../core/define';
import { ToolError } from '../core/errors';
import {
  addDays, businessDate, call, callList, callVoid, invalidate, resolveProperty, unitNames, window,
} from '../core/context';
import { capped, day, facts, money, person, sections, table } from '../core/render';

/** Daily operations: the front desk board, housekeeping, and the night audit. */

const CONDITIONS = ['Clean', 'CleanToBeInspected', 'Dirty'] as const;
const MAINTENANCE_TYPES = ['OutOfService', 'OutOfOrder', 'OutOfInventory'] as const;

const dayBoard = {
  name: 'operations_day_board',
  title: 'Front desk day board',
  doc: {
    summary: 'The whole picture for one day: arrivals, departures, who is in house, and what needs attention.',
    use: [
      'Starting a shift, or answering "what is happening today".',
      'Finding which arrivals still need a room before check-in.',
      'Seeing who is leaving with an unpaid balance.',
    ],
    avoid: [
      'A range of dates - use insight_performance or booking_find_reservations.',
      'Room cleanliness - use operations_room_board.',
    ],
    returns: 'Occupancy for the day plus three lists: arrivals, departures and in-house, with what blocks each.',
    notes: [
      'Defaults to the property business date, which is not always today - the night audit moves it.',
      'Arrivals without a room are called out: they cannot be checked in until one is assigned.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    date: arg.optionalDate('Day to report on. Defaults to the property business date.'),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const date = args.date ?? await businessDate(property);

    const [availability, arrivals, departures, inHouse] = await Promise.all([
      callList<any>({
        method: 'GET',
        path: '/availability/v1/unit-groups',
        query: { propertyId: property.id, from: date, to: addDays(date, 1) },
      }, 'timeSlices'),
      callList<any>({
        method: 'GET',
        path: '/booking/v1/reservations',
        query: { propertyIds: property.id, dateFilter: 'Arrival', from: date, to: date, pageSize: 200 },
      }, 'reservations'),
      callList<any>({
        method: 'GET',
        path: '/booking/v1/reservations',
        query: { propertyIds: property.id, dateFilter: 'Departure', from: date, to: date, pageSize: 200 },
      }, 'reservations'),
      callList<any>({
        method: 'GET',
        path: '/booking/v1/reservations',
        query: { propertyIds: property.id, status: 'InHouse', pageSize: 200 },
      }, 'reservations'),
    ]);

    const house = availability.items[0]?.property;
    const pendingArrivals = arrivals.items.filter((r: any) => r.status === 'Confirmed');
    const unassigned = pendingArrivals.filter((r: any) => !r.unit);
    const pendingDepartures = departures.items.filter((r: any) => r.status === 'InHouse');
    const owing = inHouse.items.filter((r: any) => (r.balance?.amount ?? 0) > 0);

    const stayRow = (r: any) => ({
      id: r.id,
      guest: person(r.primaryGuest) || '(no name)',
      status: r.status,
      room: r.unit?.name ?? '—',
      type: r.unitGroup?.name ?? '',
      dates: `${day(r.arrival)}→${day(r.departure)}`,
      balance: r.balance,
    });

    const columns = [
      { header: 'id', value: (r: any) => r.id },
      { header: 'guest', value: (r: any) => r.guest },
      { header: 'status', value: (r: any) => r.status },
      { header: 'room', value: (r: any) => r.room },
      { header: 'type', value: (r: any) => r.type },
      { header: 'stay', value: (r: any) => r.dates },
      { header: 'balance', value: (r: any) => money(r.balance), align: 'right' as const },
    ];

    return {
      text: sections(
        `${property.name} · business date ${date}`,
        house ? facts({
          rooms: `${house.soldCount} sold of ${house.houseCount} in house`,
          occupancy: `${house.occupancy}%`,
          sellable: house.sellableCount,
          outOfOrder: house.maintenance.outOfService + house.maintenance.outOfOrder || undefined,
        }) : null,
        `ARRIVALS (${arrivals.items.length}, ${pendingArrivals.length} still to check in)\n`
        + table(arrivals.items.map(stayRow), columns),
        `DEPARTURES (${departures.items.length}, ${pendingDepartures.length} still to check out)\n`
        + table(departures.items.map(stayRow), columns),
        `IN HOUSE (${inHouse.items.length})\n` + table(inHouse.items.slice(0, 25).map(stayRow), columns),
        unassigned.length
          ? `NEEDS A ROOM: ${unassigned.map((r: any) => r.id).join(', ')} — `
            + 'assign with booking_assign_room before check-in.'
          : null,
        owing.length
          ? `OPEN BALANCES: ${owing.map((r: any) => `${r.id} ${money(r.balance)}`).join(', ')}`
          : null,
      ),
      data: {
        property: property.id,
        businessDate: date,
        house,
        arrivals: arrivals.items.map(stayRow),
        departures: departures.items.map(stayRow),
        inHouse: inHouse.items.map(stayRow),
        needsRoom: unassigned.map((r: any) => r.id),
      },
    };
  },
};

const roomBoard = {
  name: 'operations_room_board',
  title: 'Housekeeping board',
  doc: {
    summary: 'Every room with its housekeeping condition, occupancy and maintenance.',
    use: [
      'Producing a cleaning list.',
      'Answering "which rooms are dirty" or "what is out of order".',
      'Checking a room is ready before assigning it.',
    ],
    avoid: [
      'Changing conditions - use operations_set_room_condition.',
      'How many rooms are sellable on a future date - use insight_availability.',
    ],
    returns: 'One row per room: name, type, condition, whether occupied, and any maintenance.',
    notes: ['Condition is a present-tense fact about the room, not a forecast.'],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    condition: z.enum(CONDITIONS).optional().describe('Keep only rooms in this condition.'),
    occupied: z.boolean().optional().describe('Filter to occupied or vacant rooms.'),
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
        unitCondition: args.condition,
        isOccupied: args.occupied,
        pageSize: Math.min(args.limit, 300),
      },
    }, 'units');

    if (!items.length) return { text: `No rooms at ${property.name} match those filters.`, data: { count: 0, rooms: [] } };

    const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const { shown, note } = capped(sorted, count, args.limit);
    const tally = CONDITIONS.map((c) => `${c}: ${items.filter((u: any) => u.status.condition === c).length}`);

    return {
      text: sections(
        `${property.name} · ${count} room(s) · ${tally.join(' · ')}`,
        table(shown, [
          { header: 'room', value: (u: any) => u.name },
          { header: 'unitId', value: (u: any) => u.id },
          { header: 'type', value: (u: any) => u.unitGroup?.name ?? '' },
          { header: 'condition', value: (u: any) => u.status.condition },
          { header: 'occupied', value: (u: any) => (u.status.isOccupied ? 'yes' : '') },
          { header: 'maintenance', value: (u: any) => u.status.maintenance?.type ?? '' },
        ]) + note,
      ),
      data: { count, rooms: shown.map((u: any) => ({ id: u.id, name: u.name, condition: u.status.condition, occupied: u.status.isOccupied })) },
    };
  },
};

const setRoomCondition = {
  name: 'operations_set_room_condition',
  title: 'Set room conditions',
  doc: {
    summary: 'Change the housekeeping condition of one or more rooms.',
    use: [
      'Housekeeping reports a floor cleaned.',
      'Marking a room dirty after an inspection failed.',
    ],
    avoid: [
      'Taking a room out of service - use operations_schedule_maintenance.',
      'Reading conditions - use operations_room_board.',
    ],
    returns: 'The rooms updated and their new condition.',
    notes: [
      'Pass several unitIds to update a whole floor in one call rather than looping.',
      'Condition does not affect availability. An out-of-order room does; a dirty one does not.',
    ],
  },
  input: {
    unitIds: z.array(z.string()).min(1).max(200)
      .describe('Room ids to update, e.g. ["MUC-MTA","MUC-JQI"]. From operations_room_board.'),
    condition: z.enum(CONDITIONS).describe('The condition to set on all of them.'),
  },
  annotations: { destructive: false, idempotent: true },
  async handler(args: any) {
    await callVoid({
      method: 'PUT',
      path: '/operations/v1/units-condition',
      body: { unitsConditions: args.unitIds.map((id: string) => ({ id, condition: args.condition })) },
    });
    invalidate('unitNames');
    return {
      text: `${args.unitIds.length} room(s) set to ${args.condition}: ${args.unitIds.join(', ')}.`,
      data: { unitIds: args.unitIds, condition: args.condition },
    };
  },
};

const scheduleMaintenance = {
  name: 'operations_schedule_maintenance',
  title: 'Schedule maintenance',
  doc: {
    summary: 'Take a room out of service for a period so it cannot be sold.',
    use: [
      'A room needs a repair or refurbishment.',
      'Removing a room from the house count during building work.',
    ],
    avoid: [
      'Marking a room dirty - use operations_set_room_condition.',
      'Removing a window - use operations_cancel_maintenance.',
    ],
    returns: 'The maintenance record created.',
    notes: [
      'The three types behave differently. OutOfService and OutOfOrder stop the room being sold '
      + 'but leave it in the house count, so occupancy percentages still treat it as a room. '
      + 'OutOfInventory removes it from the house count entirely, which is what you want for '
      + 'long building work.',
      'Refused if the room is occupied or already has an overlapping window.',
    ],
  },
  input: {
    unitId: z.string().describe('Room id, e.g. "MUC-MTA". From operations_room_board.'),
    from: arg.date('First day out of service, YYYY-MM-DD.'),
    to: arg.date('Day the room returns to service, YYYY-MM-DD. Exclusive.'),
    type: z.enum(MAINTENANCE_TYPES).default('OutOfOrder')
      .describe('OutOfService = minor, OutOfOrder = unsellable, OutOfInventory = also drops the house count.'),
    description: z.string().optional().describe('What is being done. Shown on the housekeeping board.'),
  },
  annotations: { destructive: false, idempotent: false },
  async handler(args: any) {
    const created = await call<any>({
      method: 'POST',
      path: '/operations/v1/maintenances',
      body: {
        unitId: args.unitId,
        from: `${args.from}T00:00:00Z`,
        to: `${args.to}T00:00:00Z`,
        type: args.type,
        description: args.description,
      },
    }, { subject: `Room '${args.unitId}'`, discoverWith: 'operations_room_board' });
    return {
      text: `Room ${args.unitId} is ${args.type} from ${args.from} to ${args.to} (id ${created.id}).`,
      data: { maintenanceId: created.id, unitId: args.unitId, type: args.type, from: args.from, to: args.to },
    };
  },
};

const listMaintenance = {
  name: 'operations_list_maintenance',
  title: 'List maintenance',
  doc: {
    summary: 'List scheduled maintenance windows for a property.',
    use: ['Seeing what is out of service and when it comes back.'],
    avoid: ['Current room conditions - use operations_room_board.'],
    returns: 'One row per window: room, type, dates and description.',
  },
  input: {
    propertyId: arg.optionalPropertyId,
    from: arg.optionalDate('Window start. Defaults to the business date.'),
    to: arg.optionalDate('Window end. Defaults to 90 days out.'),
    limit: arg.limit(50, 200),
  },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const range = await window(property, args.from, args.to, 90);
    const [{ items, count }, names] = await Promise.all([
      callList<any>({
        method: 'GET',
        path: '/operations/v1/maintenances',
        query: { propertyId: property.id, from: range.from, to: range.to, pageSize: Math.min(args.limit, 200) },
      }, 'maintenances'),
      unitNames(property.id),
    ]);
    if (!items.length) {
      return { text: `No maintenance scheduled at ${property.name} between ${range.from} and ${range.to}.`, data: { count: 0 } };
    }
    const { shown, note } = capped(items, count, args.limit);
    return {
      text: sections(
        `${count} maintenance window(s) at ${property.name}`,
        table(shown, [
          { header: 'id', value: (m: any) => m.id },
          { header: 'room', value: (m: any) => names.get(m.unit.id) ?? m.unit.id },
          { header: 'type', value: (m: any) => m.type },
          { header: 'from', value: (m: any) => day(m.from) },
          { header: 'to', value: (m: any) => day(m.to) },
          { header: 'description', value: (m: any) => m.description ?? '' },
        ]) + note,
      ),
      data: { count, maintenances: shown },
    };
  },
};

const cancelMaintenance = {
  name: 'operations_cancel_maintenance',
  title: 'Cancel maintenance',
  doc: {
    summary: 'Remove a maintenance window, returning the room to inventory.',
    use: ['The repair finished early, or was scheduled by mistake.'],
    avoid: ['Shortening a window - remove it and schedule a new one.'],
    returns: 'Confirmation the window is gone.',
  },
  input: { maintenanceId: z.string().describe('From operations_list_maintenance.') },
  annotations: { destructive: true, idempotent: true },
  async handler(args: any) {
    await callVoid(
      { method: 'DELETE', path: `/operations/v1/maintenances/${encodeURIComponent(args.maintenanceId)}` },
      { subject: `Maintenance '${args.maintenanceId}'`, discoverWith: 'operations_list_maintenance' },
    );
    return { text: `Maintenance ${args.maintenanceId} removed; the room is sellable again.`, data: { maintenanceId: args.maintenanceId } };
  },
};

const nightAuditPreview = {
  name: 'operations_preview_night_audit',
  title: 'Preview the night audit',
  doc: {
    summary: 'Show what the night audit would change, without running it.',
    use: [
      'Before running the audit, to see which arrivals become no-shows.',
      'Checking nothing is still open for the day.',
    ],
    avoid: ['Actually closing the day - use operations_run_night_audit.'],
    returns: 'The business date, arrivals that would become no-shows, guests still to depart, and unassigned arrivals for tomorrow.',
    notes: ['Read-only. Always worth calling before the audit, because the audit cannot be undone.'],
  },
  input: { propertyId: arg.optionalPropertyId },
  annotations: { readOnly: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const date = await businessDate(property);

    const [pending, inHouse, tomorrow] = await Promise.all([
      callList<any>({
        method: 'GET',
        path: '/booking/v1/reservations',
        query: { propertyIds: property.id, status: 'Confirmed', dateFilter: 'Arrival', from: '1970-01-01', to: date, pageSize: 200 },
      }, 'reservations'),
      callList<any>({
        method: 'GET',
        path: '/booking/v1/reservations',
        query: { propertyIds: property.id, status: 'InHouse', pageSize: 200 },
      }, 'reservations'),
      callList<any>({
        method: 'GET',
        path: '/booking/v1/reservations',
        query: {
          propertyIds: property.id, status: 'Confirmed', dateFilter: 'Arrival',
          from: addDays(date, 1), to: addDays(date, 1), pageSize: 200,
        },
      }, 'reservations'),
    ]);

    const overdue = inHouse.items.filter((r: any) => day(r.departure) <= date);
    const unassignedTomorrow = tomorrow.items.filter((r: any) => !r.unit);
    const fees = pending.items.reduce((sum: number, r: any) => sum + (r.noShowFee?.fee?.amount ?? 0), 0);

    return {
      text: sections(
        `Night audit preview for ${property.name}, business date ${date}.`,
        facts({
          becomeNoShows: pending.items.length,
          noShowFees: fees ? money({ amount: fees, currency: property.currencyCode }) : 'none',
          nightsToPost: inHouse.items.length,
          overdueDepartures: overdue.length || undefined,
          unassignedTomorrow: unassignedTomorrow.length || undefined,
          nextBusinessDate: addDays(date, 1),
        }),
        pending.items.length
          ? `WOULD BECOME NO-SHOWS\n${table(pending.items, [
            { header: 'id', value: (r: any) => r.id },
            { header: 'guest', value: (r: any) => person(r.primaryGuest) },
            { header: 'arrival', value: (r: any) => day(r.arrival) },
            { header: 'fee', value: (r: any) => money(r.noShowFee?.fee), align: 'right' },
          ])}`
          : 'No unclaimed arrivals: nothing would be set to no-show.',
        overdue.length
          ? `STILL IN HOUSE PAST DEPARTURE: ${overdue.map((r: any) => `${r.id} (due ${day(r.departure)})`).join(', ')}`
          : null,
        unassignedTomorrow.length
          ? `ARRIVING TOMORROW WITHOUT A ROOM: ${unassignedTomorrow.map((r: any) => r.id).join(', ')}`
          : null,
      ),
      data: {
        businessDate: date,
        nextBusinessDate: addDays(date, 1),
        wouldBecomeNoShow: pending.items.map((r: any) => r.id),
        overdueDepartures: overdue.map((r: any) => r.id),
        unassignedTomorrow: unassignedTomorrow.map((r: any) => r.id),
      },
    };
  },
};

const runNightAudit = {
  name: 'operations_run_night_audit',
  title: 'Run the night audit',
  doc: {
    summary: 'Close the business date: post the day, mark no-shows, and move to tomorrow.',
    use: ['End of day, once arrivals and departures have been dealt with.'],
    avoid: [
      'Seeing what it would do - use operations_preview_night_audit.',
      'Posting one reservation - check-in and check-out already post their own charges.',
    ],
    returns: 'The date closed, what was posted, and the new business date.',
    notes: [
      'Cannot be undone. The business date only moves forward.',
      'Every unclaimed arrival becomes a no-show and is charged its fee unless '
      + 'markNoShows is false.',
      'Preview first. That is the whole reason the preview tool exists.',
    ],
  },
  input: {
    propertyId: arg.optionalPropertyId,
    markNoShows: z.boolean().default(true)
      .describe('Turn unclaimed arrivals into no-shows and charge the fee. Set false to roll them into tomorrow.'),
    confirm: arg.confirm,
  },
  annotations: { destructive: true, idempotent: false, requiresConfirmation: true },
  async handler(args: any) {
    const property = await resolveProperty(args.propertyId);
    const date = await businessDate(property);
    const pending = await callList<any>({
      method: 'GET',
      path: '/booking/v1/reservations',
      query: { propertyIds: property.id, status: 'Confirmed', dateFilter: 'Arrival', from: '1970-01-01', to: date, pageSize: 200 },
    }, 'reservations');

    requireConfirmation(
      args.confirm,
      `Running the night audit closes ${date} at ${property.name}`
      + (args.markNoShows && pending.items.length
        ? `, sets ${pending.items.length} unclaimed arrival(s) to no-show with their fees, `
        : ', ')
      + `and moves the property to ${addDays(date, 1)}. It cannot be undone.`,
    );

    await callVoid({
      method: 'PUT',
      path: '/operations/v1/night-audit',
      query: { propertyId: property.id, setReservationsToNoShow: args.markNoShows },
    });
    invalidate(`businessDate:${property.id}`);

    const logs = await callList<any>(
      { method: 'GET', path: '/logs/v1/finance/night-audit', query: { propertyIds: property.id, pageSize: 1 } },
      'logEntries',
    );
    const entry = logs.items[0];
    return {
      text: sections(
        `Night audit complete for ${property.name}.`,
        facts({
          closed: entry?.businessDate ?? date,
          status: entry?.status ?? 'Success',
          newBusinessDate: addDays(date, 1),
          noShowsMarked: args.markNoShows ? pending.items.length : 0,
        }),
        entry?.warnings?.length ? `WARNINGS\n${entry.warnings.map((w: string) => `- ${w}`).join('\n')}` : null,
      ),
      data: { closed: date, newBusinessDate: addDays(date, 1), noShowsMarked: args.markNoShows ? pending.items.length : 0 },
    };
  },
};

export function registerOperations(server: McpServer): void {
  for (const spec of [
    dayBoard, roomBoard, setRoomCondition,
    listMaintenance, scheduleMaintenance, cancelMaintenance,
    nightAuditPreview, runNightAudit,
  ]) {
    register(server, spec as never);
  }
}

export { ToolError };
