import { mount,
  h, drawer, closeOverlay, field, input, select, chip, skeleton, emptyState, toast,
} from '../dom.js';
import { api } from '../api.js';
import { state, businessDate, cached } from '../state.js';
import { money, date, addDays, diffDays, nights } from '../format.js';
import { openReservation } from './reservation-detail.js';

/**
 * Booking flow: pick dates and occupancy, shop the offers the API returns,
 * then capture the guest. The offer carries its own validation messages, so
 * an unbookable rate is shown greyed out with the reason rather than hidden.
 */
export function openNewBooking(context, preset = {}) {
  const panel = drawer({
    title: 'New booking',
    subtitle: state.property.displayName ?? state.property.id,
    body: [skeleton(120)],
  });
  const model = {
    arrival: preset.arrival ?? businessDate(),
    departure: preset.departure ?? addDays(businessDate(), 1),
    adults: preset.adults ?? 2,
    children: '',
    channelCode: 'Direct',
    promoCode: '',
    offer: null,
  };
  paintSearch(panel, model, context);
  return panel;
}

/**
 * `"5, 9"` -> `[5, 9]`. Splitting an empty string yields `['']`, which
 * `Number` turns into 0 - one phantom infant that pushes the party over the
 * unit group's capacity - so blanks are dropped before parsing.
 */
function parseAges(text) {
  return String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(Number)
    .filter((age) => Number.isFinite(age) && age >= 0);
}

function paintSearch(panel, model, context) {
  const body = panel.querySelector('.body');
  const results = h('div', [emptyState('Choose dates to see rates', 'Offers come straight from the pricing engine.', '◇')]);

  const arrival = input({ type: 'date', value: model.arrival });
  const departure = input({ type: 'date', value: model.departure });
  const adults = input({ type: 'number', min: '1', max: '10', value: String(model.adults) });
  const children = input({ placeholder: 'e.g. 5, 9', value: model.children });
  const channel = select(['Direct', 'Ibe', 'BookingCom', 'Expedia', 'ChannelManager', 'Hrs'], { value: model.channelCode });
  const promo = input({ placeholder: 'optional', value: model.promoCode });

  async function search() {
    model.arrival = arrival.value;
    model.departure = departure.value;
    model.adults = Number(adults.value) || 1;
    model.children = children.value;
    model.channelCode = channel.value;
    model.promoCode = promo.value.trim();

    if (diffDays(model.arrival, model.departure) < 1) {
      mount(results, h('div.warnings', 'Departure must be at least one day after arrival.'));
      return;
    }
    mount(results, skeleton(160));

    const childrenAges = parseAges(model.children);
    try {
      const payload = await api.offers({
        propertyId: state.property.id,
        arrival: model.arrival,
        departure: model.departure,
        adults: model.adults,
        childrenAges,
        channelCode: model.channelCode,
        promoCode: model.promoCode || undefined,
        includeUnavailable: true,
      });
      mount(results, offerList(payload.offers ?? [], model, panel, context, childrenAges));
    } catch (err) {
      mount(results, h('div.warnings', err.messages?.join(' ') ?? String(err)));
    }
  }

  for (const control of [arrival, departure, adults, children, channel, promo]) {
    control.addEventListener('change', search);
  }

  mount(body, 
    h('section.card', [
      h('div.body', [
        h('div.row', [
          h('div', { style: { flex: '1 1 150px' } }, field('Arrival', arrival)),
          h('div', { style: { flex: '1 1 150px' } }, field('Departure', departure)),
        ]),
        h('div.row', { style: { marginTop: '12px' } }, [
          h('div', { style: { flex: '0 0 96px' } }, field('Adults', adults)),
          h('div', { style: { flex: '1 1 130px' } }, field('Children ages', children)),
          h('div', { style: { flex: '1 1 130px' } }, field('Channel', channel)),
          h('div', { style: { flex: '1 1 130px' } }, field('Promo code', promo)),
        ]),
      ]),
    ]),
    results,
  );

  const footer = panel.querySelector('footer') ?? h('footer');
  if (!panel.contains(footer)) panel.append(footer);
  mount(footer, 
    h('div.spacer'),
    h('button.btn', { onclick: closeOverlay }, 'Close'),
  );

  search();
}

