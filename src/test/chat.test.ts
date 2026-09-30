import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolCalls, type ChatEvent } from '../chat/agent';
import { toolFacts, runTool, resetBridge } from '../chat/bridge';
import { invalidate } from '../mcp/core/context';
import { seed } from '../cli/seed';
import { resetDb } from '../core/db';

/**
 * The chat is an agent loop over the MCP surface, so most of its behaviour is
 * already covered by the MCP suite. What is new here - and what these tests
 * are about - is the approval gate: the model may ask for an irreversible
 * action, but only a human may authorise it.
 */

/** A fake assistant turn containing one tool call, as the model would emit it. */
const assistantCalling = (id: string, name: string, input: Record<string, unknown>) =>
  ({ role: 'assistant' as const, content: [{ type: 'tool_use', id, name, input }] as any });

function recorder() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => void events.push(e) };
}

/** Read a reservation's status straight from the MCP surface. */
async function statusOf(id: string): Promise<string> {
  const { text } = await runTool('booking_get_reservation', { reservationId: id });
  return /status\s+(\w+)/i.exec(text)?.[1] ?? text.slice(0, 80);
}

async function aConfirmedReservation(): Promise<string> {
  const { text } = await runTool('booking_find_reservations', { propertyId: 'BER' });
  const row = text.split('\n').find((l) => l.includes('Confirmed'));
  const id = row?.trim().split(/\s+/)[0];
  assert.ok(id, `no confirmed reservation found in:\n${text}`);
  return id!;
}

describe('chat approval gate', () => {
  before(() => {
    resetDb();
    seed({ reset: true });
    invalidate();
  });
  after(async () => { await resetBridge(); });

  test('the bridge sees every tool and knows which are gated', async () => {
    const { tools, gated, readOnly } = await toolFacts();
    assert.equal(tools.length, 45);
    assert.deepEqual([...gated].sort(), [
      'booking_cancel', 'booking_mark_no_show',
      'finance_cancel_invoice', 'finance_post_refund',
      'operations_run_night_audit',
      'rates_set_overbooking', 'rates_set_prices',
    ]);
    // Every tool must carry a usable schema, or the model cannot call it.
    for (const t of tools) {
      assert.equal(t.input_schema.type, 'object', `${t.name} has no object schema`);
      assert.ok(t.description.length > 40, `${t.name} has a thin description`);
    }
    assert.ok(readOnly.size > 0);
  });

  test('a gated call with confirm=true is not executed without a human verdict', async () => {
    const id = await aConfirmedReservation();
    const { events, emit } = recorder();

    const out = await resolveToolCalls(
      assistantCalling('tu_1', 'booking_cancel', { reservationId: id, confirm: true }),
      {},
      emit,
    );

    // The loop must stop and wait.
    assert.equal(out, null, 'the turn continued instead of pausing for approval');
    assert.deepEqual(events.map((e) => e.type), ['approval_required']);

    // And - the point of the whole exercise - nothing happened.
    assert.equal(await statusOf(id), 'Confirmed');
  });

  test('a denied call is reported back to the model, still without acting', async () => {
    const id = await aConfirmedReservation();
    const { events, emit } = recorder();

    const out = await resolveToolCalls(
      assistantCalling('tu_2', 'booking_cancel', { reservationId: id, confirm: true }),
      { tu_2: 'deny' },
      emit,
    );

    assert.ok(out, 'a decided call should produce tool results');
    assert.equal(out!.length, 1);
    const result = out![0] as any;
    assert.equal(result.is_error, true);
    assert.match(String(result.content), /declined/i);
    // No tool_call event means runTool was never reached.
    assert.ok(!events.some((e) => e.type === 'tool_call'), 'the tool ran despite being denied');
    assert.equal(await statusOf(id), 'Confirmed');
  });

  test('an approved call goes through', async () => {
    const id = await aConfirmedReservation();
    const { events, emit } = recorder();

    const out = await resolveToolCalls(
      assistantCalling('tu_3', 'booking_cancel', { reservationId: id, confirm: true }),
      { tu_3: 'approve' },
      emit,
    );

    assert.ok(out && out.length === 1);
    assert.ok(events.some((e) => e.type === 'tool_call'), 'the approved tool never ran');
    assert.equal(await statusOf(id), 'Canceled');
  });

  test('ordinary tools need no approval', async () => {
    const { events, emit } = recorder();
    const out = await resolveToolCalls(
      assistantCalling('tu_4', 'insight_list_properties', {}),
      {},
      emit,
    );
    assert.ok(out && out.length === 1);
    assert.ok(events.some((e) => e.type === 'tool_call'));
    assert.ok(!events.some((e) => e.type === 'approval_required'));
  });

  test('a gated tool called without confirm runs and refuses on its own terms', async () => {
    // This is the path the model is told to take first: no approval prompt,
    // because nothing can happen - the tool itself declines and explains.
    const id = await aConfirmedReservation();
    const { emit } = recorder();
    const out = await resolveToolCalls(
      assistantCalling('tu_5', 'booking_cancel', { reservationId: id }),
      {},
      emit,
    );
    assert.ok(out, 'should not pause: without confirm the call is harmless');
    const text = String((out![0] as any).content);
    assert.match(text, /confirm=true/);
    assert.equal(await statusOf(id), 'Confirmed');
  });
});
