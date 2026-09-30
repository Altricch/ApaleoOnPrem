import { mount,
  h, drawer, modal, closeOverlay, field, input, select, chip, toast,
  confirmDialog, skeleton, emptyState,
} from '../dom.js';
import { api } from '../api.js';
import { state, cached } from '../state.js';
import {
  money, date, dateTime, guestName, nights, label, tone, number,
} from '../format.js';

/**
 * The reservation drawer. Opened from every list and from the room plan, it
 * shows the stay, its folio and its history, and exposes exactly the actions
 * the API currently permits - the `actions` collection drives the buttons, so
 * the UI never offers something the server would refuse.
 */
export async function openReservation(id, context) {
  const panel = drawer({ title: 'Reservation', subtitle: id, body: [skeleton(120), skeleton(200)] });
  await paint(panel, id, context);
}

async function paint(panel, id, context) {
  const body = panel.querySelector('.body');
  const refresh = () => paint(panel, id, context);

  let reservation;
  let folios;
  let logs;
  try {
    reservation = await api.reservation(id);
    [folios, logs] = await Promise.all([
      api.folios({ reservationIds: id }),
      api.reservationLogs(id).catch(() => ({ items: [] })),
    ]);
  } catch (err) {
    mount(body, h('div.warnings', err.messages?.join(' ') ?? String(err)));
    return;
  }

  paintHeader(panel, reservation);

  mount(body, 
    stayCard(reservation),
    guestCard(reservation),
    nightsCard(reservation),
    servicesCard(reservation, context, refresh),
    ...folios.items.map((folio) => folioCard(folio, reservation, context, refresh)),
    historyCard(logs.items),
  );

  // An explanation of why the obvious next step is unavailable belongs where
  // it is read - at the top, not below a screenful of detail.
  const note = blockedNote(reservation);
  if (note) body.prepend(note);

  const footer = panel.querySelector('footer') ?? h('footer');
  if (!panel.contains(footer)) panel.append(footer);
  mount(footer, ...actionButtons(reservation, context, refresh));
}

/**
 * Rewrite the drawer header. It is rebuilt rather than patched because
 * `paint` runs again after every action, and appending to it would stack a
 * fresh status chip on each pass.
 */
function paintHeader(panel, reservation) {
  const heading = panel.querySelector('header h2');
  mount(heading,
    guestName(reservation.primaryGuest),
    h('span.chip', { class: tone(reservation.status), style: { marginLeft: '8px' } }, label(reservation.status)));

  const subtitle = heading.parentElement.querySelector('.subtitle');
  const text = [reservation.id, reservation.unitGroup?.name].filter(Boolean).join(' · ');
  if (subtitle) subtitle.textContent = text;
  else heading.after(h('div.subtitle', { style: { fontSize: '12px', color: 'var(--muted)' } }, text));
}

/* ---------------------------------------------------------------- cards */