function offerList(offers, model, panel, context, childrenAges) {
  if (!offers.length) {
    return emptyState('No rates for these dates', 'Load rates for this rate plan, or widen the search.');
  }
  const stayNights = diffDays(model.arrival, model.departure);

  return h('div.grid', { style: { gap: '10px' } }, offers.map((offer) => {
    const blocked = offer.validationMessages?.length > 0 || offer.availableUnits < 1;
    return h(`div.offer${blocked ? '' : ''}`, {
      style: blocked ? { opacity: '.62' } : null,
    }, [
      h('div', [
        h('div.title', offer.ratePlan.name ?? offer.ratePlan.id),
        h('div.sub', [
          offer.unitGroup?.name,
          ' · ', `${offer.availableUnits} available`,
          ' · ', `up to ${offer.unitGroup?.maxPersons} guests`,
        ]),
        h('div.sub', { style: { marginTop: '4px' } }, [
          offer.cancellationFee?.fee?.amount
            ? `Cancellation fee ${money(offer.cancellationFee.fee)}`
            : 'Free cancellation',
          offer.cityTaxes?.length ? ` · incl. city tax ${money(offer.cityTaxes[0].totalGrossAmount)}` : '',
        ]),
        blocked
          ? h('div.warnings', { style: { marginTop: '8px' } },
            h('ul', (offer.validationMessages ?? [{ message: 'Fully booked' }]).map((m) => h('li', m.message))))
          : null,
      ]),
      h('div.price', [
        h('div.amount', money(offer.totalGrossAmount)),
        h('div.per', `${money({ amount: offer.totalGrossAmount.amount / stayNights, currency: offer.totalGrossAmount.currency })} / night`),
        h('button.btn.primary.sm', {
          style: { marginTop: '8px' },
          disabled: blocked,
          onclick: () => paintGuest(panel, model, offer, context, childrenAges),
        }, 'Select'),
      ]),
    ]);
  }));
}

