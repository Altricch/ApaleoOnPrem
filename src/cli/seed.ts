/**
 * Seeds a demo account modelled on apaleo's own sandbox: two properties, a
 * handful of unit groups and units, rate plans with rates loaded for a year,
 * services, policies, taxes, and a spread of reservations across past,
 * present and future so every list endpoint has something to show.
 *
 * Run with `npm run seed` (add `--reset` to wipe first).
 */
import { closeDb, getDb, resetDb, transact } from '../core/db';
import { addDays, dayOfWeek, nightsBetween, nowIso, today } from '../core/dates';
import { scoped, setRandomSource, unitId as mintUnitId, blockId as mintBlockId, groupId as mintGroupId } from '../core/ids';
import { grossToAmount, money } from '../core/money';
import { db } from '../domain/repo';
import { bootstrapChartOfAccounts } from '../domain/accounts';
import { putRate } from '../domain/pricing';
import {
  materialize, newBookingId, nextReservationId, quote, assignUnit, type CreateReservationInput,
} from '../domain/reservations';
import { ensureMainFolio, postFolioPayment, folioTotals } from '../domain/folios';
import { postThrough } from '../domain/posting';
import { logReservation } from '../domain/audit';
import { openRestrictions, type Booking, type Property, type Reservation, type Surcharge } from '../domain/types';

/** Deterministic pseudo-randomness, so a reseed reproduces the same ids. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const rand = seededRandom(20240501);

/** Absolute surcharge per additional adult, shared by the seeded rate plans. */
const OCCUPANCY_SURCHARGES: Surcharge[] = [
  { adults: 2, type: 'Absolute', value: 25 },
  { adults: 3, type: 'Absolute', value: 45 },
  { adults: 4, type: 'Absolute', value: 60 },
];

interface PropertySpec {
  code: string;
  name: string;
  description: string;
  city: string;
  countryCode: string;
  postalCode: string;
  addressLine1: string;
  timeZone: string;
  currency: string;
  unitGroups: { code: string; name: string; maxPersons: number; units: string[]; baseRate: number }[];
}

const PROPERTIES: PropertySpec[] = [
  {
    code: 'MUC',
    name: 'Demo Hotel Munich',
    description: 'A 40-room city hotel a short walk from Marienplatz.',
    city: 'Munich',
    countryCode: 'DE',
    postalCode: '80331',
    addressLine1: 'Marienplatz 1',
    timeZone: 'Europe/Berlin',
    currency: 'EUR',
    unitGroups: [
      { code: 'SGL', name: 'Single Room', maxPersons: 1, units: ['101', '102', '103', '104', '105', '106'], baseRate: 89 },
      { code: 'DBL', name: 'Double Room', maxPersons: 2, units: ['201', '202', '203', '204', '205', '206', '207', '208'], baseRate: 129 },
      { code: 'SUI', name: 'Suite', maxPersons: 4, units: ['301', '302', '303'], baseRate: 249 },
    ],
  },
  {
    code: 'BER',
    name: 'Demo Apartments Berlin',
    description: 'Serviced apartments in Prenzlauer Berg.',
    city: 'Berlin',
    countryCode: 'DE',
    postalCode: '10119',
    addressLine1: 'Kastanienallee 12',
    timeZone: 'Europe/Berlin',
    currency: 'EUR',
    unitGroups: [
      { code: 'STU', name: 'Studio', maxPersons: 2, units: ['A1', 'A2', 'A3', 'A4'], baseRate: 109 },
      { code: 'APT', name: 'One-bedroom Apartment', maxPersons: 3, units: ['B1', 'B2', 'B3'], baseRate: 159 },
    ],
  },
];