function stayCard(r) {
  return h('section.card', [
    h('div.body', [
      h('dl.kv', [
        h('dt', 'Stay'),
        h('dd', [
          h('strong', date(r.arrival)), ' → ', h('strong', date(r.departure)),
          h('span', { style: { color: 'var(--muted)' } }, ` · ${nights(r.arrival, r.departure)}`),
        ]),
        h('dt', 'Occupancy'),
        h('dd', `${r.adults} adult${r.adults === 1 ? '' : 's'}${r.childrenAges?.length ? `, ${r.childrenAges.length} child (ages ${r.childrenAges.join(', ')})` : ''}`),
        h('dt', 'Room'),
        h('dd', r.unit ? h('span.mono', `${r.unit.name} · ${r.unit.id}`) : chip('not assigned', 'warn')),
        h('dt', 'Rate plan'),
        h('dd', [r.ratePlan?.name ?? '—', h('span.mono', { style: { color: 'var(--muted)' } }, ` ${r.ratePlan?.id ?? ''}`)]),
        h('dt', 'Channel'),
        h('dd', [r.channelCode, r.source ? h('span', { style: { color: 'var(--muted)' } }, ` · ${r.source}`) : null]),
        r.marketSegment ? h('dt', 'Market segment') : null,
        r.marketSegment ? h('dd', r.marketSegment.name ?? r.marketSegment.id) : null,
        h('dt', 'Total'),
        h('dd', h('strong', money(r.totalGrossAmount))),
        h('dt', 'Balance'),
        h('dd', h('strong', { style: { color: r.balance?.amount > 0 ? 'var(--bad)' : 'var(--ok)' } }, money(r.balance))),
        r.cancellationFee?.fee?.amount ? h('dt', 'Cancellation fee') : null,
        r.cancellationFee?.fee?.amount
          ? h('dd', [money(r.cancellationFee.fee),
            h('span', { style: { color: 'var(--muted)' } }, ` · ${r.cancellationFee.name ?? ''}`)])
          : null,
        r.checkInTime ? h('dt', 'Checked in') : null,
        r.checkInTime ? h('dd', dateTime(r.checkInTime)) : null,
        r.checkOutTime ? h('dt', 'Checked out') : null,
        r.checkOutTime ? h('dd', dateTime(r.checkOutTime)) : null,
        r.cancellationTime ? h('dt', 'Cancelled') : null,
        r.cancellationTime ? h('dd', dateTime(r.cancellationTime)) : null,
      ]),
      r.comment ? h('div', { style: { marginTop: '12px', fontSize: '13px' } }, [
        h('span', { style: { color: 'var(--muted)' } }, 'Comment: '), r.comment,
      ]) : null,
      r.validationMessages?.length
        ? h('div.warnings', { style: { marginTop: '12px' } }, [
          h('strong', 'Validation messages'),
          h('ul', r.validationMessages.map((m) => h('li', m.message))),
        ])
        : null,
    ]),
  ]);
}

function guestCard(r) {
  const g = r.primaryGuest ?? {};
  return h('section.card', [
    h('header', [h('h2', 'Guest')]),
    h('div.body', [
      h('dl.kv', [
        h('dt', 'Name'), h('dd', guestName(g)),
        g.email ? h('dt', 'Email') : null, g.email ? h('dd', h('a', { href: `mailto:${g.email}` }, g.email)) : null,
        g.phone ? h('dt', 'Phone') : null, g.phone ? h('dd', g.phone) : null,
        g.nationalityCountryCode ? h('dt', 'Nationality') : null,
        g.nationalityCountryCode ? h('dd', g.nationalityCountryCode) : null,
        g.address?.city ? h('dt', 'Address') : null,
        g.address?.city ? h('dd', [g.address.addressLine1, g.address.postalCode, g.address.city, g.address.countryCode].filter(Boolean).join(', ')) : null,
        r.booker && guestName(r.booker) !== guestName(g) ? h('dt', 'Booker') : null,
        r.booker && guestName(r.booker) !== guestName(g) ? h('dd', guestName(r.booker)) : null,
      ]),
    ]),
  ]);
}

function nightsCard(r) {
  return h('section.card', [
    h('header', [h('h2', 'Nightly breakdown'), h('div.spacer'),
      h('span.chip', `${r.timeSlices?.length ?? 0} nights`)]),
    h('div.body', [
      ...(r.timeSlices ?? []).map((slice) => h('div.folio-line', [
        h('div.date', date(slice.serviceDate, { day: '2-digit', month: 'short' })),
        h('div', [
          slice.ratePlan?.name ?? slice.ratePlan?.id,
          slice.includedServices?.length
            ? h('div.meta', `includes ${slice.includedServices.map((i) => i.service?.name ?? i.service?.code).join(', ')}`)
            : null,
        ]),
        h('div.amt', money(slice.totalGrossAmount)),
      ])),
      h('div.folio-total', [h('span', 'Room total'), h('span', money({
        amount: (r.timeSlices ?? []).reduce((sum, s) => sum + (s.totalGrossAmount?.amount ?? 0), 0),
        currency: r.totalGrossAmount?.currency ?? 'EUR',
      }))]),
      r.taxDetails?.length
        ? h('div', { style: { marginTop: '10px', fontSize: '12px', color: 'var(--muted)' } }, [
          h('div', { style: { fontWeight: 600, marginBottom: '3px' } }, 'Tax breakdown for the whole stay'),
          ...r.taxDetails.map((t) => h('div', {
            style: { display: 'flex', justifyContent: 'space-between' },
          }, [
            h('span', `VAT ${t.vatPercent}%`),
            h('span', `net ${money(t.net)} · tax ${money(t.tax)}`),
          ])),
        ])
        : null,
    ]),
  ]);
}

