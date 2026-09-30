import { h, mount, chip, emptyState } from '../dom.js';
import { session } from '../api.js';
import { state } from '../state.js';

/**
 * A chat against the MCP tools, docked to the right of the workspace.
 *
 * It is a panel rather than a page on purpose: the answer is usually about
 * whatever screen you are already on, and losing the room plan to read it
 * defeats the point. The transcript stays put while you navigate.
 *
 * The transcript is the source of truth and it lives here, in the browser:
 * every turn posts the whole history back, so the server holds no session and
 * the conversation survives anything except closing the tab.
 *
 * Tool calls are shown, not hidden. In a system that can cancel a booking,
 * "what did it just do" has to be answerable by looking.
 */

/** Wire history: exactly what goes back to the model. */
let wire = [];
/** What the user sees, derived as events arrive. */
let turns = [];
/** Gated calls waiting on a verdict, keyed by tool-use id. */
let pending = new Map();
let busy = false;
let status = null;
let abort = null;

let els = {};

/**
 * Build the panel. Called once when the shell mounts; the node is kept and
 * re-shown rather than rebuilt, so an in-flight answer survives a toggle.
 */
export function chatPanel({ onClose }) {
  const log = h('div.chat-log');
  els = {};
  els.log = log;

  const node = h('aside.chatpanel', [
    header(onClose),
    log,
    h('div.chat-composer-slot'),
  ]);

  // Status decides whether the composer is usable, so the panel paints an
  // empty shell first and fills it in rather than blocking the shell render.
  fetchStatus().then((s) => {
    status = s;
    mount(node.querySelector('.chat-composer-slot'), buildComposer());
    mount(node.querySelector('.chat-head'), ...headerChildren(onClose));
    paint();
  });

  paint();
  return node;
}

