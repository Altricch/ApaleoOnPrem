import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listProperties, businessDate, resolveProperty, call, callList } from './core/context';
import { registerBooking } from './domains/booking';
import { registerFinance } from './domains/finance';
import { registerOperations } from './domains/operations';
import { registerInsight } from './domains/insight';
import { registerSetup } from './domains/setup';

/**
 * Server assembly.
 *
 * The surface is split by domain rather than shipped as one server, because
 * the cost of an MCP server is paid in context on every single turn: a client
 * that only needs the front desk should not carry rate loading and invoice
 * cancellation in its prompt. Each domain below is an independently mountable
 * server; `all` exists for setups where one connection is simpler than five.
 */

export const DOMAINS = {
  booking: {
    title: 'apaleo Booking',
    blurb:
      'Sell and operate reservations: quote a stay, take the booking, assign a room, '
      + 'check in and out, amend, cancel, and manage extras.',
    register: registerBooking,
  },
  finance: {
    title: 'apaleo Finance',
    blurb:
      'Guest accounts and documents: folios, charges, payments, refunds, allowances, '
      + 'invoices, and the double-entry sub-ledger behind them.',
    register: registerFinance,
  },
  operations: {
    title: 'apaleo Operations',
    blurb:
      'Run the day: the front desk board, housekeeping conditions, maintenance windows, '
      + 'and the night audit that closes the business date.',
    register: registerOperations,
  },
  insight: {
    title: 'apaleo Insight',
    blurb:
      'Read-only analytics: properties and their configuration, availability by night, '
      + 'occupancy, ADR and RevPAR, revenue by account, and audit trails.',
    register: registerInsight,
  },
  setup: {
    title: 'apaleo Setup',
    blurb:
      'Commercial configuration: rooms, rate plans, nightly prices, services and '
      + 'overbooking allowances.',
    register: registerSetup,
  },
} as const;

export type DomainName = keyof typeof DOMAINS;
export const DOMAIN_NAMES = Object.keys(DOMAINS) as DomainName[];

const VERSION = '1.0.0';

export interface BuildOptions {
  /** Which domains to mount. Defaults to all of them. */
  domains?: readonly DomainName[];
  /** Server name reported to the client. */
  name?: string;
}

export function buildServer(options: BuildOptions = {}): McpServer {
  const domains = options.domains?.length ? options.domains : DOMAIN_NAMES;
  const single = domains.length === 1 ? DOMAINS[domains[0]!] : null;

  const server = new McpServer(
    {
      name: options.name ?? (single ? `apaleo-${domains[0]}` : 'apaleo'),
      title: single ? single.title : 'apaleo PMS',
      version: VERSION,
    },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: instructionsFor(domains),
    },
  );

  // Registration order is fixed so `tools/list` is byte-stable across
  // restarts, which lets clients cache it and keeps prompt caches warm.
  for (const name of DOMAIN_NAMES) {
    if (domains.includes(name)) DOMAINS[name].register(server);
  }

  registerResources(server);
  registerPrompts(server);
  return server;
}

/**
 * Server instructions: the handful of facts that stop a model making the
 * same three mistakes on every task. Kept short - this text is in context
 * for the whole session.
 */