function servicesCard(r, context, refresh) {
  const canEdit = (r.actions ?? []).find((a) => a.action === 'AddService')?.isAllowed;
  return h('section.card', [
    h('header', [
      h('h2', 'Services'), h('div.spacer'),
      canEdit ? h('button.btn.sm', { onclick: () => addServiceDialog(r, context, refresh) }, '+ Add service') : null,
    ]),
    h('div.body', [
      r.services?.length
        ? r.services.map((s) => h('div.folio-line', [
          h('div.date', `${s.dates.length}×`),
          h('div', [
            s.service?.name ?? s.service?.code,
            h('div.meta', [
              s.dates.map((d) => date(d.serviceDate, { day: '2-digit', month: 'short' })).join(', '),
              s.dates.some((d) => d.isMandatory) ? ' · included in the rate' : '',
            ]),
          ]),
          h('div.amt', [
            money(s.totalAmount ? { amount: s.totalAmount.grossAmount, currency: s.totalAmount.currency } : null),
            canEdit && !s.dates.some((d) => d.isMandatory)
              ? h('div', [h('button.btn.ghost.sm', {
                style: { padding: '0 4px', fontSize: '11px' },
                onclick: async (e) => {
                  e.stopPropagation();
                  const ok = await context.attempt(api.removeService(r.id, s.service.id), {
                    success: 'Service removed', failure: 'Could not remove the service',
                  });
                  if (ok) refresh();
                },
              }, 'remove')])
              : null,
          ]),
        ]))
        : h('div', { style: { color: 'var(--muted)', fontSize: '13px' } }, 'No services booked.'),
    ]),
  ]);
}

async function addServiceDialog(reservation, context, refresh) {
  const { items } = await cached('services', () => api.services(state.property.id));
  if (!items.length) {
    toast('No services configured', 'Add one under Property → Services first.', 'bad');
    return;
  }
  const picker = select(items.map((s) => ({ value: s.id, label: `${s.name} · ${money(s.defaultGrossPrice)} per ${s.pricingUnit.toLowerCase()}` })));
  const amount = input({ type: 'number', step: '0.01', placeholder: 'default price' });

  const sheet = modal({
    title: 'Add a service',
    body: [
      field('Service', picker),
      field('Override price', amount, 'Leave empty to use the service default.'),
    ],
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const body = { serviceId: picker.value };
          if (amount.value) body.amount = { amount: Number(amount.value), currency: reservation.totalGrossAmount?.currency ?? 'EUR' };
          const ok = await context.attempt(api.bookService(reservation.id, body), {
            success: 'Service added', failure: 'Could not add the service',
          });
          if (ok) {
            closeOverlay();
            refresh();
          }
        },
      }, 'Add'),
    ],
  });
  return sheet;
}

