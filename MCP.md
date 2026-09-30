# apaleo MCP servers

Five focused [Model Context Protocol](https://modelcontextprotocol.io) servers over the
apaleo clone's API — 45 tools, split so a client only carries the surface it needs.

```bash
npm run build
node dist/mcp/bin.js --domain booking      # stdio, one domain
node dist/mcp/bin.js                       # stdio, everything
node dist/mcp/bin.js --http --port 8090    # one HTTP endpoint per domain
node dist/mcp/bin.js --list                # what exists
```

## The split

Context is paid on every turn, so the surface is divided by job rather than shipped as
one server. A front desk assistant should not carry invoice cancellation in its prompt.

| Server | Tools | Schema | ~Tokens | Covers |
| --- | ---: | ---: | ---: | --- |
| `booking` | 13 | 21.3 KB | 5.8k | Quote, book, amend, assign a room, check in and out, cancel, extras |
| `finance` | 12 | 16.4 KB | 4.4k | Folios, charges, payments, refunds, allowances, invoices, sub-ledger |
| `operations` | 8 | 10.3 KB | 2.8k | Day board, housekeeping, maintenance, night audit |
| `insight` | 6 | 7.4 KB | 2.0k | Properties, availability, occupancy/ADR/RevPAR, revenue, audit trails |
| `setup` | 6 | 8.3 KB | 2.3k | Rooms, rate plans, prices, services, overbooking |
| `all` | 45 | 63.7 KB | 17.2k | Every domain on one connection |

Schema size is the exact serialized `tools/list` payload; the token column is that
divided by 3.7 chars/token, so treat it as an estimate and the KB as measured.

Mounting one domain costs roughly **3.4k tokens instead of 17.2k** — a fifth of the
budget. Names are namespaced, so mounting several together never collides.

## What makes the tools usable

**Task-shaped, not endpoint-shaped.** The API has 289 operations; this exposes 45. One
tool answers one question a hotelier actually asks. `booking_quote_stay` wraps offers,
availability and pricing; `operations_day_board` wraps four list calls into the thing a
duty manager wants at 7am.

**Every description is structured the same way**, and the shape is enforced by the type
system rather than by review:

```
Cancel a reservation, posting the cancellation fee its policy requires.

USE WHEN
· A guest cancels a confirmed booking.

DO NOT USE FOR
· A guest who never arrived - use booking_mark_no_show, which applies the no-show fee.
· Shortening a stay - use booking_amend_stay.

RETURNS: The cancellation fee charged and the resulting balance.

NOTES
· Irreversible. There is no un-cancel; the stay would have to be re-booked.
· The fee comes from the rate plan policy. Read it with booking_get_reservation first
  so the guest can be told what they will be charged.
· The room is released back to inventory.
```

`USE WHEN` and `DO NOT USE FOR` are mandatory fields on the tool spec, and the
"do not use" entries name the tool that *is* right. That is what stops a model reaching
for `finance_post_charge` when it wants `booking_manage_services`.

**Results are rendered, not dumped.** Tools return aligned tables sized for a model to
read, plus `structuredContent` for programmatic use. Empty columns are dropped, long
lists are capped with an explicit `Showing 25 of 140` so nothing looks complete when it
is not.

**Errors tell the model what to do next.** A 404 names the tool that lists valid ids; a
422 quotes the validation messages and says to correct and retry. Everything is returned
as a tool-execution error (`isError: true`), never as a protocol error, so the model can
self-correct.

```
Reservation 'NOPE-1': not found. Use booking_find_reservations to find valid ids.
```

**Check-out is the nicest case of this.** Calling it on an unsettled folio posts the
outstanding nights, then reports exactly what to collect:

```
Check-out refused: folio EFYRLDBQ-1-1 owes 143.00 EUR. Take payment with
finance_post_payment, then call booking_check_out again. The outstanding
nights have already been posted.
```

## Safety

Annotations are set per tool and mean what MCP says they mean. `readOnlyHint` is only
true where nothing changes — a client can run those without prompting.

Separately, seven operations **cannot be undone by calling another tool**, and each is
gated behind `confirm: true`:

`booking_cancel` · `booking_mark_no_show` · `finance_post_refund` ·
`finance_cancel_invoice` · `operations_run_night_audit` · `rates_set_prices` ·
`rates_set_overbooking`

Without it they refuse, and the refusal states the consequence in the terms that
matter — the fee the guest will be charged, or the date that is about to close:

```
Not performed. Cancelling SMGHVGFP-1 (Marta Kowalska, 2026-10-01 to 2026-10-03) would
charge a cancellation fee of 184.00 EUR and cannot be undone. Call again with
confirm=true once the user has agreed.
```

```
Not performed. Running the night audit closes 2026-09-30 at Demo Apartments Berlin,
and moves the property to 2026-10-01. It cannot be undone. Call again with
confirm=true once the user has agreed.
```

The gate is structural. A tool that declares `requiresConfirmation` without a `confirm`
argument — or takes one without declaring it — **throws at registration**, so the server
will not start. A test asserts the gated set matches the irreversible set exactly, so
adding an irreversible tool without a gate fails CI.

`destructiveHint` and confirmation are deliberately different: undoing a check-in is
destructive but recoverable, so it carries the hint without the gate.

## Performance

**Tools call the API in-process.** The server builds the real Express application and
dispatches through it with a synthetic `IncomingMessage`/`ServerResponse` pair — every
route, validator and business rule runs, with no socket, no loopback, and no JSON
crossing a connection.

| | |
| --- | --- |
| Raw API dispatch, sequential / parallel | **0.256 / 0.202 ms** |
| Tool call, config cached | **0.152 ms** |
| Tool call, 7 nights of availability | **3.36 ms** |
| Tool call, full day board | **5.96 ms** |

Going through the app rather than importing the domain layer is the point: an MCP tool
and an HTTP client cannot drift in what they validate or permit.

**Configuration is memoized** for 30 s (`APALEO_MCP_CACHE_TTL`) — properties, unit
groups, rate plans, services, the business date. A conversation reads each once instead
of on every call. Writing tools invalidate what they touch.

**Composite tools fan out in parallel.** `operations_day_board` issues its four queries
concurrently rather than in sequence.

**Tool listing is byte-stable** across restarts, which the spec asks for: clients can
cache it and prompt caches stay warm.

## Resources and prompts

Three resources carry orientation a model would otherwise spend tool calls discovering:

- `apaleo://properties` — ids, currency, time zone, current business date
- `apaleo://glossary` — what folio, time slice, unit group and business date mean
- `apaleo://chart-of-accounts` — the ledger tree behind the finance tools

Five prompts wrap the workflows a hotelier repeats: `morning_briefing`,
`close_the_day`, `quote_and_book`, `revenue_review`, `guest_lookup`. `close_the_day`
exists specifically to make the night audit safe — it forces preview, report, agree, run.

## The built-in assistant

The clone's own UI is also an MCP client. The **Assistant** panel, docked to the right
of the workspace, runs an agent loop over these tools through Claude, and it is the
reference for how the safety model is meant to be used.

It connects the way any other client would - a real `Client` over the in-memory
transport - so it sees exactly this tool list, these descriptions and these errors.
Nothing is special-cased for it.

The one thing it adds is a **human gate in front of the model's confidence**.
`requiresConfirmation` stops a tool acting by accident, but nothing stops a model
deciding to pass `confirm: true` on its own. So the chat server refuses to execute any
gated call until the person at the keyboard has approved that exact tool-use id:

```
This cannot be undone
The assistant wants to run booking_cancel. It will not happen unless you approve it.
  reservationId   SMGHVGFP-1
                                          [ Decline ]  [ Approve and run ]
```

A declined call goes back to the model as a tool result saying so, and the conversation
continues. Tests assert that a gated call with `confirm: true` and no human verdict
leaves the reservation untouched.

Set `ANTHROPIC_API_KEY` to enable it; see the README for the other variables.

## Client configuration

**Claude Desktop / any stdio client** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "apaleo-booking": {
      "command": "node",
      "args": ["/path/to/Apaleo_clone/dist/mcp/bin.js", "--domain", "booking,insight"],
      "env": { "APALEO_DB": "/path/to/Apaleo_clone/data/apaleo.db" }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add apaleo-booking -- node /path/to/Apaleo_clone/dist/mcp/bin.js --domain booking,insight
```

**HTTP**: `POST http://localhost:8090/mcp/<domain>`, stateless — each request gets its
own server and transport, so concurrent clients never cross-wire.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `APALEO_DB` | `data/apaleo.db` | SQLite file, or `:memory:` |
| `APALEO_TOKEN` | — | Bearer token, when the API requires auth |
| `APALEO_MCP_CACHE_TTL` | `30000` | Config cache lifetime in ms |

## Layout

```
src/mcp/
  core/
    dispatch.ts   in-process transport into the Express app
    define.ts     tool spec, description template, confirmation gate
    context.ts    property resolution, business date, memoized config
    render.ts     tables, facts, money, truncation
    errors.ts     API failures -> actionable tool errors
  domains/        booking · finance · operations · insight · setup
  server.ts       assembly, instructions, resources, prompts
  bin.ts          CLI: stdio and streamable HTTP
```

## Notes and limits

The SDK negotiates protocol **2025-11-25** (its latest); the published spec has since
moved to 2026-07-28. Nothing here depends on features added in between.

The servers are **single-tenant**: one credential per process, taken from the
environment. In HTTP mode every session shares it, so put an authenticating proxy in
front before exposing it beyond localhost.

Groups, blocks and charge routing are reachable through the HTTP API but have no tools
yet — they were left out rather than added thinly.