function instructionsFor(domains: readonly DomainName[]): string {
  const lines = [
    'apaleo is a property management system for hotels and serviced apartments.',
    '',
    'Working rules:',
    '- Every id is scoped to a property. Call insight_list_properties once to learn them;'
    + ' propertyId may be omitted only when the account has a single property.',
    '- Dates are YYYY-MM-DD. `departure` is the morning the guest leaves, so 3rd to 5th is'
    + ' two nights.',
    '- The business date is the day the property is operating on, which the night audit'
    + ' advances. It is not always today. Tools default to it, not to the wall clock.',
    '- Money is always gross, in the property currency, with VAT derived rather than added.',
  ];
  if (domains.includes('booking')) {
    lines.push(
      '- Quote before booking: booking_quote_stay returns the ratePlanId that booking_create'
      + ' needs, and explains why a rate cannot be sold.',
      '- A reservation needs a room assigned for the whole stay before it can be checked in.',
    );
  }
  if (domains.includes('finance')) {
    lines.push(
      '- Charges are never deleted. A mistake is corrected with an allowance so the audit'
      + ' trail survives.',
    );
  }
  lines.push(
    '',
    'Tools that change money, inventory or guest state ask for confirm=true. Get the'
    + " user's agreement first; do not set it to clear an error.",
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------ resources */

/**
 * Resources carry the orientation a model would otherwise have to spend tool
 * calls discovering. They are cheap to read and stable within a session.
 */
function registerResources(server: McpServer): void {
  server.registerResource(
    'properties',
    'apaleo://properties',
    {
      title: 'Properties',
      description:
        'The properties in this account with their ids, currency, time zone and current '
        + 'business date. Read this first to learn the ids every tool needs.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const properties = await listProperties();
      const dates = await Promise.all(properties.map((p) => businessDate(p)));
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            properties.map((p, i) => ({ ...p, businessDate: dates[i] })),
            null,
            2,
          ),
        }],
      };
    },
  );

  server.registerResource(
    'glossary',
    'apaleo://glossary',
    {
      title: 'Domain glossary',
      description:
        'What apaleo means by folio, time slice, unit group, business date, allowance and '
        + 'the rest. Read when a term in a tool result is unfamiliar.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GLOSSARY }],
    }),
  );

  server.registerResource(
    'chart-of-accounts',
    'apaleo://chart-of-accounts',
    {
      title: 'Chart of accounts',
      description:
        'The ledger accounts a property posts to, as a tree. Useful when reading '
        + 'finance_ledger or insight_revenue output.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const property = await resolveProperty(undefined).catch(() => null);
      if (!property) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: '{}' }] };
      }
      const schema = await call<any>({
        method: 'GET',
        path: '/finance/v1/accounts/schema',
        query: { propertyId: property.id, depth: 3 },
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ propertyId: property.id, ...schema }, null, 2),
        }],
      };
    },
  );
}

const GLOSSARY = `# apaleo glossary

**Property** — one hotel or apartment building. Almost every id is prefixed with its
property code, e.g. \`MUC-DBL\`.

**Unit / unit group** — a unit is a physical room; a unit group is a room *type*
(Double, Suite). Availability and rates are managed per unit group; housekeeping and
assignment happen per unit.

**Business date** — the day the property is operating on. The night audit closes it and
moves to the next. It is not necessarily today, and tools default to it.

**Time slice** — one night of a stay. A reservation is a list of time slices, each with
its own rate plan and price, which is how a stay can move between rates mid-way.

**Rate plan** — what is sold: a room type at a price, under a cancellation and no-show
policy, through given channels. A *derived* plan has no prices of its own and tracks a
base plan by a percentage or fixed amount.

**Offer** — a priced, availability-checked answer to "can I sell this stay". Offers carry
validation messages explaining why they cannot be booked.

**Folio** — a guest account. Charges, payments, allowances and refunds post to it; its
balance is what is owed. A reservation gets one main folio; extra folios split a bill.

**Charge** — money owed, posted gross with a VAT band. Charges are never deleted.

**Allowance** — a credit that reduces a charge without erasing it, so the audit trail
survives. Use it to discount or correct.

**Refund** — money given back that was previously taken. Distinct from an allowance.

**Sub-ledger** — the double-entry journal beneath the folios. Every posting writes
balanced entries; the totals must net to zero.

**Night audit** — the end-of-day run: posts the closing day for everyone in house, turns
unclaimed arrivals into no-shows, and advances the business date. Not reversible.

**Out of order vs out of inventory** — both stop a room being sold. Out of order leaves it
in the house count, so occupancy still treats it as a room; out of inventory removes it,
which is what long building work needs.
`;

/* -------------------------------------------------------------- prompts */