function folioCard(folio, reservation, context, refresh) {
  const lines = [
    ...(folio.charges ?? []).map((c) => ({
      date: c.serviceDate, name: c.name, meta: `${c.serviceType}${c.quantity > 1 ? ` · ×${c.quantity}` : ''}`,
      amount: c.amount.grossAmount, currency: c.amount.currency,
    })),
    ...(folio.transitoryCharges ?? []).map((c) => ({
      date: c.serviceDate, name: c.name, meta: 'transitory', amount: c.amount.amount, currency: c.amount.currency,
    })),
    ...(folio.allowances ?? []).map((a) => ({
      date: a.serviceDate, name: `Allowance — ${a.reason}`, meta: 'allowance',
      amount: -a.amount.grossAmount, currency: a.amount.currency, negative: true,
    })),
    ...(folio.payments ?? []).map((p) => ({
      date: p.businessDate, name: `Payment — ${p.method}`, meta: p.receipt ? `receipt ${p.receipt}` : '',
      amount: -p.amount.amount, currency: p.amount.currency, negative: true,
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const open = folio.status === 'Open';

  return h('section.card', [
    h('header', [
      h('h2', folio.isMainFolio ? 'Folio' : 'Folio (additional)'),
      h('span.chip', { class: tone(folio.status) }, label(folio.status)),
      h('div.spacer'),
      h('span.mono', { style: { fontSize: '11.5px', color: 'var(--muted)' } }, folio.id),
    ]),
    h('div.body', [
      lines.length
        ? lines.map((line) => h('div.folio-line', [
          h('div.date', date(line.date, { day: '2-digit', month: 'short' })),
          h('div', [line.name, line.meta ? h('div.meta', line.meta) : null]),
          h(`div.amt${line.negative ? '.neg' : ''}`, money({ amount: line.amount, currency: line.currency })),
        ]))
        : h('div', { style: { color: 'var(--muted)', fontSize: '13px' } }, 'Nothing posted yet.'),
      h('div.folio-total', [
        h('span', 'Balance'),
        h('span', { style: { color: folio.balance.amount > 0 ? 'var(--bad)' : 'inherit' } }, money(folio.balance)),
      ]),
      open ? h('div.row', { style: { marginTop: '14px' } }, [
        h('button.btn.sm', { onclick: () => postChargeDialog(folio, context, refresh) }, '+ Charge'),
        h('button.btn.sm', {
          onclick: () => postPaymentDialog(folio, context, refresh),
          disabled: Math.abs(folio.balance.amount) < 0.005,
        }, '+ Payment'),
      ]) : null,
    ]),
  ]);
}

async function postChargeDialog(folio, context, refresh) {
  const [types, vat] = await Promise.all([
    cached('serviceTypes', () => api.serviceTypes()),
    cached('vatTypes', () => api.vatTypes(state.property.location?.countryCode)),
  ]);
  const name = input({ placeholder: 'e.g. Minibar' });
  const serviceType = select(
    (types.serviceTypes ?? []).filter((t) => ['Other', 'Accommodation', 'FoodAndBeverages', 'CityTax'].includes(t)),
    { value: 'Other' },
  );
  const vatType = select((vat.vatTypes ?? []).map((v) => ({ value: v.type, label: `${v.type} (${v.percent}%)` })), { value: 'Normal' });
  const amount = input({ type: 'number', step: '0.01', placeholder: '0.00' });
  const quantity = input({ type: 'number', step: '1', min: '1', value: '1' });

  modal({
    title: 'Post a charge',
    body: [
      field('Description', name),
      h('div.row', [
        h('div', { style: { flex: '1' } }, field('Service type', serviceType)),
        h('div', { style: { flex: '1' } }, field('VAT', vatType)),
      ]),
      h('div.row', [
        h('div', { style: { flex: '1' } }, field('Gross amount', amount)),
        h('div', { style: { flex: '0 0 110px' } }, field('Quantity', quantity)),
      ]),
    ],
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          if (!name.value.trim() || !amount.value) {
            toast('Description and amount are required', null, 'bad');
            return;
          }
          const ok = await context.attempt(api.postCharge(folio.id, {
            name: name.value.trim(),
            serviceType: serviceType.value,
            vatType: vatType.value,
            amount: { amount: Number(amount.value), currency: folio.balance.currency },
            quantity: Number(quantity.value) || 1,
          }), { success: 'Charge posted', failure: 'Could not post the charge' });
          if (ok) {
            closeOverlay();
            refresh();
          }
        },
      }, 'Post charge'),
    ],
  });
}

