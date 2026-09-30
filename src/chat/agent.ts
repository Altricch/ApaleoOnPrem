/**
 * The chat agent: a tool-use loop over the MCP surface, streamed to the browser.
 *
 * Two design points are worth stating, because they are what make the chat
 * safe to point at a real property.
 *
 * 1. The conversation lives in the browser. Every turn posts the whole history
 *    back, so the server keeps no session state and a reload loses nothing but
 *    the tab.
 *
 * 2. The human, not the model, owns the confirmation gate. Seven MCP tools
 *    refuse to act without `confirm: true`. Nothing stops a model from simply
 *    passing it, so the server refuses to execute any gated call until the
 *    person at the keyboard has approved that exact tool-use id in the UI.
 *    The model can ask; only the human can answer.
 */
import Anthropic from '@anthropic-ai/sdk';
import { toolFacts, runTool } from './bridge';
import { chatConfig } from './config';

export type Decision = 'approve' | 'deny';

export interface TurnRequest {
  messages: Anthropic.MessageParam[];
  /** Verdicts for tool-use ids the previous turn paused on. */
  decisions?: Record<string, Decision>;
  /** Property the user is looking at, so the model does not have to ask. */
  propertyId?: string;
}

/** Everything the browser is told, in the order it happens. */
export type ChatEvent =
  | { type: 'ready'; model: string; tools: number }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'assistant'; content: Anthropic.ContentBlockParam[] }
  | { type: 'tool_call'; id: string; name: string; input: unknown; readOnly: boolean }
  | { type: 'tool_result'; id: string; ok: boolean; text: string }
  | { type: 'approval_required'; id: string; name: string; input: unknown }
  | { type: 'results'; content: Anthropic.ContentBlockParam[] }
  | { type: 'paused' }
  | { type: 'done'; stop: string | null }
  | { type: 'error'; message: string };

export type Emit = (event: ChatEvent) => void;

const SYSTEM = `You are the assistant inside an apaleo property-management system, helping
front-office and revenue staff get work done against real property data.

How to work:
- Reach for a tool rather than guessing. Never invent a reservation id, a rate, an
  availability figure or a balance - read it.
- Prefer one composite tool over several narrow ones: booking_quote_stay before offers
  and rates, operations_day_board before four separate lists.
- Tool output is already formatted as tables for a reader. Summarise the answer in a
  sentence or two and let the table carry the detail; do not restate every row in prose.
- When a tool reports an error, it tells you how to recover. Follow it rather than
  apologising or asking the user to fix it.

Irreversible actions:
- Seven tools cannot be undone and take a 'confirm' argument. Call one WITHOUT confirm
  first: it will refuse and tell you the exact consequence - the fee, the date that
  closes. Relay that to the user in their terms and ask whether to proceed.
- Only set confirm: true after the user has clearly agreed. The interface will still ask
  them to approve it, so never tell them an irreversible action is done until you have
  seen the tool result saying so.

Style: concise and concrete. You are talking to a hotelier, not a developer - say
"room 101 is out of order until Friday", not "the maintenance record was created".`;

function systemPrompt(propertyId: string | undefined): string {
  const today = new Date().toISOString().slice(0, 10);
  const where = propertyId
    ? `\n\nThe user is currently looking at property ${propertyId}. Use it as the default `
      + 'for any tool that needs a property, unless they name a different one.'
    : '';
  return `${SYSTEM}\n\nToday is ${today}.${where}`;
}

/**
 * Resolve the tool calls in a trailing assistant turn.
 *
 * This runs before the model is called again, and is the only place tools
 * execute. It returns null when a gated call still needs a human verdict, in
 * which case the caller must stop and wait.
 *
 * Exported so the approval gate can be tested without an API key: it is the
 * one piece of this file whose failure mode is a cancelled booking.
 */
