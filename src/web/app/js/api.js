/**
 * Client for the apaleo clone API.
 *
 * Every call goes through `request`, which attaches the bearer token, turns
 * the API's `{ messages: [...] }` errors into thrown `ApiError`s, and maps
 * `204 No Content` to an empty envelope so callers can treat "no results"
 * and "some results" the same way.
 */

const TOKEN_KEY = 'apaleo-clone.token';

export class ApiError extends Error {
  constructor(status, messages, url) {
    super(messages[0] ?? `Request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.messages = messages;
    this.url = url;
  }
}

export const session = {
  get token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private browsing: stay signed in for this page load only */
    }
  },
  clear() {
    this.token = null;
  },
};

async function request(method, path, { body, query } = {}) {
  const url = path + (query ? toQuery(query) : '');
  const headers = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return { __empty: true };

  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    throw new ApiError(res.status, errorMessages(payload, res), url);
  }
  return payload;
}

/** Pull human-readable messages out of whatever the server returned. */
function errorMessages(payload, res) {
  if (Array.isArray(payload?.messages) && payload.messages.length) return payload.messages;
  const single = payload?.error_description
    ?? payload?.error
    ?? (typeof payload === 'string' && payload.trim() ? payload.trim() : null);
  return [single ?? `${res.status} ${res.statusText}`];
}

/** Build a query string, expanding arrays into repeated parameters. */
function toQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null && item !== '') search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const get = (path, query) => request('GET', path, { query });
const post = (path, body, query) => request('POST', path, { body, query });
const put = (path, body, query) => request('PUT', path, { body, query });
const patch = (path, body, query) => request('PATCH', path, { body, query });
const del = (path, query) => request('DELETE', path, { query });

/** A list envelope that came back as 204 has no items. */
const list = async (promise, key) => {
  const payload = await promise;
  return { items: payload?.[key] ?? [], count: payload?.count ?? 0 };
};

export const api = {
  /* ---------------------------------------------------------- identity */

  async signIn(clientId, clientSecret) {
    const res = await fetch('/connect/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const payload = await res.json();
    if (!res.ok) throw new ApiError(res.status, [payload.error_description ?? payload.error ?? 'Sign-in failed'], '/connect/token');
    session.token = payload.access_token;
    return payload;
  },

  health: () => fetch('/health').then((r) => r.json()),

  /* --------------------------------------------------------- inventory */

  properties: (query) => list(get('/inventory/v1/properties', { pageSize: 500, ...query }), 'properties'),
  property: (id) => get(`/inventory/v1/properties/${id}`),
  unitGroups: (propertyId) => list(get('/inventory/v1/unit-groups', { propertyId, pageSize: 500 }), 'unitGroups'),
  units: (query) => list(get('/inventory/v1/units', { pageSize: 500, ...query }), 'units'),
  unit: (id) => get(`/inventory/v1/units/${id}`),

  /* -------------------------------------------------------- rate plans */

  ratePlans: (propertyId) => list(get('/rateplan/v1/rate-plans', { propertyId, pageSize: 500 }), 'ratePlans'),
  ratePlan: (id) => get(`/rateplan/v1/rate-plans/${id}`),
  rates: (ratePlanId, from, to) => list(get(`/rateplan/v1/rate-plans/${ratePlanId}/rates`, { from, to, pageSize: 500 }), 'rates'),
  patchRates: (ratePlanIds, from, to, operations, weekDays) =>
    patch('/rateplan/v1/rates', operations, { ratePlanIds, from, to, weekDays }),
  services: (propertyId) => list(get('/rateplan/v1/services', { propertyId, pageSize: 500 }), 'services'),
  cancellationPolicies: (propertyId) => list(get('/rateplan/v1/cancellation-policies', { propertyId }), 'cancellationPolicies'),

  /* ----------------------------------------------------------- booking */

  offers: (query) => get('/booking/v1/offers', query),
  serviceOffers: (query) => get('/booking/v1/service-offers', query),
  createBooking: (body) => post('/booking/v1/bookings', body),
  booking: (id) => get(`/booking/v1/bookings/${id}`),
  reservations: (query) => list(get('/booking/v1/reservations', { pageSize: 200, ...query }), 'reservations'),
  reservation: (id) => get(`/booking/v1/reservations/${id}`, { expand: ['actions'] }),
  reservationAction: (id, action, query) => put(`/booking/v1/reservation-actions/${id}/${action}`, undefined, query),
  assignSpecificUnit: (id, unitId) => put(`/booking/v1/reservation-actions/${id}/assign-unit/${unitId}`),
  bookService: (id, body) => put(`/booking/v1/reservation-actions/${id}/book-service`, body),
  removeService: (id, serviceId) => del(`/booking/v1/reservations/${id}/services`, { serviceId }),
  amendReservation: (id, body) => put(`/booking/v1/reservation-actions/${id}/amend`, body),
  patchReservation: (id, operations) => patch(`/booking/v1/reservations/${id}`, operations),
  blocks: (query) => list(get('/booking/v1/blocks', { pageSize: 200, expand: ['timeSlices'], ...query }), 'blocks'),
  groups: (query) => list(get('/booking/v1/groups', { pageSize: 200, ...query }), 'groups'),

  /* ------------------------------------------------------ availability */

  availability: (propertyId, from, to, query) =>
    list(get('/availability/v1/unit-groups', { propertyId, from, to, pageSize: 500, ...query }), 'timeSlices'),
  availableUnitsForReservation: (id, query) =>
    list(get(`/availability/v1/reservations/${id}/units`, { pageSize: 500, ...query }), 'units'),
  setOverbooking: (unitGroupId, from, to, value) =>
    patch(`/availability/v1/unit-groups/${unitGroupId}`,
      [{ op: 'replace', path: '/allowedOverbookingCount', value }],
      { from, to, timeSliceTemplate: 'OverNight' }),

  /* ----------------------------------------------------------- finance */

  folios: (query) => list(get('/finance/v1/folios', { pageSize: 200, ...query }), 'folios'),
  folio: (id) => get(`/finance/v1/folios/${id}`),
  postCharge: (folioId, body) => post(`/finance/v1/folio-actions/${folioId}/charges`, body),
  postPayment: (folioId, body) => post(`/finance/v1/folios/${folioId}/payments`, body),
  postAllowance: (folioId, chargeId, body) =>
    post(`/finance/v1/folio-actions/${folioId}/charges/${chargeId}/allowances`, body),
  closeFolio: (folioId) => put(`/finance/v1/folio-actions/${folioId}/close`),
  reopenFolio: (folioId) => put(`/finance/v1/folio-actions/${folioId}/reopen`),
  invoicePreview: (folioId) => get('/finance/v1/invoices/preview', { folioId }),
  createInvoice: (folioId, languageCode = 'en') => post('/finance/v1/invoices', { folioId, languageCode }),
  invoices: (query) => list(get('/finance/v1/invoices', { pageSize: 200, ...query }), 'invoices'),
  invoice: (id) => get(`/finance/v1/invoices/${id}`),
  accountsAggregate: (propertyId, from, to) => post('/finance/v1/accounts/aggregate', undefined, { propertyId, from, to }),
  serviceTypes: () => get('/finance/v1/types/service-types'),
  paymentMethods: () => get('/finance/v1/types/payment-methods'),
  vatTypes: (countryCode) => get('/finance/v1/types/vat', { countryCode }),

  /* -------------------------------------------------------- operations */

  maintenances: (query) => list(get('/operations/v1/maintenances', { pageSize: 200, ...query }), 'maintenances'),
  createMaintenance: (body) => post('/operations/v1/maintenances', body),
  deleteMaintenance: (id) => del(`/operations/v1/maintenances/${id}`),
  setUnitConditions: (unitsConditions) => put('/operations/v1/units-condition', { unitsConditions }),
  nightAudit: (propertyId, setReservationsToNoShow = true) =>
    put('/operations/v1/night-audit', undefined, { propertyId, setReservationsToNoShow }),

  /* ------------------------------------------------------------- logs */

  reservationLogs: (reservationId) =>
    list(get('/logs/v1/booking/reservation', { reservationIds: reservationId, pageSize: 100 }), 'logEntries'),
  folioLogs: (folioId) => list(get('/logs/v1/finance/folio', { folioIds: folioId, pageSize: 100 }), 'logEntries'),
  nightAuditLogs: (propertyId) =>
    list(get('/logs/v1/finance/night-audit', { propertyIds: propertyId, pageSize: 30 }), 'logEntries'),

  /* ---------------------------------------------------------- reports */

  performance: (propertyId, from, to, query) =>
    get('/reports/v1/reports/property-performance', { propertyId, from, to, ...query }),
  revenues: (propertyId, from, to) => get('/reports/v1/reports/revenues', { propertyId, from, to }),
  arrivalsReport: (propertyId, month, year) => get('/reports/v1/reports/arrivals', { propertyId, month, year }),

  /* -------------------------------------------------------- settings */

  cityTaxes: (propertyId) => list(get('/settings/v1/city-tax', { propertyId }), 'cityTaxes'),
  marketSegments: (propertyIds) => list(get('/settings/v1/market-segments', { propertyIds, pageSize: 500 }), 'marketSegments'),
  account: () => get('/account/v1/accounts/current'),
};
