import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, DOMAIN_NAMES, DOMAINS } from '../mcp/server';
import { invalidate } from '../mcp/core/context';
import { seed } from '../cli/seed';
import { resetDb } from '../core/db';

/**
 * The MCP surface is tested through a real client over the in-memory
 * transport, so what the tests see is exactly what a model would: the tool
 * list, the descriptions, the annotations, and the rendered text.
 */

async function connect(domains?: readonly (keyof typeof DOMAINS)[]) {
  const server = buildServer(domains ? { domains } : {});
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Call a tool and return its text, asserting it did not error. */
async function callOk(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
  assert.ok(!result.isError, `${name} failed: ${text}`);
  return { text, data: result.structuredContent };
}

/** Call a tool expecting it to report a tool-execution error. */
async function callFails(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
  assert.ok(result.isError, `${name} was expected to fail but returned: ${text}`);
  return text;
}

describe('mcp surface', () => {
  before(() => {
    resetDb();
    seed({ reset: true });
    invalidate();
  });

  test('every domain mounts and lists its tools', async () => {
    for (const domain of DOMAIN_NAMES) {
      const { client, close } = await connect([domain]);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, `${domain} registered no tools`);
      assert.ok(tools.every((t) => t.name.startsWith(domain) || /^(rates|setup)_/.test(t.name)),
        `${domain} has tools outside its namespace: ${tools.map((t) => t.name).join(', ')}`);
      await close();
    }
  });

  test('tool names are unique across the combined server', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
    assert.ok(names.length >= 40, `expected the full surface, got ${names.length}`);
    await close();
  });

  test('tool listing is deterministic, so clients can cache it', async () => {
    const first = await connect();
    const a = (await first.client.listTools()).tools.map((t) => t.name);
    await first.close();

    const second = await connect();
    const b = (await second.client.listTools()).tools.map((t) => t.name);
    await second.close();

    assert.deepEqual(a, b);
  });

  test('every tool carries a title, a structured description and annotations', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has no title`);
      assert.ok(tool.description, `${tool.name} has no description`);
      assert.match(tool.description!, /USE WHEN/, `${tool.name} does not say when to use it`);
      assert.match(tool.description!, /DO NOT USE FOR/, `${tool.name} does not say when not to`);
      assert.match(tool.description!, /RETURNS:/, `${tool.name} does not say what it returns`);
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      assert.equal(typeof tool.annotations!.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations!.openWorldHint, false, `${tool.name} openWorldHint`);
      assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
    }
    await close();
  });

  test('read-only tools are marked read-only and writing tools are not', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of [
      'insight_list_properties', 'insight_availability', 'insight_performance',
      'booking_quote_stay', 'booking_find_reservations', 'finance_get_folio',
      'operations_day_board', 'operations_preview_night_audit', 'rates_get_prices',
    ]) {
      assert.equal(byName.get(name)!.annotations!.readOnlyHint, true, `${name} should be read-only`);
    }
    for (const name of [
      'booking_create', 'booking_cancel', 'booking_check_in', 'finance_post_payment',
      'operations_run_night_audit', 'rates_set_prices',
    ]) {
      assert.equal(byName.get(name)!.annotations!.readOnlyHint, false, `${name} must not claim read-only`);
    }
    // Everything irreversible is flagged destructive.
    for (const name of [
      'booking_cancel', 'booking_mark_no_show', 'operations_run_night_audit',
      'finance_post_refund', 'finance_cancel_invoice', 'rates_set_prices',
    ]) {
      assert.equal(byName.get(name)!.annotations!.destructiveHint, true, `${name} should be destructive`);
    }
    await close();
  });

  test('resources and prompts are exposed', async () => {
    const { client, close } = await connect();
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === 'apaleo://properties'));
    assert.ok(resources.some((r) => r.uri === 'apaleo://glossary'));

    const read = await client.readResource({ uri: 'apaleo://properties' });
    const payload = JSON.parse((read.contents[0] as { text: string }).text);
    assert.equal(payload.length, 2);
    assert.ok(payload[0].businessDate);

    const { prompts } = await client.listPrompts();
    assert.ok(prompts.length >= 5);
    const briefing = await client.getPrompt({ name: 'morning_briefing', arguments: {} });
    assert.match((briefing.messages[0]!.content as { text: string }).text, /operations_day_board/);
    await close();
  });

  test('a read tool renders a compact table', async () => {
    const { client, close } = await connect(['insight']);
    const { text, data } = await callOk(client, 'insight_list_properties');
    assert.match(text, /propertyId/);
    assert.match(text, /MUC/);
    assert.match(text, /BER/);
    assert.equal((data as any).properties.length, 2);
    await close();
  });

  test('quoting a stay returns bookable rates with ids to book with', async () => {
    const { client, close } = await connect(['booking', 'insight']);
    const props: any = (await callOk(client, 'insight_list_properties')).data;
    const businessDate = props.properties.find((p: any) => p.id === 'MUC').businessDate;
    const arrival = addDays(businessDate, 20);
    const departure = addDays(arrival, 2);

    const { text, data } = await callOk(client, 'booking_quote_stay', {
      propertyId: 'MUC', arrival, departure, adults: 2,
    });
    assert.match(text, /ratePlanId/);
    assert.ok((data as any).offers.length > 0);
    assert.equal((data as any).nights, 2);
    // Prices must be real numbers, not zero placeholders.
    assert.ok((data as any).offers.every((o: any) => o.total.amount > 0));
    await close();
  });

  test('the full booking lifecycle works through the tools alone', async () => {
    const { client, close } = await connect();
    const props: any = (await callOk(client, 'insight_list_properties')).data;
    const businessDate = props.properties.find((p: any) => p.id === 'MUC').businessDate;

    const quote: any = (await callOk(client, 'booking_quote_stay', {
      propertyId: 'MUC', arrival: businessDate, departure: addDays(businessDate, 1), adults: 1,
    })).data;
    const offer = quote.offers.find((o: any) => o.blocked.length === 0);
    assert.ok(offer, 'no bookable offer for tonight');

    const created: any = (await callOk(client, 'booking_create', {
      booker: { firstName: 'Mia', lastName: 'Sørensen', email: 'mia@example.com' },
      stays: [{
        arrival: businessDate,
        departure: addDays(businessDate, 1),
        ratePlanId: offer.ratePlanId,
        adults: 1,
      }],
    })).data;
    const reservationId = created.reservationIds[0];
    assert.ok(reservationId);

    // Check-in is blocked until a room is assigned, and the tool says so.
    const blocked = await callFails(client, 'booking_check_in', { reservationId });
    assert.match(blocked, /unit must be assigned|room/i);

    await callOk(client, 'booking_assign_room', { reservationId });
    const after: any = (await callOk(client, 'booking_check_in', { reservationId })).data;
    assert.equal(after.status, 'InHouse');
    assert.ok(after.balance.amount > 0, 'check-in should post the night');

    // Check-out reports the amount owed rather than failing opaquely.
    const owed = await callFails(client, 'booking_check_out', { reservationId });
    assert.match(owed, /owes/);

    const detail: any = (await callOk(client, 'booking_get_reservation', { reservationId })).data;
    const folioId = detail.folios[0].id;
    await callOk(client, 'finance_post_payment', { folioId, method: 'Cash' });
    const out: any = (await callOk(client, 'booking_check_out', { reservationId })).data;
    assert.equal(out.status, 'CheckedOut');
    assert.equal(out.balance.amount, 0);
    await close();
  });

  test('destructive tools refuse without confirmation and say what would happen', async () => {
    const { client, close } = await connect();
    const props: any = (await callOk(client, 'insight_list_properties')).data;
    const businessDate = props.properties.find((p: any) => p.id === 'MUC').businessDate;

    const quote: any = (await callOk(client, 'booking_quote_stay', {
      propertyId: 'MUC', arrival: addDays(businessDate, 40), departure: addDays(businessDate, 42), adults: 1,
    })).data;
    const created: any = (await callOk(client, 'booking_create', {
      booker: { lastName: 'Cancellable' },
      stays: [{
        arrival: addDays(businessDate, 40),
        departure: addDays(businessDate, 42),
        ratePlanId: quote.offers[0].ratePlanId,
        adults: 1,
      }],
    })).data;
    const reservationId = created.reservationIds[0];

    const refusal = await callFails(client, 'booking_cancel', { reservationId });
    assert.match(refusal, /confirm=true/);
    assert.match(refusal, /cancellation fee/i);

    // Still confirmed: the refusal really did nothing.
    const before: any = (await callOk(client, 'booking_get_reservation', { reservationId })).data;
    assert.equal(before.reservation.status, 'Confirmed');

    const done: any = (await callOk(client, 'booking_cancel', { reservationId, confirm: true })).data;
    assert.equal(done.status, 'Canceled');
    await close();
  });

  test('the night audit refuses without confirmation and previews safely', async () => {
    const { client, close } = await connect(['operations']);
    const preview: any = (await callOk(client, 'operations_preview_night_audit', { propertyId: 'MUC' })).data;
    assert.ok(preview.businessDate);
    assert.ok(preview.nextBusinessDate > preview.businessDate);

    const refusal = await callFails(client, 'operations_run_night_audit', { propertyId: 'MUC' });
    assert.match(refusal, /confirm=true/);

    // The preview changed nothing.
    const again: any = (await callOk(client, 'operations_preview_night_audit', { propertyId: 'MUC' })).data;
    assert.equal(again.businessDate, preview.businessDate);
    await close();
  });

  test('errors name the tool that would find valid ids', async () => {
    const { client, close } = await connect();
    const missing = await callFails(client, 'booking_get_reservation', { reservationId: 'NOPE-1' });
    assert.match(missing, /not found/i);
    assert.match(missing, /booking_find_reservations/);

    const badFolio = await callFails(client, 'finance_get_folio', { folioId: 'NOPE-1-1' });
    assert.match(badFolio, /finance_find_folios/);

    // The API restates the id in its own message. Saying it twice - "Reservation
    // 'NOPE-1': not found. Reservation 'NOPE-1' was not found." - reads as a
    // stutter and wastes the model's attention, so the id appears exactly once.
    assert.equal(missing.match(/NOPE-1/g)?.length, 1, `id repeated: ${missing}`);
    await close();
  });

  test('validation failures come back as actionable text, not a crash', async () => {
    const { client, close } = await connect(['booking']);
    const text = await callFails(client, 'booking_quote_stay', {
      propertyId: 'MUC', arrival: '2026-05-10', departure: '2026-05-10', adults: 1,
    });
    assert.match(text, /at least one day after/);
    await close();
  });

  test('an unknown property lists the ones that exist', async () => {
    const { client, close } = await connect(['insight']);
    const text = await callFails(client, 'insight_availability', { propertyId: 'ZZZ' });
    assert.match(text, /No property 'ZZZ'/);
    assert.match(text, /MUC/);
    await close();
  });

  test('a derived rate plan cannot be priced directly', async () => {
    const { client, close } = await connect(['setup']);
    const plans: any = (await callOk(client, 'rates_list_plans', { propertyId: 'MUC' })).data;
    const derived = plans.ratePlans.find((p: any) => p.isDerived);
    assert.ok(derived, 'the seed should contain a derived plan');

    const text = await callFails(client, 'rates_set_prices', {
      ratePlanId: derived.id, from: '2026-06-01', to: '2026-06-02', price: 100, confirm: true,
    });
    assert.match(text, /derived/);
    assert.match(text, /Set prices on/);
    await close();
  });

  test('the ledger balances and says so', async () => {
    const { client, close } = await connect(['finance']);
    const { text, data } = await callOk(client, 'finance_ledger', { propertyId: 'MUC' });
    assert.equal((data as any).balanced, true);
    assert.match(text, /balanced/);
    await close();
  });

  test('every irreversible tool is gated behind confirm=true', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();

    // The list is explicit on purpose. An operation that cannot be undone by
    // calling another tool belongs here, and adding one to the surface
    // without adding it here should fail this test.
    const irreversible = [
      'booking_cancel', 'booking_mark_no_show',
      'finance_post_refund', 'finance_cancel_invoice',
      'operations_run_night_audit',
      'rates_set_prices', 'rates_set_overbooking',
    ];

    const gated = tools.filter((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return 'confirm' in props;
    }).map((t) => t.name);

    assert.deepEqual(
      gated.sort(),
      [...irreversible].sort(),
      'the set of confirmation-gated tools drifted from the irreversible ones',
    );

    for (const name of irreversible) {
      const tool = tools.find((t) => t.name === name)!;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      assert.ok(!required.includes('confirm'), `${name} should default confirm to false, not require it`);
      assert.equal(tool._meta?.['io.apaleo/requiresConfirmation'], true, `${name} should advertise the gate`);
    }

    // And each must actually refuse when pointed at a real target. The
    // confirmation check deliberately runs *after* the entity is read, so the
    // refusal can quote the real fee - which means a fake id would 404 first
    // and prove nothing.
    const found: any = (await callOk(client, 'booking_find_reservations', {
      propertyId: 'MUC', dateFilter: 'Stay', from: '2026-01-01', to: '2027-01-01', limit: 1,
    })).data;
    const reservationId = found.reservations[0].id;
    const folios: any = (await callOk(client, 'finance_find_folios', { propertyId: 'MUC', limit: 1 })).data;
    const folioId = folios.folios[0].id;

    const live: [string, Record<string, unknown>][] = [
      ['booking_cancel', { reservationId }],
      ['booking_mark_no_show', { reservationId }],
      ['finance_post_refund', { folioId, amount: 1 }],
      ['operations_run_night_audit', { propertyId: 'MUC' }],
      ['rates_set_prices', { ratePlanId: 'MUC-FLEX-DBL', from: '2026-06-01', to: '2026-06-02', price: 100 }],
      ['rates_set_overbooking', { unitGroupId: 'MUC-DBL', from: '2026-06-01', to: '2026-06-02', count: 1 }],
    ];
    for (const [name, args] of live) {
      const text = await callFails(client, name, args);
      assert.match(text, /confirm=true/, `${name} acted without confirmation`);
    }
    await close();
  });

  test('results are capped and say how much was held back', async () => {
    const { client, close } = await connect(['booking']);
    const { text } = await callOk(client, 'booking_find_reservations', {
      propertyIds: undefined, propertyId: 'MUC', dateFilter: 'Stay',
      from: '2026-01-01', to: '2027-01-01', limit: 3,
    });
    assert.match(text, /Showing 3 of \d+/);
    await close();
  });
});

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