export async function resolveToolCalls(
  assistant: Anthropic.MessageParam,
  decisions: Record<string, Decision>,
  emit: Emit,
): Promise<Anthropic.ContentBlockParam[] | null> {
  const { gated, readOnly } = await toolFacts();
  const blocks = (Array.isArray(assistant.content) ? assistant.content : []) as Anthropic.ContentBlock[];
  const calls = blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!calls.length) return [];

  // Ask about every gated call at once, so the user sees the whole cost of the
  // turn rather than being drip-fed one dialog at a time.
  const awaiting = calls.filter((c) => {
    const input = (c.input ?? {}) as Record<string, unknown>;
    return gated.has(c.name) && input.confirm === true && decisions[c.id] === undefined;
  });

  if (awaiting.length) {
    for (const call of awaiting) {
      emit({ type: 'approval_required', id: call.id, name: call.name, input: call.input });
    }
    return null;
  }

  const results: Anthropic.ContentBlockParam[] = [];
  for (const call of calls) {
    const input = (call.input ?? {}) as Record<string, unknown>;

    if (gated.has(call.name) && input.confirm === true && decisions[call.id] === 'deny') {
      const text = 'The user declined this action. It was not performed. '
        + 'Acknowledge the decision and ask what they would like to do instead.';
      emit({ type: 'tool_result', id: call.id, ok: false, text: 'Declined by the user.' });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: text, is_error: true });
      continue;
    }

    emit({
      type: 'tool_call',
      id: call.id,
      name: call.name,
      input: call.input,
      readOnly: readOnly.has(call.name),
    });

    const outcome = await runTool(call.name, input);
    emit({ type: 'tool_result', id: call.id, ok: !outcome.isError, text: outcome.text });
    results.push({
      type: 'tool_result',
      tool_use_id: call.id,
      content: outcome.text,
      ...(outcome.isError ? { is_error: true } : {}),
    });
  }
  return results;
}

/**
 * Run one exchange to completion, emitting as it goes.
 *
 * Returns when the model stops asking for tools, when a gated call needs a
 * human, or when the step budget runs out.
 */
export async function runTurn(request: TurnRequest, emit: Emit, signal?: AbortSignal): Promise<void> {
  const { apiKey, model, maxSteps, thinking } = chatConfig();
  if (!apiKey) {
    emit({
      type: 'error',
      message: 'No ANTHROPIC_API_KEY is configured, so the chat cannot reach a model. '
        + 'Set it in the environment and restart the server.',
    });
    return;
  }

  const client = new Anthropic({ apiKey });
  const { tools } = await toolFacts();
  const messages = [...request.messages];
  const decisions = request.decisions ?? {};

  emit({ type: 'ready', model, tools: tools.length });

  // A turn that resumes after an approval starts with the model's tool calls
  // already on the transcript; settle those before asking for more.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    const resolved = await resolveToolCalls(last, decisions, emit);
    if (!resolved) {
      emit({ type: 'paused' });
      return;
    }
    if (resolved.length) {
      emit({ type: 'results', content: resolved });
      messages.push({ role: 'user', content: resolved });
    }
  }

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return;

    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt(request.propertyId),
      tools: tools as unknown as Anthropic.Tool[],
      messages,
      ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
    }, { signal });

    stream.on('text', (text) => emit({ type: 'text_delta', text }));
    stream.on('thinking', (text) => emit({ type: 'thinking_delta', text }));

    const reply = await stream.finalMessage();
    if (signal?.aborted) return;

    // The content blocks go back verbatim on the next turn - thinking blocks
    // included, since their signatures are checked on replay.
    const content = reply.content as unknown as Anthropic.ContentBlockParam[];
    emit({ type: 'assistant', content });
    messages.push({ role: 'assistant', content });

    if (reply.stop_reason !== 'tool_use') {
      emit({ type: 'done', stop: reply.stop_reason });
      return;
    }

    const results = await resolveToolCalls({ role: 'assistant', content }, decisions, emit);
    if (!results) {
      emit({ type: 'paused' });
      return;
    }
    emit({ type: 'results', content: results });
    messages.push({ role: 'user', content: results });
  }

  emit({
    type: 'error',
    message: `Stopped after ${maxSteps} tool steps without finishing. Ask a narrower question.`,
  });
}