async function postPaymentDialog(folio, context, refresh) {
  const methods = await cached('paymentMethods', () => api.paymentMethods());
  const method = select(
    (methods.paymentMethods ?? []).filter((m) => ['Cash', 'CreditCard', 'BankTransfer', 'Amex', 'MasterCard', 'VisaCredit', 'PayPal', 'Voucher'].includes(m)),
    { value: 'CreditCard' },
  );
  const amount = input({ type: 'number', step: '0.01', value: String(folio.balance.amount.toFixed(2)) });

  modal({
    title: 'Take a payment',
    body: [
      field('Method', method),
      field('Amount', amount, `Outstanding balance is ${money(folio.balance)}.`),
    ],
    footer: [
      h('button.btn', { onclick: closeOverlay }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const ok = await context.attempt(api.postPayment(folio.id, {
            method: method.value,
            amount: { amount: Number(amount.value), currency: folio.balance.currency },
          }), { success: 'Payment recorded', failure: 'Could not record the payment' });
          if (ok) {
            closeOverlay();
            refresh();
          }
        },
      }, 'Take payment'),
    ],
  });
}

function historyCard(entries) {
  return h('section.card', [
    h('header', [h('h2', 'History')]),
    h('div.body', [
      entries.length
        ? h('div.timeline', entries.map((e) => h('div.item', [
          h('div.when', dateTime(e.created)),
          h('div', [h('strong', e.eventType), e.message ? h('div.meta', { style: { color: 'var(--muted)', fontSize: '12px' } }, e.message) : null]),
        ])))
        : h('div', { style: { color: 'var(--muted)', fontSize: '13px' } }, 'No events recorded.'),
    ]),
  ]);
}

/* -------------------------------------------------------------- actions */

/**
 * Footer actions.
 *
 * The API returns every action with an `isAllowed` flag and a reason when it
 * is not. Rendering all of them as disabled buttons is noise, so allowed
 * actions become buttons and the blocked ones that a user would reasonably
 * expect are explained in one line above them.
 */
const ACTION_LABELS = {
  AssignUnit: 'Assign room',
  UnassignUnit: 'Release room',
  CheckIn: 'Check in',
  CheckOut: 'Check out',
  CheckInRevert: 'Undo check-in',
  NoShow: 'No show',
  Cancel: 'Cancel',
  LockUnit: 'Lock room',
  UnlockUnit: 'Unlock room',
};

/**
 * Which blocked actions are worth explaining, per status. Telling someone
 * that a confirmed reservation cannot be checked out is noise; telling them
 * why it cannot be checked *in* is the whole point.
 */
const EXPLAIN_WHEN_BLOCKED = {
  Confirmed: ['CheckIn', 'AssignUnit'],
  InHouse: ['CheckOut'],
  CheckedOut: [],
  Canceled: [],
  NoShow: [],
};

const RUNNERS = {
  AssignUnit: (r) => api.reservationAction(r.id, 'assign-unit'),
  UnassignUnit: (r) => api.reservationAction(r.id, 'unassign-units'),
  CheckIn: (r) => api.reservationAction(r.id, 'checkin'),
  CheckOut: (r) => api.reservationAction(r.id, 'checkout'),
  CheckInRevert: (r) => api.reservationAction(r.id, 'revert-checkin'),
  NoShow: (r) => api.reservationAction(r.id, 'noshow'),
  Cancel: (r) => api.reservationAction(r.id, 'cancel'),
  LockUnit: (r) => api.reservationAction(r.id, 'lock-unit'),
  UnlockUnit: (r) => api.reservationAction(r.id, 'unlock-unit'),
};

const CONFIRMATIONS = {
  NoShow: () => ({
    title: 'Mark as a no-show?',
    message: 'The no-show fee from the rate plan policy will be posted to the folio.',
    confirmLabel: 'Mark no-show',
    danger: true,
  }),
  Cancel: (r) => ({
    title: 'Cancel this reservation?',
    message: r.cancellationFee?.fee?.amount
      ? `A cancellation fee of ${money(r.cancellationFee.fee)} will be posted to the folio.`
      : 'No cancellation fee applies under this rate plan.',
    confirmLabel: 'Cancel reservation',
    danger: true,
  }),
};

/** The one action a user most likely came here to perform. */
function primaryAction(reservation) {
  if (reservation.status === 'Confirmed') return 'CheckIn';
  if (reservation.status === 'InHouse') return 'CheckOut';
  return null;
}