const GUESTS = [
  { firstName: 'Anna', lastName: 'Schmidt', email: 'anna.schmidt@example.com', countryCode: 'DE' },
  { firstName: 'Liam', lastName: "O'Brien", email: 'liam.obrien@example.ie', countryCode: 'IE' },
  { firstName: 'Yuki', lastName: 'Tanaka', email: 'yuki.tanaka@example.jp', countryCode: 'JP' },
  { firstName: 'Marta', lastName: 'Kowalska', email: 'marta.kowalska@example.pl', countryCode: 'PL' },
  { firstName: 'Tom', lastName: 'Becker', email: 'tom.becker@example.de', countryCode: 'DE' },
  { firstName: 'Sofia', lastName: 'Rossi', email: 'sofia.rossi@example.it', countryCode: 'IT' },
  { firstName: 'Noah', lastName: 'Dubois', email: 'noah.dubois@example.fr', countryCode: 'FR' },
  { firstName: 'Elena', lastName: 'Petrova', email: 'elena.petrova@example.bg', countryCode: 'BG' },
  { firstName: 'Carlos', lastName: 'Fernández', email: 'carlos.fernandez@example.es', countryCode: 'ES' },
  { firstName: 'Ingrid', lastName: 'Larsen', email: 'ingrid.larsen@example.no', countryCode: 'NO' },
];

export interface SeedSummary {
  properties: number;
  units: number;
  ratePlans: number;
  rates: number;
  reservations: number;
  folios: number;
}

export function seed(options: { reset?: boolean; days?: number } = {}): SeedSummary {
  setRandomSource(rand);
  getDb();
  if (options.reset) resetDb();

  const horizon = options.days ?? 365;
  let rates = 0;
  let reservationCount = 0;

  transact(() => {
    for (const spec of PROPERTIES) {
      const property = createProperty(spec);
      createUnits(property, spec);
      createPolicies(property);
      createServices(property);
      createCityTax(property);
      createAgeCategories(property);
      rates += createRatePlans(property, spec, horizon);
    }
    reservationCount = createBookings(horizon);
    createGroupAndBlock();
  });

  const summary: SeedSummary = {
    properties: db.properties.count(),
    units: db.units.count(),
    ratePlans: db.ratePlans.count(),
    rates,
    reservations: reservationCount,
    folios: db.folios.count(),
  };
  return summary;
}