function paintGuest(panel, model, offer, context, childrenAges) {
  const body = panel.querySelector('.body');

  const firstName = input({ placeholder: 'First name', autocomplete: 'given-name' });
  const lastName = input({ placeholder: 'Last name', autocomplete: 'family-name' });
  const email = input({ type: 'email', placeholder: 'guest@example.com' });
  const phone = input({ placeholder: 'optional' });
  const country = input({ placeholder: 'DE', maxlength: '2', style: { textTransform: 'uppercase' } });
  const comment = input({ placeholder: 'Anything the front desk should know' });
  const travelPurpose = select([{ value: '', label: '—' }, 'Leisure', 'Business']);
  const errors = h('div.warnings', { style: { display: 'none' } });

  const servicesBox = h('div', { style: { display: 'grid', gap: '6px' } });
  const chosenServices = new Set();
  loadServices();

  async function loadServices() {
    const { items } = await cached('services', () => api.services(state.property.id));
    const included = new Set((offer.services ?? []).map((s) => s.service.id));
    const optional = items.filter((s) => !included.has(s.id));
    if (!optional.length) {
      mount(servicesBox, h('div', { style: { color: 'var(--muted)', fontSize: '12.5px' } }, 'No optional services.'));
      return;
    }
    mount(servicesBox, ...optional.map((service) => h('label', {
      style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', cursor: 'pointer' },
    }, [
      h('input', {
        type: 'checkbox',
        style: { width: 'auto' },
        onchange: (e) => {
          if (e.target.checked) chosenServices.add(service.id);
          else chosenServices.delete(service.id);
        },
      }),
      h('span', [service.name, h('span', { style: { color: 'var(--muted)' } },
        ` · ${money(service.defaultGrossPrice)} per ${service.pricingUnit.toLowerCase()}`)]),
    ])));
  }

  mount(body, 
    h('section.card', [
      h('header', [
        h('h2', 'Selected rate'), h('div.spacer'),
        h('button.btn.ghost.sm', { onclick: () => paintSearch(panel, model, context) }, '← Change'),
      ]),
      h('div.body', [
        h('dl.kv', [
          h('dt', 'Rate plan'), h('dd', offer.ratePlan.name ?? offer.ratePlan.id),
          h('dt', 'Unit group'), h('dd', offer.unitGroup?.name),
          h('dt', 'Stay'), h('dd', `${date(model.arrival)} → ${date(model.departure)} · ${nights(model.arrival, model.departure)}`),
          h('dt', 'Guests'), h('dd', `${model.adults} adult${model.adults === 1 ? '' : 's'}${childrenAges.length ? `, ${childrenAges.length} child` : ''}`),
          h('dt', 'Total'), h('dd', h('strong', money(offer.totalGrossAmount))),
        ]),
      ]),
    ]),
    h('section.card', [
      h('header', [h('h2', 'Guest')]),
      h('div.body', [
        errors,
        h('div.row', [
          h('div', { style: { flex: '1' } }, field('First name', firstName)),
          h('div', { style: { flex: '1' } }, field('Last name *', lastName)),
        ]),
        h('div.row', { style: { marginTop: '12px' } }, [
          h('div', { style: { flex: '2' } }, field('Email', email)),
          h('div', { style: { flex: '1' } }, field('Phone', phone)),
          h('div', { style: { flex: '0 0 90px' } }, field('Country', country)),
        ]),
        h('div.row', { style: { marginTop: '12px' } }, [
          h('div', { style: { flex: '2' } }, field('Comment', comment)),
          h('div', { style: { flex: '1' } }, field('Travel purpose', travelPurpose)),
        ]),
      ]),
    ]),
    h('section.card', [
      h('header', [h('h2', 'Extras')]),
      h('div.body', [servicesBox]),
    ]),
  );

  const confirm = h('button.btn.primary', { onclick: submit }, `Book · ${money(offer.totalGrossAmount)}`);
  panel.querySelector('footer').replaceChildren(
    h('button.btn', { onclick: () => paintSearch(panel, model, context) }, '← Back'),
    h('div.spacer'),
    h('button.btn.ghost', { onclick: closeOverlay }, 'Cancel'),
    confirm,
  );

  async function submit() {
    if (!lastName.value.trim()) {
      errors.textContent = 'A last name is required.';
      errors.style.display = '';
      lastName.focus();
      return;
    }
    errors.style.display = 'none';
    confirm.disabled = true;
    confirm.textContent = 'Booking…';

    const guest = {
      firstName: firstName.value.trim() || undefined,
      lastName: lastName.value.trim(),
      email: email.value.trim() || undefined,
      phone: phone.value.trim() || undefined,
      nationalityCountryCode: country.value.trim().toUpperCase() || undefined,
    };
    const stayNights = diffDays(model.arrival, model.departure);

    try {
      const created = await api.createBooking({
        booker: guest,
        comment: comment.value.trim() || undefined,
        reservations: [{
          arrival: model.arrival,
          departure: model.departure,
          adults: model.adults,
          childrenAges: childrenAges.length ? childrenAges : undefined,
          channelCode: model.channelCode,
          source: model.channelCode === 'Direct' ? 'Front desk' : undefined,
          primaryGuest: guest,
          timeSlices: Array.from({ length: stayNights }, () => ({ ratePlanId: offer.ratePlan.id })),
          services: [...chosenServices].map((serviceId) => ({ serviceId })),
          travelPurpose: travelPurpose.value || undefined,
          promoCode: model.promoCode || undefined,
          companyId: offer.companyId || undefined,
          corporateCode: offer.corporateCode || undefined,
        }],
      });
      const reservationId = created.reservationIds[0].id;
      toast('Booking created', `${created.id} · ${reservationId}`, 'ok');
      closeOverlay();
      context.reload();
      openReservation(reservationId, context);
    } catch (err) {
      mount(errors, 
        h('strong', 'The booking was refused'),
        h('ul', (err.messages ?? [String(err)]).map((m) => h('li', m))),
      );
      errors.style.display = '';
      confirm.disabled = false;
      confirm.textContent = `Book · ${money(offer.totalGrossAmount)}`;
    }
  }
}

export { chip };
