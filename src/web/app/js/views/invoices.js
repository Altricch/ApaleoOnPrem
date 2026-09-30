import { mount, h, chip, table, input, select, field, drawer, skeleton, confirmDialog, closeOverlay } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { money, date, label, tone } from '../format.js';

/** Issued invoices, with the document itself viewable and downloadable. */

const filters = { status: '', nameSearch: '' };

export async function render({ context }) {
  const container = h('section.card');
  const body = h('div.body.flush');
  const countChip = h('span.chip', '…');

  const rerender = async () => {
    mount(body, h('div.skeleton', { style: { height: '220px', margin: '16px' } }));
    const { items, count } = await api.invoices({
      propertyIds: state.property.id,
      status: filters.status || undefined,
      nameSearch: filters.nameSearch || undefined,
    });
    countChip.textContent = `${count} invoice${count === 1 ? '' : 's'}`;
    mount(body, table([
      { label: 'Number', mono: true, render: (i) => i.number },
      { label: 'Type', render: (i) => chip(i.type, i.type === 'Cancellation' ? 'bad' : 'accent') },
      { label: 'Recipient', render: (i) => i.guestName || i.guestCompany || '—' },
      { label: 'Date', render: (i) => date(i.created) },
      { label: 'Status', render: (i) => chip(label(i.status), tone(i.status)) },
      { label: 'Total', num: true, render: (i) => money(i.subTotal) },
      {
        label: 'Outstanding',
        num: true,
        render: (i) => h('span', { style: { color: i.outstandingPayment?.amount > 0 ? 'var(--bad)' : 'var(--muted)' } },
          money(i.outstandingPayment)),
      },
    ], items, {
      onRow: (i) => openInvoice(i.id, context, rerender),
      empty: {
        title: 'No invoices yet',
        detail: 'Create one from a settled folio under Folios.',
      },
    }));
  };

  container.append(
    h('header', [h('h2', 'Invoices'), countChip]),
    h('div.toolbar', [
      field('Status', select([
        { value: '', label: 'All' },
        { value: 'Unpaid', label: 'Unpaid' },
        { value: 'FullyPaid', label: 'Paid' },
        { value: 'WrittenOff', label: 'Written off' },
      ], { value: filters.status, onchange: (e) => { filters.status = e.target.value; rerender(); } })),
      h('div.field.grow', [h('label', 'Recipient'), (() => {
        const search = input({ type: 'search', placeholder: 'Guest or company name' });
        let timer;
        search.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => { filters.nameSearch = search.value.trim(); rerender(); }, 250);
        });
        return search;
      })()]),
    ]),
    body,
  );
  await rerender();
  return container;
}

async function openInvoice(id, context, rerender) {
  const panel = drawer({ title: 'Invoice', body: [skeleton(220)] });
  const invoice = await api.invoice(id);
  const body = panel.querySelector('.body');

  panel.querySelector('header h2').textContent = invoice.number;

  mount(body, 
    h('section.card', [h('div.body', [
      h('dl.kv', [
        h('dt', 'Type'), h('dd', invoice.type),
        h('dt', 'Status'), h('dd', chip(label(invoice.status), tone(invoice.status))),
        h('dt', 'Date'), h('dd', date(invoice.invoiceDate)),
        h('dt', 'Recipient'), h('dd', [
          invoice.to?.name ?? '—',
          invoice.to?.companyName ? h('div', { style: { color: 'var(--muted)' } }, invoice.to.companyName) : null,
          invoice.to?.address?.city
            ? h('div', { style: { color: 'var(--muted)' } },
              [invoice.to.address.addressLine1, invoice.to.address.postalCode, invoice.to.address.city].filter(Boolean).join(', '))
            : null,
        ]),
        h('dt', 'Folio'), h('dd', h('span.mono', invoice.folioId)),
        invoice.relatedInvoiceNumber ? h('dt', 'Relates to') : null,
        invoice.relatedInvoiceNumber ? h('dd', h('span.mono', invoice.relatedInvoiceNumber)) : null,
      ]),
    ])]),

    invoice.stayInfo ? h('section.card', [
      h('header', [h('h2', 'Stay')]),
      h('div.body', [h('dl.kv', [
        h('dt', 'Guest'), h('dd', invoice.stayInfo.guestName),
        h('dt', 'Arrival'), h('dd', date(invoice.stayInfo.arrivalDate)),
        h('dt', 'Departure'), h('dd', date(invoice.stayInfo.departureDate)),
        invoice.stayInfo.roomNumber ? h('dt', 'Room') : null,
        invoice.stayInfo.roomNumber ? h('dd', h('span.mono', invoice.stayInfo.roomNumber)) : null,
      ])]),
    ]) : null,

    h('section.card', [
      h('header', [h('h2', 'Line items')]),
      h('div.body', [
        ...(invoice.lineItems?.lineItems ?? []).map((item) => h('div.folio-line', [
          h('div.date', date(item.date, { day: '2-digit', month: 'short' })),
          h('div', [item.description, h('div.meta', `VAT ${item.vatPercent}%${item.quantity > 1 ? ` · ×${item.quantity}` : ''}`)]),
          h('div.amt', money(item.price)),
        ])),
        h('div.folio-total', [h('span', 'Total'), h('span', money(invoice.total))]),
        ...(invoice.taxDetails ?? []).map((t) => h('div', {
          style: { fontSize: '12px', color: 'var(--muted)', display: 'flex', justifyContent: 'space-between', marginTop: '4px' },
        }, [h('span', `VAT ${t.vatPercent}%`), h('span', `net ${money(t.net)} · tax ${money(t.tax)}`)])),
        invoice.outstandingPayment?.amount
          ? h('div.folio-total', { style: { color: 'var(--bad)' } },
            [h('span', 'Outstanding'), h('span', money(invoice.outstandingPayment))])
          : null,
      ]),
    ]),
  );

  const actions = invoice.allowedActions ?? [];
  panel.append(h('footer', [
    h('a.btn', { href: `/finance/v1/invoices/${invoice.id}/pdf`, target: '_blank' }, 'Open PDF'),
    actions.includes('Cancel')
      ? h('button.btn.danger', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Cancel invoice ${invoice.number}?`,
            message: 'A cancellation document is issued that reverses this invoice. The original stays on file.',
            confirmLabel: 'Cancel invoice',
            danger: true,
          });
          if (!ok) return;
          const done = await context.attempt(
            fetch(`/finance/v1/invoice-actions/${invoice.id}/cancel`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reasonCode: 'ChangeOfInvoiceTransactions' }),
            }).then((r) => (r.ok ? true : r.json().then((p) => Promise.reject(Object.assign(new Error(), { messages: p.messages }))))),
            { success: 'Invoice cancelled', failure: 'Could not cancel the invoice' },
          );
          if (done) {
            closeOverlay();
            rerender();
          }
        },
      }, 'Cancel invoice')
      : null,
    h('div.spacer'),
    h('button.btn.ghost', { onclick: closeOverlay }, 'Close'),
  ]));
}