/**
 * Prompts are the workflows a hotelier repeats daily. They exist so the user
 * can pick "morning briefing" instead of describing it, and so the model gets
 * the right tool order without guessing.
 */
function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'morning_briefing',
    {
      title: 'Morning briefing',
      description:
        'Summarise the day for the front desk: occupancy, arrivals and departures, what '
        + 'needs a room, and any open balances.',
      argsSchema: { propertyId: z.string().optional().describe('Property to brief on.') },
    },
    ({ propertyId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Give me the morning briefing${propertyId ? ` for ${propertyId}` : ''}.`,
            '',
            'Call operations_day_board first. Then:',
            '- Lead with occupancy and how many rooms are left to sell tonight.',
            '- List arrivals that still need a room, and offer to assign them.',
            '- List departures that still owe money, with the amount.',
            '- Flag anything in house past its departure date.',
            'Keep it to what a duty manager needs in thirty seconds.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'close_the_day',
    {
      title: 'Close the day',
      description:
        'Walk the night audit safely: check what is outstanding, preview the audit, and '
        + 'only then run it.',
      argsSchema: { propertyId: z.string().optional().describe('Property to close.') },
    },
    ({ propertyId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Close the business date${propertyId ? ` for ${propertyId}` : ''}.`,
            '',
            'Work in this order and stop if anything looks wrong:',
            '1. operations_day_board — is anything still to check in or out?',
            '2. operations_preview_night_audit — which arrivals would become no-shows, and',
            '   what fees would that charge?',
            '3. Report both to me and wait for my go-ahead.',
            '4. Only then operations_run_night_audit with confirm=true.',
            '',
            'The audit cannot be undone, so do not run it without my explicit agreement.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'quote_and_book',
    {
      title: 'Quote and book a stay',
      description: 'Shop rates for a stay, present the options, and book the one chosen.',
      argsSchema: {
        arrival: z.string().describe('Arrival date, YYYY-MM-DD.'),
        departure: z.string().describe('Departure date, YYYY-MM-DD.'),
        guests: z.string().optional().describe('e.g. "2 adults and a child aged 6".'),
        propertyId: z.string().optional(),
      },
    },
    ({ arrival, departure, guests, propertyId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Find me rates for ${arrival} to ${departure}${guests ? ` for ${guests}` : ''}`
            + `${propertyId ? ` at ${propertyId}` : ''}.`,
            '',
            'Use booking_quote_stay. Present the bookable options with total, price per night',
            'and the cancellation terms, cheapest first. Say plainly if a rate cannot be sold',
            'and why. Do not book anything until I choose; when I do, use booking_create and',
            'then assign a room.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'revenue_review',
    {
      title: 'Revenue review',
      description: 'Review performance for a period and check the books balance.',
      argsSchema: {
        from: z.string().optional().describe('Period start, YYYY-MM-DD.'),
        to: z.string().optional().describe('Period end, YYYY-MM-DD.'),
        propertyId: z.string().optional(),
      },
    },
    ({ from, to, propertyId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Review revenue${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`
            + `${propertyId ? ` for ${propertyId}` : ''}.`,
            '',
            'Use insight_performance for occupancy, ADR and RevPAR, insight_revenue for the',
            'account breakdown, and finance_ledger to confirm debits equal credits.',
            'Call out the best and worst days and anything that looks anomalous.',
            'If the ledger does not balance, say so prominently — that is a defect, not noise.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'guest_lookup',
    {
      title: 'Look up a guest',
      description: 'Find a guest and summarise their stay, bill and what can be done next.',
      argsSchema: { query: z.string().describe('Guest name, reservation id or external code.') },
    },
    ({ query }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Find "${query}" and tell me where things stand.`,
            '',
            'Search with booking_find_reservations, then read the match with',
            'booking_get_reservation. Summarise the stay, the room, the balance, and which',
            'actions are available right now. If several match, list them and ask which.',
          ].join('\n'),
        },
      }],
    }),
  );
}

export { callList };
