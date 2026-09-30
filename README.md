# apaleo clone

A local, self-hosted implementation of the [apaleo](https://apaleo.dev) core API — the
cloud property management system for hotels and serviced apartments — **and a front
end to drive it**.

Every operation documented in apaleo's ten stable `v1` specifications is implemented
against a real local database, with the business logic behind it: availability,
pricing, the reservation state machine, folios, a double-entry sub-ledger, invoicing
and the night audit.

```
289 / 289 documented v1 operations
```

| API | Operations | What it covers |
| --- | ---: | --- |
| Inventory | 35 | Properties, unit groups, units, unit attributes |
| Rate Plan | 45 | Rate plans, rates, policies, services, companies, age categories |
| Booking | 77 | Offers, bookings, reservations, blocks, groups, payment artefacts |
| Finance | 65 | Folios, charges, payments, refunds, invoices, routing, sub-ledger |
| Settings | 35 | City taxes, market segments, sub-accounts, time slices, features |
| Availability | 7 | Unit-group, unit and service availability; overbooking limits |
| Operations | 10 | Maintenance, housekeeping, night audit |
| Reports | 5 | Occupancy, ADR, RevPAR, revenue, arrivals, company VAT |
| Logs | 4 | Reservation, folio, night-audit and export audit trails |
| Account | 6 | The tenant this installation represents |

## Quick start

```bash
npm install
npm run seed     # two demo properties with a year of rates and 28 reservations
npm start        # http://localhost:8088
```

Open **http://localhost:8088/** and sign in. The credentials are prefilled:

| | |
| --- | --- |
| Client ID | `apaleo-clone` |
| Client secret | `secret` |

Anonymous access is on by default, so *Continue without signing in* also works. Set
`APALEO_ALLOW_ANONYMOUS=false` to require the login and enforce per-operation scopes.

## The application

`/` serves a property management front end built on the same public API — no private
endpoints, no shortcuts. Every screen is something a hotel actually uses:

| Screen | What it does |
| --- | --- |
| **Dashboard** | Occupancy, arrivals and departures for the business date, who is in house, and the night audit with a preview of what it will change |
| **Room plan** | Rooms down the side, nights across the top, stays as bars. Unassigned reservations get their own row per unit group; out-of-order rooms are hatched; the group row shows how many rooms are still free each night |
| **Reservations** | Every documented filter — date basis, status, free text, sorting, paging — plus a detail drawer with the stay, the guest, the nightly breakdown, services, the folio and the full history |
| **Housekeeping** | A room board you can multi-select to change conditions in bulk, with arrows for who is leaving and arriving, and maintenance scheduling |
| **Availability** | Unit group × night grid switchable between available, sellable, sold and occupancy, with overbooking allowances |
| **Rates** | Rate plan × night grid with prices editable in place and a bulk update by weekday. Derived plans are read-only, because their prices come from a base plan |
| **Folios** | Open balances, posting charges and payments, and turning a settled folio into an invoice |
| **Invoices** | Issued documents with their VAT breakdown, the PDF, and cancellation |
| **Reports** | Occupancy, ADR and RevPAR, the revenue tree from the chart of accounts, per-unit-group and day-by-day figures, and proof the sub-ledger balances |
| **Property** | How the active property is configured |

Booking runs end to end: pick dates and occupancy, shop the offers the pricing
engine returns (unbookable ones show *why*), capture the guest, add extras, book.

Two details worth calling out, because they are where a PMS front end usually lies
to you:

- **Actions come from the server.** Each reservation reports which transitions are
  allowed and why not. The drawer renders buttons only for what is permitted and
  states the blocking reason in plain language, so the UI can never offer something
  the API would refuse.
- **Nothing is faked client-side.** Availability counts, prices, taxes, fees and
  balances are all read back from the API rather than recomputed in the browser.

The front end is plain ES modules with no build step and no CDN — it works offline.

### The two demo properties

`npm run seed` loads:

| | MUC | BER |
| --- | --- | --- |
| Name | Demo Hotel Munich | Demo Apartments Berlin |
| Rooms | 17 across Single, Double and Suite | 7 across Studio and Apartment |
| Rate plans | Flexible plus a non-refundable plan derived 10% below it | same |
| Extras | Breakfast, parking, late check-out, Wi-Fi | same |
| Tax | 5% city tax, children exempt, not charged on Booking.com | same |

Both carry a year of rates with weekend and high-season uplift, and 14 reservations
each spread across past, in-house and future, so every screen has something to show.

### API explorer

**http://localhost:8088/docs/** is a separate surface: every documented operation
with its contract, and a *try it* panel that runs the call against this server. Or
drive it from the shell:

```bash
curl -s "http://localhost:8088/booking/v1/offers?propertyId=MUC\
&arrival=2026-06-01&departure=2026-06-03&adults=2&channelCode=Direct" | jq
```

`npm run demo` narrates a whole stay in the terminal — shopping for a rate, booking,
check-in, posting extras, the night audit, check-out, the invoice, and the ledger
entries that result — and finishes by showing that debits equal credits.

### MCP servers

The same API is exposed to LLM clients as **five focused MCP servers** — 45 task-shaped
tools split by job, so a client carries only the surface it needs:

| Server | Tools | Covers |
| --- | ---: | --- |
| `booking` | 13 | Quote, book, amend, assign a room, check in and out, cancel, extras |
| `finance` | 12 | Folios, charges, payments, refunds, allowances, invoices, sub-ledger |
| `operations` | 8 | Day board, housekeeping, maintenance, night audit |
| `insight` | 6 | Properties, availability, occupancy/ADR/RevPAR, revenue, audit trails |
| `setup` | 6 | Rooms, rate plans, prices, services, overbooking |

```bash
npm run mcp -- --domain booking    # stdio, one domain
npm run mcp:http                   # one HTTP endpoint per domain
npm run mcp:list                   # what exists
```

Tools call the API in-process through the real Express app — every route, validator and
business rule runs, with no socket (0.15 ms for a cached call). Seven irreversible
operations are gated behind `confirm: true`, enforced at registration.

**See [MCP.md](MCP.md)** for the tool descriptions, the safety model, client
configuration and the measurements.

### Assistant

The UI has a chat screen (**Assist → Assistant**) that drives those same MCP tools
through Claude. It needs a key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start          # then open /app/#/chat
```

Without one the screen still loads and reports what is missing — the tools are live,
only the model is absent.

Three things are worth knowing about how it works:

- **The transcript lives in the browser.** Every turn posts the whole history back, so
  the server keeps no session state and nothing is stored about the conversation.
- **Tool calls are shown, not hidden.** Each call is a row you can expand to see the
  exact arguments and the raw tool output. In a console that can cancel a booking,
  "what did it just do" has to be answerable by looking.
- **The human owns the confirmation gate.** The seven irreversible tools take
  `confirm: true`, and nothing stops a model passing it — so the server refuses to
  execute any gated call until you approve that specific call in the UI. The model can
  ask; only you can answer.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Required. Without it the chat is disabled. |
| `APALEO_CHAT_MODEL` | `claude-opus-5` | Model to drive the tools |
| `APALEO_CHAT_THINKING` | `1` | Adaptive thinking; `0` for lowest latency |
| `APALEO_CHAT_MAX_STEPS` | `12` | Tool steps before the turn gives up |

## How it works

### Routes come from the specification

Handlers are bound by `operationId`, not by verb and path:

```ts
api.op('InventoryPropertiesPost', (req, res) => { ... });
```

The path template, HTTP method, required scopes and request-body schema are all read
from the downloaded apaleo spec. Binding an id that does not exist fails at boot, and
`GET /coverage` reports any documented operation nobody implemented. Request bodies
are validated against the real Swagger definitions, so a malformed call gets the same
`422` with the same `{ "messages": [...] }` shape as upstream.

The specifications in [`specs/`](specs/) are apaleo's own documents, downloaded
verbatim. `npm run specs:refresh` re-fetches them.

### The domain, not just the shape

The point of the clone is that the numbers come out right.

- **Availability** builds a per-night snapshot of physical inventory, maintenance,
  sold rooms, block allotments and overbooking, then derives the same stack of counts
  apaleo reports. `OutOfInventory` maintenance leaves the house count; `OutOfService`
  and `OutOfOrder` do not — which is what makes occupancy percentages behave.
- **Pricing** resolves a nightly rate (walking the derivation chain for derived rate
  plans), applies occupancy and age-category surcharges under the plan's
  `Truncate`/`Round` mode, carves out services included in the rate, adds the extras,
  then computes city tax and the cancellation and no-show fees.
- **Reservations** run a real state machine. Each transition is guarded by the
  documented reason codes, so `expand=actions` tells you exactly why check-in is
  refused before you try it.
- **Folios** post to a double-entry sub-ledger. Every charge, payment, allowance,
  refund and transfer writes balanced journal entries, which is why the Finance API's
  export and aggregate endpoints reconcile against folio balances.
- **Invoices** snapshot the folio rather than referencing it, and cancelling one
  issues a cancellation document instead of deleting the original.
- **The night audit** posts the closing day for everyone in house, turns unclaimed
  arrivals into no-shows, warns about rooms that should have been vacated, and rolls
  the business date. It is idempotent per date.

### Storage

SQLite, with each entity stored as JSON alongside generated columns lifted out of it
so the filters the API exposes are index-backed. The apaleo models are deeply nested
and always read and written as whole aggregates, so a document shape fits better than
a fully normalised one.

The database lives at `data/apaleo.db`. Set `APALEO_DB=:memory:` for a throwaway run.

## Authentication

A stand-in for `identity.apaleo.com` runs on the same routes, so SDKs and Postman
collections configured against apaleo authenticate unchanged:

```bash
curl -s -X POST http://localhost:8088/connect/token \
  -d grant_type=client_credentials \
  -d client_id=apaleo-clone \
  -d client_secret=secret
```

Anonymous access is **on** by default so the API is usable immediately. Set
`APALEO_ALLOW_ANONYMOUS=false` to require a bearer token and enforce the scopes each
operation documents.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8088` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `APALEO_DB` | `data/apaleo.db` | SQLite file, or `:memory:` |
| `APALEO_ALLOW_ANONYMOUS` | `true` | Skip auth and treat every caller as admin |
| `APALEO_VALIDATE` | `true` | Validate request bodies against the specs |
| `APALEO_CLIENT_ID` | `apaleo-clone` | Default OAuth client |
| `APALEO_CLIENT_SECRET` | `secret` | Default OAuth client secret |
| `APALEO_JWT_SECRET` | dev value | Token signing key |
| `APALEO_MAX_PAGE_SIZE` | `500` | Page-size cap, as upstream |

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Build output server |
| `npm run dev` | Watch mode |
| `npm run seed` | Rebuild and load the demo data |
| `npm run demo` | Narrated walkthrough of a full stay |
| `npm test` | 105 tests over the domain, the HTTP surface, the MCP servers and the chat gate |
| `npm run typecheck` | Types only |
| `npm run specs:refresh` | Re-download apaleo's OpenAPI documents |
| `npm run mcp` | MCP server over stdio (`-- --domain booking`) |
| `npm run mcp:http` | MCP over streamable HTTP, one endpoint per domain |
| `npm run mcp:list` | Print the domains and their tools |

## Layout

```
specs/          apaleo's OpenAPI documents, unmodified
src/core/       storage, auth, JSON Patch, money, dates, spec loading, routing
src/domain/     availability, pricing, reservations, folios, accounts,
                invoicing, routing, posting, night audit
src/api/        one module per apaleo API, bound by operationId
src/web/app/    the PMS front end (ES modules, no build step, no CDN)
src/web/docs/   the API explorer
src/mcp/        five MCP servers over the API (see MCP.md)
src/chat/       the assistant: an agent loop over the MCP tools, with the
                human-approval gate for irreversible actions
src/cli/        seed, demo, spec refresh
src/test/       node:test suites
```

## Endpoints outside the apaleo surface

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness and implementation counts |
| `GET /coverage` | Per-spec implementation status and any gaps |
| `GET /app/` | Property management front end |
| `GET /docs/` | API explorer |
| `GET /swagger/index.json` | Spec list, pointed at this host |
| `GET /swagger/{spec}/swagger.json` | One document, host rewritten |
| `GET /connect/dev-token` | A ready-to-use admin token |

## Scope and limitations

This implements the ten stable `v1` APIs. The preview (`-nsfw`) specifications are
downloaded and served for reference but are not implemented.

Payment handling is modelled, not real: there is no PSP. Terminal and payment-link
payments start `Pending` and payment links resolve to local URLs, which is enough to
exercise the flows. Card numbers are masked to the last four digits on the way in.

The front end covers the operational core. It does not yet expose group and block
management, routing rules, or property configuration editing — those are reachable
through the API and the explorer.

This is an independent reimplementation for local development and testing, built from
apaleo's public API documentation. The UI is inspired by the shape of a property
management system, not copied from apaleo's own. It is not affiliated with apaleo GmbH.