function createProperty(spec: PropertySpec): Property {
  const property: Property = {
    id: spec.code,
    code: spec.code,
    isTemplate: false,
    name: { en: spec.name },
    description: { en: spec.description },
    companyName: `${spec.name} GmbH`,
    managingDirectors: 'Alex Meyer, Jordan Weiss',
    commercialRegisterEntry: `HRB ${100000 + spec.code.charCodeAt(0)}`,
    taxId: `DE${310000000 + spec.code.charCodeAt(0) * 1000}`,
    location: {
      addressLine1: spec.addressLine1,
      postalCode: spec.postalCode,
      city: spec.city,
      countryCode: spec.countryCode,
    },
    bankAccount: { iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', bank: 'Commerzbank' },
    paymentTerms: { en: 'Payment is due on departure unless agreed otherwise.' },
    timeZone: spec.timeZone,
    currencyCode: spec.currency,
    created: nowIso(),
    status: 'Live',
    isArchived: false,
    defaultCheckInTime: '15:00',
    defaultCheckOutTime: '11:00',
    businessDate: today(spec.timeZone),
  };
  db.properties.put(property);

  db.timeSliceDefinitions.put({
    id: scoped(property.id, 'NIGHT'),
    propertyId: property.id,
    name: { en: 'Night' },
    template: 'OverNight',
    checkInTime: '15:00',
    checkOutTime: '11:00',
  });
  db.propertySettings.put({
    id: scoped(property.id, 'SETTINGS'),
    propertyId: property.id,
    overbookingByUnitGroup: {},
    globalOverbooking: 0,
    languages: ['en', 'de'],
    defaultLanguage: 'en',
  });
  db.featureSettings.put({
    id: scoped(property.id, 'FEATURES'),
    propertyId: property.id,
    areCustomRevenueSubAccountsEnabled: true,
    performAccountingForOpenInvoiceActions: true,
    showRecipientForEachLineItemOnTheInvoice: false,
    invoiceNumberPattern: `${property.id}-{yyyy}-{00000}`,
    advanceInvoiceNumberPattern: `${property.id}-A-{yyyy}-{00000}`,
  });
  db.capturePolicies.put({
    id: scoped(property.id, 'DEFAULT'),
    propertyId: property.id,
    code: 'DEFAULT',
    captureNoShowFee: true,
    captureCancellationFee: true,
    capturePrepayment: true,
    postOtaBankTransferOnCheckOut: false,
    capturePayment: 'CheckOut',
  });
  db.invoiceAddresses.put({
    id: property.id,
    propertyId: property.id,
    addressLine1: spec.addressLine1,
    postalCode: spec.postalCode,
    city: spec.city,
    countryCode: spec.countryCode,
  });
  bootstrapChartOfAccounts(property);

  const segments: [string, string][] = [
    ['DIRECT', 'Direct'],
    ['OTA', 'Online travel agency'],
    ['CORP', 'Corporate'],
    ['LEIS', 'Leisure'],
  ];
  for (const [code, name] of segments) {
    const existing = db.marketSegments.get(code);
    if (existing) {
      if (!existing.propertyIds.includes(property.id)) {
        existing.propertyIds.push(property.id);
        db.marketSegments.put(existing);
      }
    } else {
      db.marketSegments.put({ id: code, code, name, propertyIds: [property.id] });
    }
  }
  return property;
}

function createUnits(property: Property, spec: PropertySpec): void {
  const attributes: [string, string][] = [
    ['BALCONY', 'Balcony'],
    ['SEAVIEW', 'View'],
    ['ACCESSIBLE', 'Step-free access'],
    ['QUIET', 'Quiet side'],
  ];
  for (const [id, name] of attributes) {
    if (!db.unitAttributes.exists(id)) db.unitAttributes.put({ id, name, description: name });
  }

  spec.unitGroups.forEach((group, rank) => {
    db.unitGroups.put({
      id: scoped(property.id, group.code),
      code: group.code,
      propertyId: property.id,
      name: { en: group.name },
      description: { en: `${group.name} at ${spec.name}` },
      maxPersons: group.maxPersons,
      rank: rank + 1,
      type: 'BedRoom',
      connectedUnitGroups: [],
    });

    for (const unitName of group.units) {
      const attrs: string[] = [];
      if (unitName.endsWith('1')) attrs.push('QUIET');
      if (group.code === 'SUI') attrs.push('BALCONY');
      db.units.put({
        id: mintUnitId(property.id, (id) => db.units.exists(id)),
        propertyId: property.id,
        unitGroupId: scoped(property.id, group.code),
        name: unitName,
        description: { en: group.name },
        maxPersons: group.maxPersons,
        condition: 'Clean',
        attributes: attrs,
        connectedUnitIds: [],
        created: nowIso(),
        isArchived: false,
      });
    }
  });
}

function createPolicies(property: Property): void {
  db.cancellationPolicies.put({
    id: scoped(property.id, 'FLEX'),
    propertyId: property.id,
    code: 'FLEX',
    name: { en: 'Free cancellation until 18:00' },
    description: { en: 'Cancel free of charge until 18:00 on the day of arrival.' },
    periodFromReference: { hours: 6 },
    reference: 'PriorToArrival',
    fee: { vatType: 'Normal', percentValue: { percent: 100, limit: 1, includeServiceIds: [] } },
  });
  db.cancellationPolicies.put({
    id: scoped(property.id, 'NONREF'),
    propertyId: property.id,
    code: 'NONREF',
    name: { en: 'Non refundable' },
    description: { en: 'The full stay is charged on cancellation.' },
    periodFromReference: { days: 365 },
    reference: 'PriorToArrival',
    fee: { vatType: 'Normal', percentValue: { percent: 100, includeServiceIds: [] } },
  });
  db.noShowPolicies.put({
    id: scoped(property.id, 'FIRSTNIGHT'),
    propertyId: property.id,
    code: 'FIRSTNIGHT',
    name: { en: 'First night' },
    description: { en: 'The first night is charged on a no-show.' },
    fee: { vatType: 'Normal', percentValue: { percent: 100, limit: 1, includeServiceIds: [] } },
  });
}

function createServices(property: Property): void {
  const services: {
    code: string; name: string; price: number; unit: 'Person' | 'Room';
    mode: 'Arrival' | 'Departure' | 'Daily'; type: 'Other' | 'FoodAndBeverages'; vat: 'Normal' | 'Reduced';
  }[] = [
    { code: 'BRKF', name: 'Breakfast', price: 18, unit: 'Person', mode: 'Daily', type: 'FoodAndBeverages', vat: 'Reduced' },
    { code: 'PARK', name: 'Parking', price: 22, unit: 'Room', mode: 'Daily', type: 'Other', vat: 'Normal' },
    { code: 'LATE', name: 'Late check-out', price: 35, unit: 'Room', mode: 'Departure', type: 'Other', vat: 'Normal' },
    { code: 'WLAN', name: 'Premium Wi-Fi', price: 5, unit: 'Room', mode: 'Daily', type: 'Other', vat: 'Normal' },
  ];
  for (const s of services) {
    db.services.put({
      id: scoped(property.id, s.code),
      code: s.code,
      propertyId: property.id,
      name: { en: s.name },
      description: { en: `${s.name} at ${property.code}` },
      defaultGrossPrice: s.price,
      currency: property.currencyCode,
      pricingUnit: s.unit,
      postNextDay: false,
      availability: { mode: s.mode },
      channelCodes: [],
      accountingConfigs: [{ vatType: s.vat, serviceType: s.type, validFrom: '1970-01-01' }],
    });
  }
}

function createCityTax(property: Property): void {
  db.cityTaxes.put({
    id: scoped(property.id, 'CITYTAX'),
    propertyId: property.id,
    code: 'CITYTAX',
    name: { en: 'City tax' },
    description: { en: 'Municipal accommodation tax, 5% of the net room rate.' },
    type: 'PercentOfNet',
    taxHandlingType: 'AfterTax',
    value: 5,
    subcategories: [
      { name: { en: 'Children under 18' }, value: 0, age: { min: 0, max: 17 } },
    ],
    pricingRules: [],
    vatType: 'Without',
    priority: 1,
    includeCityTaxInRateAmount: false,
    ignoredFor: [{ distributionChannel: { channelCode: 'BookingCom', remittanceResponsibility: 'Ota' } }],
  });
}

function createAgeCategories(property: Property): void {
  const categories: [string, string, number, number][] = [
    ['BABY', 'Baby', 0, 2],
    ['CHILD', 'Child', 3, 11],
    ['TEEN', 'Teenager', 12, 17],
  ];
  for (const [code, name, minAge, maxAge] of categories) {
    db.ageCategories.put({
      id: scoped(property.id, code),
      propertyId: property.id,
      code,
      name: { en: name },
      minAge,
      maxAge,
    });
  }
}

function createRatePlans(property: Property, spec: PropertySpec, horizon: number): number {
  let rateCount = 0;
  const start = addDays(property.businessDate, -90);

  for (const group of spec.unitGroups) {
    const unitGroupId = scoped(property.id, group.code);

    // A flexible base plan, then a non-refundable plan derived 10% below it.
    const flex = `FLEX-${group.code}`;
    db.ratePlans.put({
      id: scoped(property.id, flex),
      code: flex,
      propertyId: property.id,
      unitGroupId,
      name: { en: `Flexible rate - ${group.name}` },
      description: { en: 'Cancel free of charge until 18:00 on the day of arrival.' },
      minGuaranteeType: 'PM6Hold',
      priceCalculationMode: 'Truncate',
      timeSliceDefinitionId: scoped(property.id, 'NIGHT'),
      cancellationPolicyId: scoped(property.id, 'FLEX'),
      noShowPolicyId: scoped(property.id, 'FIRSTNIGHT'),
      channelCodes: ['Direct', 'Ibe', 'BookingCom'],
      promoCodes: [],
      bookingPeriods: [],
      includedServices: group.code === 'SUI'
        ? [{ serviceId: scoped(property.id, 'BRKF'), grossPrice: 18, pricingMode: 'Included' }]
        : [],
      companies: [],
      ageCategories: [
        { ageCategoryId: scoped(property.id, 'BABY'), surcharges: [{ adults: 1, value: 0 }, { adults: 2, value: 0 }] },
        { ageCategoryId: scoped(property.id, 'CHILD'), surcharges: [{ adults: 1, value: 20 }, { adults: 2, value: 20 }] },
        { ageCategoryId: scoped(property.id, 'TEEN'), surcharges: [{ adults: 1, value: 30 }, { adults: 2, value: 30 }] },
      ],
      surcharges: group.maxPersons > 1
        ? OCCUPANCY_SURCHARGES.filter((s) => s.adults <= group.maxPersons)
        : [],
      accountingConfigs: [{ vatType: 'Reduced', serviceType: 'Accommodation', validFrom: '1970-01-01' }],
      isSubjectToCityTax: true,
      isDerived: false,
      derivationLevel: 0,
      marketSegmentId: 'DIRECT',
      isArchived: false,
      created: nowIso(),
      updated: nowIso(),
    });

    const nonref = `NONREF-${group.code}`;
    db.ratePlans.put({
      id: scoped(property.id, nonref),
      code: nonref,
      propertyId: property.id,
      unitGroupId,
      name: { en: `Non refundable - ${group.name}` },
      description: { en: 'Save 10%. The full stay is charged on cancellation.' },
      minGuaranteeType: 'Prepayment',
      priceCalculationMode: 'Truncate',
      timeSliceDefinitionId: scoped(property.id, 'NIGHT'),
      cancellationPolicyId: scoped(property.id, 'NONREF'),
      noShowPolicyId: scoped(property.id, 'FIRSTNIGHT'),
      channelCodes: ['Direct', 'Ibe', 'BookingCom', 'Expedia'],
      promoCodes: [],
      bookingPeriods: [],
      includedServices: [],
      companies: [],
      ageCategories: [],
      surcharges: group.maxPersons > 1
        ? OCCUPANCY_SURCHARGES.filter((s) => s.adults <= group.maxPersons)
        : [],
      accountingConfigs: [{ vatType: 'Reduced', serviceType: 'Accommodation', validFrom: '1970-01-01' }],
      isSubjectToCityTax: true,
      isDerived: true,
      derivationLevel: 1,
      pricingRule: { baseRatePlanId: scoped(property.id, flex), type: 'Percent', value: -10 },
      marketSegmentId: 'LEIS',
      isArchived: false,
      created: nowIso(),
      updated: nowIso(),
    });

    // Load a year of rates, higher at weekends and in the summer.
    for (let i = 0; i < horizon + 90; i++) {
      const date = addDays(start, i);
      const day = dayOfWeek(date);
      const weekend = day === 'Friday' || day === 'Saturday';
      const month = Number(date.slice(5, 7));
      const highSeason = month >= 6 && month <= 9;
      const price = Math.round(
        group.baseRate * (weekend ? 1.2 : 1) * (highSeason ? 1.15 : 1),
      );
      putRate({
        ratePlanId: scoped(property.id, flex),
        propertyId: property.id,
        date,
        price,
        currency: property.currencyCode,
        restrictions: openRestrictions(),
      });
      rateCount += 1;
    }
  }
  return rateCount;
}

/**
 * Create a spread of bookings: some already departed, some in house, and a
 * pipeline of future arrivals, so reports and the arrivals list are not empty.
 */
function createBookings(horizon: number): number {
  let count = 0;
  const properties = db.properties.all();

  for (const property of properties) {
    const plans = db.ratePlans.all({ propertyId: property.id }).filter((p) => !p.isDerived);
    const businessDate = property.businessDate;

    const stays: { offset: number; nights: number; status: 'past' | 'inhouse' | 'future' }[] = [
      { offset: -21, nights: 3, status: 'past' },
      { offset: -14, nights: 2, status: 'past' },
      { offset: -9, nights: 4, status: 'past' },
      { offset: -5, nights: 2, status: 'past' },
      { offset: -2, nights: 5, status: 'inhouse' },
      { offset: -1, nights: 3, status: 'inhouse' },
      { offset: 0, nights: 2, status: 'inhouse' },
      { offset: 1, nights: 2, status: 'future' },
      { offset: 3, nights: 1, status: 'future' },
      { offset: 5, nights: 4, status: 'future' },
      { offset: 9, nights: 2, status: 'future' },
      { offset: 14, nights: 3, status: 'future' },
      { offset: 21, nights: 2, status: 'future' },
      { offset: 45, nights: 7, status: 'future' },
    ];

    stays.forEach((stay, index) => {
      const plan = plans[index % plans.length]!;
      const group = db.unitGroups.get(plan.unitGroupId)!;
      const guest = GUESTS[(index + property.code.charCodeAt(0)) % GUESTS.length]!;
      const arrival = addDays(businessDate, stay.offset);
      const departure = addDays(arrival, stay.nights);
      const adults = Math.min(group.maxPersons, 1 + (index % 2));
      const childrenAges = group.maxPersons >= 3 && index % 4 === 0 ? [7] : [];

      const input: CreateReservationInput = {
        arrival,
        departure,
        adults,
        childrenAges,
        channelCode: index % 3 === 0 ? 'BookingCom' : 'Direct',
        source: index % 3 === 0 ? 'Booking.com' : 'Website',
        primaryGuest: {
          firstName: guest.firstName,
          lastName: guest.lastName,
          email: guest.email,
          nationalityCountryCode: guest.countryCode,
          address: { city: 'Somewhere', countryCode: guest.countryCode },
        },
        timeSlices: nightsBetween(arrival, departure).map(() => ({ ratePlanId: plan.id })),
        services: index % 2 === 0 ? [{ serviceId: scoped(property.id, 'BRKF') }] : [],
        travelPurpose: index % 2 === 0 ? 'Leisure' : 'Business',
        marketSegmentId: index % 3 === 0 ? 'OTA' : 'DIRECT',
      };

      const q = quote(input);
      const booking: Booking = {
        id: newBookingId(),
        booker: {
          firstName: guest.firstName,
          lastName: guest.lastName,
          email: guest.email,
        },
        created: nowIso(),
        updated: nowIso(),
        reservationIds: [],
        nextReservationOrdinal: 1,
      };
      db.bookings.put(booking);

      const reservationId = nextReservationId(booking);
      const reservation = materialize(q, input, { reservationId, bookingId: booking.id }, []);
      db.reservations.put(reservation);
      booking.reservationIds.push(reservation.id);
      db.bookings.put(booking);
      ensureMainFolio(reservation);
      logReservation(reservation.id, {
        propertyId: reservation.propertyId,
        action: 'Created',
        message: `Reservation ${reservation.id} created by the seeder.`,
      });
      count += 1;

      advanceLifecycle(reservation, stay.status, businessDate);
    });
  }
  return count;
}

/** Walk a seeded reservation to the state its dates imply. */
function advanceLifecycle(
  reservation: Reservation,
  status: 'past' | 'inhouse' | 'future',
  businessDate: string,
): void {
  if (status === 'future') {
    // Assign a unit for arrivals in the next few days, as a front desk would.
    if (reservation.arrivalDate <= addDays(businessDate, 3)) {
      const free = db.units.all({ propertyId: reservation.propertyId, unitGroupId: reservation.unitGroupId })
        .find((u) => !db.reservations.all({ unitId: u.id })
          .some((r) => (r.status === 'Confirmed' || r.status === 'InHouse')
            && r.arrivalDate < reservation.departureDate && reservation.arrivalDate < r.departureDate));
      if (free) {
        assignUnit(reservation, free.id, true);
        db.reservations.put(reservation);
      }
    }
    return;
  }

  const free = db.units.all({ propertyId: reservation.propertyId, unitGroupId: reservation.unitGroupId })
    .find((u) => !db.reservations.all({ unitId: u.id })
      .some((r) => (r.status === 'Confirmed' || r.status === 'InHouse')
        && r.arrivalDate < reservation.departureDate && reservation.arrivalDate < r.departureDate));
  if (free) {
    assignUnit(reservation, free.id, true);
  }

  reservation.status = 'InHouse';
  reservation.checkInTime = `${reservation.arrivalDate}T15:20:00.000Z`;
  db.reservations.put(reservation);

  const throughDate = status === 'past' ? reservation.departureDate : businessDate;
  postThrough(reservation, throughDate);

  if (status === 'past') {
    const folio = ensureMainFolio(reservation);
    const totals = folioTotals(folio);
    if (totals.balance.amount > 0) {
      postFolioPayment(folio, {
        method: 'CreditCard',
        amount: money(totals.balance.amount, folio.currency),
        businessDate: reservation.departureDate,
      });
    }
    folio.isClosed = true;
    folio.closedAt = `${reservation.departureDate}T11:05:00.000Z`;
    folio.checkedOutOn = folio.closedAt;
    db.folios.put(folio);

    reservation.status = 'CheckedOut';
    reservation.checkOutTime = folio.closedAt;
    // Departed rooms are left dirty for housekeeping.
    if (reservation.unitId) {
      const unit = db.units.get(reservation.unitId);
      if (unit) {
        unit.condition = 'Dirty';
        db.units.put(unit);
      }
    }
    db.reservations.put(reservation);
  }
}

/** One group with a confirmed block, so the group endpoints have data. */
function createGroupAndBlock(): void {
  const property = db.properties.get('MUC');
  if (!property) return;
  const plan = db.ratePlans.all({ propertyId: property.id }).find((p) => p.code === 'FLEX-DBL');
  if (!plan) return;

  const groupId = mintGroupId((id) => db.groups.exists(id));
  const from = addDays(property.businessDate, 30);
  const to = addDays(from, 3);

  db.groups.put({
    id: groupId,
    name: 'Bauer & Klein annual conference',
    propertyIds: [property.id],
    booker: { firstName: 'Petra', lastName: 'Klein', email: 'petra.klein@example.com' },
    comment: 'Conference block, rooming list to follow.',
    created: nowIso(),
    updated: nowIso(),
    blockIds: [],
    reservationIds: [],
  });

  const blockId = mintBlockId(property.id, (id) => db.blocks.exists(id));
  const timeSlices = nightsBetween(from, to).map((date) => ({
    from: `${date}T15:00:00+02:00`,
    to: `${addDays(date, 1)}T11:00:00+02:00`,
    serviceDate: date,
    blockedUnits: 5,
    pickedUnits: 0,
    baseAmount: grossToAmount(119, 'Reduced', property.currencyCode),
    totalGrossAmount: money(119, property.currencyCode),
  }));

  db.blocks.put({
    id: blockId,
    propertyId: property.id,
    groupId,
    status: 'Definite',
    ratePlanId: plan.id,
    unitGroupId: plan.unitGroupId,
    marketSegmentId: 'CORP',
    grossDailyRate: money(119, property.currencyCode),
    from: timeSlices[0]!.from,
    to: timeSlices[timeSlices.length - 1]!.to,
    fromDate: from,
    toDate: to,
    timeSlices,
    created: nowIso(),
    updated: nowIso(),
    currency: property.currencyCode,
    isOptionalDeductingInventory: false,
  });

  const group = db.groups.get(groupId)!;
  group.blockIds.push(blockId);
  db.groups.put(group);

  // A couple of maintenance windows so housekeeping views have content.
  const units = db.units.all({ propertyId: property.id });
  if (units.length >= 2) {
    db.maintenances.put({
      id: `${property.id}-M1`,
      propertyId: property.id,
      unitId: units[units.length - 1]!.id,
      type: 'OutOfOrder',
      from: `${addDays(property.businessDate, 2)}T00:00:00Z`,
      to: `${addDays(property.businessDate, 5)}T00:00:00Z`,
      fromDate: addDays(property.businessDate, 2),
      toDate: addDays(property.businessDate, 5),
      description: 'Bathroom refurbishment',
      created: nowIso(),
    });
  }
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  const summary = seed({ reset });
  // eslint-disable-next-line no-console
  console.log('Seeded apaleo-clone:', summary);
  closeDb();
}