async function fetchStatus() {
  try {
    const res = await fetch('/chat/v1/status', { headers: authHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return { enabled: false, tools: 0, model: '—', unreachable: true };
  }
}

function authHeaders() {
  const token = session.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ------------------------------------------------------------------ head */

function header(onClose) {
  return h('div.chat-head', headerChildren(onClose));
}

function headerChildren(onClose) {
  const bits = [];
  if (status?.unreachable) {
    bits.push(chip('server unreachable', 'bad'));
  } else if (!status?.enabled) {
    bits.push(chip('no model key', 'warn'));
  } else {
    bits.push(chip(`${status.tools} tools`, 'ok'));
    bits.push(chip(status.model, ''));
    if (status.thinking) bits.push(chip('thinking', 'info'));
  }

  return [
    h('div.chat-headline', [
      h('div.chat-title', 'Assistant'),
      h('div.chat-badges', bits),
    ]),
    h('div.chat-headtools', [
      h('button.iconbtn', {
        onclick: () => { wire = []; turns = []; pending = new Map(); paint(); },
        title: 'New chat',
      }, '⟳'),
      h('button.iconbtn', { onclick: onClose, title: 'Close (Esc)' }, '✕'),
    ]),
  ];
}

/* -------------------------------------------------------------- composer */

const SUGGESTIONS = [
  'How does the house look today?',
  'Quote 2 nights for 2 adults next Friday',
  'Which rooms are dirty right now?',
  'Show me revenue for this month',
];

function buildComposer() {
  const box = h('textarea.chat-input', {
    rows: 1,
    placeholder: status?.enabled ? 'Ask about the property…' : 'Set ANTHROPIC_API_KEY to enable the chat',
    disabled: !status?.enabled,
    oninput: (e) => autoGrow(e.target),
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
  });

  const send = h('button.btn.primary.chat-send', {
    disabled: !status?.enabled,
    onclick: () => (busy ? stop() : submit()),
  }, 'Send');

  els.box = box;
  els.send = send;

  // Suggestions are scaffolding for an empty panel; once there is a
  // conversation they are just clutter competing with it for a narrow column.
  const suggest = h('div.chat-suggest', SUGGESTIONS.map((s) =>
    h('button.chat-chip', {
      onclick: () => { box.value = s; autoGrow(box); submit(); },
      disabled: !status?.enabled,
    }, s)));
  els.suggest = suggest;
  suggest.hidden = turns.length > 0;

  return h('div.chat-composer', [
    suggest,
    h('div.chat-entry', [box, send]),
    h('div.chat-foot', status?.enabled
      ? 'The assistant reads live data. It will ask before anything irreversible.'
      : 'Start the server with ANTHROPIC_API_KEY set, then reload.'),
  ]);
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

/* ----------------------------------------------------------------- paint */

function paint() {
  if (els.suggest) els.suggest.hidden = turns.length > 0;
  if (!els.log) return;
  if (!turns.length) {
    mount(els.log, emptyState(
      'Ask about the property',
      status?.enabled
        ? 'The assistant can read availability, quote a stay, take a booking, post a charge or run the night audit — using the same MCP tools any client would.'
        : 'No ANTHROPIC_API_KEY is configured, so the model cannot be reached. The tools themselves are loaded and ready.',
      '◇',
    ));
    return;
  }
  mount(els.log, ...turns.map(renderTurn));
  els.log.scrollTop = els.log.scrollHeight;
}

function renderTurn(turn) {
  if (turn.role === 'user') {
    return h('div.msg.user', [h('div.bubble', turn.text)]);
  }

  const parts = [];
  if (turn.thinking) parts.push(thinkingBlock(turn));
  for (const item of turn.items) {
    if (item.kind === 'text' && item.text.trim()) parts.push(h('div.prose', renderText(item.text)));
    if (item.kind === 'tool') parts.push(toolBlock(item));
    if (item.kind === 'approval') parts.push(approvalBlock(item));
  }
  if (turn.error) parts.push(h('div.chat-error', turn.error));
  if (turn.streaming && !parts.length) parts.push(h('div.chat-wait', [h('span.dot'), h('span.dot'), h('span.dot')]));

  return h('div.msg.bot', [h('div.bot-body', parts)]);
}

/** Minimal formatting: paragraphs, bullets and `code`. Never raw HTML. */
function renderText(text) {
  const nodes = [];
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split('\n');
    const bullets = lines.filter((l) => /^\s*[-*·]\s+/.test(l));
    if (bullets.length === lines.length && bullets.length) {
      nodes.push(h('ul', lines.map((l) => h('li', inline(l.replace(/^\s*[-*·]\s+/, ''))))));
    } else {
      nodes.push(h('p', inline(para)));
    }
  }
  return nodes;
}

function inline(text) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? h('code', m[1]) : h('strong', m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function thinkingBlock(turn) {
  return h('details.chat-think', [
    h('summary', turn.streaming ? 'Thinking…' : 'Thought process'),
    h('pre', turn.thinking),
  ]);
}

function toolBlock(item) {
  const args = Object.entries(item.input ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');

  const head = h('summary.tool-head', [
    h('span.tool-dot', { class: item.state }),
    h('code.tool-name', item.name),
    args ? h('span.tool-args', args) : null,
    h('span.tool-tag', item.state === 'running' ? 'running'
      : item.state === 'error' ? 'error'
      : item.readOnly ? 'read' : 'write'),
  ]);

  return h('details.tool', { class: item.state }, [
    head,
    item.output ? h('pre.tool-out', item.output) : h('div.tool-out.muted', 'waiting…'),
  ]);
}

function approvalBlock(item) {
  if (item.decided) {
    return h('div.approval.decided', [
      h('span.tool-dot', { class: item.decided === 'approve' ? 'ok' : 'error' }),
      h('span', `${item.decided === 'approve' ? 'Approved' : 'Declined'} · `),
      h('code', item.name),
    ]);
  }

  const detail = Object.entries(item.input ?? {})
    .filter(([k]) => k !== 'confirm')
    .map(([k, v]) => h('div.kv', [h('span.k', k), h('span.v', String(v))]));

  return h('div.approval', [
    h('div.approval-head', [
      h('span.approval-mark', '!'),
      h('div', [
        h('div.approval-title', 'This cannot be undone'),
        h('div.approval-sub', ['The assistant wants to run ', h('code', item.name), '. It will not happen unless you approve it.']),
      ]),
    ]),
    detail.length ? h('div.approval-args', detail) : null,
    h('div.approval-actions', [
      h('button.btn.ghost', { onclick: () => decide(item, 'deny') }, 'Decline'),
      h('button.btn.danger', { onclick: () => decide(item, 'approve') }, 'Approve and run'),
    ]),
  ]);
}

/* ------------------------------------------------------------------ flow */

function submit() {
  const text = els.box?.value.trim();
  if (!text || busy || !status?.enabled) return;
  els.box.value = '';
  autoGrow(els.box);

  wire.push({ role: 'user', content: text });
  turns.push({ role: 'user', text });
  paint();
  run({});
}

function decide(item, verdict) {
  item.decided = verdict;
  pending.delete(item.id);
  paint();
  // Send once every pending call on this turn has a verdict.
  if (pending.size === 0) {
    const decisions = {};
    for (const turn of turns) {
      if (turn.role !== 'bot') continue;
      for (const part of turn.items) {
        if (part.kind === 'approval' && part.decided) decisions[part.id] = part.decided;
      }
    }
    run({ decisions });
  }
}

function stop() {
  abort?.abort();
  busy = false;
  setBusy(false);
}

function setBusy(on) {
  busy = on;
  if (els.send) els.send.textContent = on ? 'Stop' : 'Send';
  if (els.box) els.box.disabled = on;
}

async function run({ decisions }) {
  setBusy(true);
  abort = new AbortController();

  // One bot turn accumulates everything until the stream ends or pauses.
  const turn = { role: 'bot', items: [], thinking: '', streaming: true, error: null };
  turns.push(turn);
  paint();

  let current = null; // the open text item

  try {
    const res = await fetch('/chat/v1/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        messages: wire,
        decisions: decisions ?? {},
        propertyId: state.property?.id,
      }),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      turn.error = `The server replied ${res.status}.`;
      return;
    }

    for await (const event of sse(res.body)) {
      switch (event.type) {
        case 'text_delta':
          if (!current) { current = { kind: 'text', text: '' }; turn.items.push(current); }
          current.text += event.text;
          break;

        case 'thinking_delta':
          turn.thinking += event.text;
          break;

        case 'assistant':
          // Verbatim, signatures included - this is what the model replays.
          wire.push({ role: 'assistant', content: event.content });
          current = null;
          break;

        case 'tool_call':
          turn.items.push({
            kind: 'tool', id: event.id, name: event.name,
            input: event.input, readOnly: event.readOnly,
            state: 'running', output: '',
          });
          break;

        case 'tool_result': {
          const item = turn.items.find((i) => i.kind === 'tool' && i.id === event.id);
          if (item) { item.state = event.ok ? 'ok' : 'error'; item.output = event.text; }
          break;
        }

        case 'approval_required': {
          const item = { kind: 'approval', id: event.id, name: event.name, input: event.input, decided: null };
          turn.items.push(item);
          pending.set(event.id, item);
          break;
        }

        case 'results':
          wire.push({ role: 'user', content: event.content });
          break;

        case 'error':
          turn.error = event.message;
          break;

        default:
          break;
      }
      paint();
    }
  } catch (err) {
    if (err.name !== 'AbortError') turn.error = err.message || 'The connection failed.';
  } finally {
    turn.streaming = false;
    setBusy(false);
    paint();
    els.box?.focus();
  }
}

/** Parse an SSE body into events. */
async function* sse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(5).trim());
      } catch {
        // A partial frame is not worth breaking the stream over.
      }
    }
  }
}