function actionButtons(r, context, refresh) {
  const entries = new Map((r.actions ?? []).map((a) => [a.action, a]));
  const primary = primaryAction(r);
  const buttons = [];

  const order = ['AssignUnit', 'UnassignUnit', 'CheckIn', 'CheckOut', 'CheckInRevert', 'LockUnit', 'UnlockUnit', 'NoShow', 'Cancel'];
  for (const action of order) {
    const entry = entries.get(action);
    if (!entry?.isAllowed) continue;
    const kind = action === primary ? 'primary' : action === 'Cancel' ? 'danger' : '';
    buttons.push(h(`button.btn${kind ? `.${kind}` : ''}`, {
      onclick: async (event) => {
        const confirmation = CONFIRMATIONS[action]?.(r);
        if (confirmation && !(await confirmDialog(confirmation))) return;
        event.currentTarget.disabled = true;
        const done = await context.attempt(RUNNERS[action](r), {
          success: `${ACTION_LABELS[action]} done`,
          failure: `${ACTION_LABELS[action]} failed`,
        });
        if (done) {
          refresh();
          context.reload();
        } else {
          event.currentTarget.disabled = false;
        }
      },
    }, ACTION_LABELS[action]));

    // Picking a specific room is a separate flow from auto-assignment.
    if (action === 'AssignUnit') {
      buttons.push(h('button.btn', { onclick: () => chooseRoomDialog(r, context, refresh) }, 'Choose room…'));
    }
  }

  buttons.push(h('div.spacer'));
  buttons.push(h('button.btn.ghost', { onclick: closeOverlay }, 'Close'));
  return buttons;
}

/** A single line explaining why the obvious next step is unavailable. */
function blockedNote(r) {
  const blocked = (EXPLAIN_WHEN_BLOCKED[r.status] ?? [])
    .map((action) => (r.actions ?? []).find((a) => a.action === action))
    .filter((entry) => entry && !entry.isAllowed && entry.reasons?.length)
    .map((entry) => `${ACTION_LABELS[entry.action]}: ${entry.reasons[0].message}`);
  if (!blocked.length) return null;
  return h('div', {
    style: {
      fontSize: '12.5px', color: 'var(--muted)', background: 'var(--panel)',
      border: '1px solid var(--line)', borderLeft: '3px solid var(--warn)',
      borderRadius: 'var(--radius-sm)', padding: '9px 12px',
    },
  }, blocked.map((text) => h('div', text)));
}

async function chooseRoomDialog(reservation, context, refresh) {
  const sheet = modal({ title: 'Choose a room', body: [skeleton(150)] });
  const bodyEl = sheet.querySelector('.body');
  const { items } = await api.availableUnitsForReservation(reservation.id);

  if (!items.length) {
    mount(bodyEl, emptyState('No rooms free', 'Nothing in this unit group is available for the whole stay.'));
    return;
  }

  let chosen = null;
  const tiles = items.map((unit) => h(`button.unit-tile.${unit.status.condition}`, {
    type: 'button',
    onclick: (event) => {
      for (const node of bodyEl.querySelectorAll('.unit-tile')) node.classList.remove('selected');
      event.currentTarget.classList.add('selected');
      chosen = unit.id;
      confirm.disabled = false;
    },
  }, [
    h('div.name', unit.name),
    h('div.grp', unit.unitGroup?.name ?? ''),
    h('span.chip', { class: tone(unit.status.condition) }, label(unit.status.condition)),
  ]));

  const confirm = h('button.btn.primary', {
    disabled: true,
    onclick: async () => {
      const ok = await context.attempt(api.assignSpecificUnit(reservation.id, chosen), {
        success: 'Room assigned', failure: 'Could not assign that room',
      });
      if (ok) {
        closeOverlay();
        refresh();
        context.reload();
      }
    },
  }, 'Assign');

  mount(bodyEl, h('div.unit-grid', tiles));
  sheet.querySelector('.sheet').append(h('footer', [
    h('button.btn', { onclick: closeOverlay }, 'Cancel'),
    confirm,
  ]));
}

export { number };
