# Pass 14 — Invoice & Financial Records

Status: **Complete**

Scope: `api/prisma/schema.prisma` (new `Invoice` model + `InvoiceStatus` enum), new
`api/src/app/modules/invoice/` module (`invoice-lifecycle.ts`, `.service.ts`,
`.controller.ts`, `.route.ts`), `api/src/app/routes/index.ts`, wiring into
`api/src/app/modules/appointment/appointment.service.ts` and
`api/src/app/modules/payment/payment.service.ts`, removal of three superseded
endpoints from the appointment module, and frontend: new `redux/api/invoiceApi.js`,
new `src/utils/money.js`, rewired `BookingInvoice.jsx` / `Doctor/Invoice/DoctorInvoice.jsx`
/ `Doctor/Dashboard/Dashboard.jsx` / `Doctor/Dashboard/PatientDashboard.jsx`. Schema
change: yes — this pass's whole job, per `docs/passes/01-domain-state-model.md` §4.5 /
Gap G7. No stack change.

---

## 1. A real, persisted, immutable `Invoice` entity

Before this pass, "invoice" meant a Payment row rendered on the fly by
`BookingInvoice.jsx` / `DoctorInvoice.jsx` — nothing was actually persisted as a
financial document (Gap G7). `Invoice` is now its own model: `ISSUED → PAID → VOID`,
1:1 with `Payment`, snapshotting the charge (`doctorFee`/`bookingFee`/`vat`/`totalAmount`/
`currency`) at issuance time rather than joining live against `Payment` — so a later
refund adjusting `Payment.refundedAmount` never retroactively rewrites what an
already-issued invoice says it billed.

**Generation trigger — resolved.** §4.5 left this open ("SCHEDULED or COMPLETED,
decision deferred"). Decided on **SCHEDULED**: that's the point a booking is confirmed
and the charge is final, vs. PENDING (nothing confirmed yet — the doctor hasn't
accepted) or COMPLETED (would delay billing until after the visit even though the
amount was already fixed at booking). See the extended comment on the `Invoice` model
in `schema.prisma`.

**No `DRAFT` state**, for the same reason Pass 13 didn't model Prescription's DRAFT:
generation is fully automatic and atomic (computed instantly from the appointment's
already-existing Payment at the moment of transition) — there's no partial/unfinished
state for a human to ever leave one in. Flagged as deliberate, not silent.

`generateInvoiceForAppointment` (`invoice.service.ts`) is called inside the same
transaction as every code path that can produce a PENDING→SCHEDULED transition
(`appointment.service.ts`'s `updateAppointment` and `updateAppointmentByDoctor`) — so
an appointment can never become SCHEDULED without an invoice, or vice versa. It reads
the linked Payment's *current* status rather than assuming ISSUED: if payment had
already succeeded before the appointment reached SCHEDULED (possible in principle —
nothing enforces payment-after-acceptance), the invoice is generated already-`PAID`
instead of incorrectly claiming money is still owed.

## 2. Lifecycle wiring — the invoice tracks reality, automatically

`invoice-lifecycle.ts` follows the same two-part pattern as the other state machines
in this app, but splits transitions into two enforcement paths on purpose:

- **System-only** (`assertValidInvoiceTransitionShape` — shape check only, no actor):
  `ISSUED → PAID`, fired from `payment.service.ts`'s `verifyAndFinalizePayment` and the
  Razorpay webhook success branch, inside the same transaction as the Payment being
  marked `SUCCEEDED`. Also the automatic void paths below — these are consequences of
  an already-authorized action, not a fresh request needing its own actor check.
- **Human-triggerable** (`assertValidInvoiceTransition` — shape + actor):
  `ISSUED/PAID → VOID`, admin-only, exposed at `PATCH /invoice/:id/void`, for
  correcting a mistake with no other event to hang the void off of.

Automatic voids, wired into the transactions of the actions that cause them:

- **Cancellation** (`cancelAppointment`) — any cancel/decline outcome voids the
  appointment's live invoice, if it has one (most cancellations happen from PENDING,
  before any invoice ever existed, so this is usually a no-op). Voiding does not itself
  refund money — that's the separate gateway refund call, unchanged from Pass 7,
  against the same underlying Payment either way.
- **Reschedule** (`rescheduleAppointment`) — specifically when a *patient* reschedule
  resets `SCHEDULED → PENDING`: the doctor agreed to the original slot, not
  automatically to whatever time comes next, so the invoice for that original
  commitment no longer holds. A doctor/admin reschedule keeps the current status (their
  own action already implies consent) and does not void anything.
- **Full refund** (`payment.service.ts`'s `processRefund`) — a payment reaching
  `REFUNDED` (not `PARTIALLY_REFUNDED`) voids its invoice: the money's been returned,
  so the document is no longer valid. Partial refund deliberately does **not** void —
  this app has no credit-note concept, and the invoice genuinely was paid in full at
  some point; voiding it would lose that fact. Flagged as a known simplification.

## 3. Correction — void the original, issue a new one

"Corrections create a new invoice; existing ones are never edited in place" (§4.5).
Unlike Prescription's separate `CORRECTED` status (Pass 13), Invoice's target enum has
no fourth state — `VOID` already means "not the current document for this charge," so
`correctInvoice` (admin-only, `POST /invoice/:id/correct`) is simply: void the original
(recording why), issue a fresh one with the corrected figures, link back via
`supersedesId`. `BookingInvoice.jsx` shows a banner either direction (superseded-by /
supersedes) so a stale link never silently displays an outdated charge as current.

## 4. Retired the old Payment-labeled-as-invoice endpoints

`appointment.service.ts` had three functions doing exactly what Gap G7 described:
`getPaymentInfoViaAppintmentId` (`GET /patient-payment-info/:id`), `getPatientPaymentInfo`
(`GET /patient/invoices` — confirmed unused by any frontend component even before this
pass), and `getDoctorInvoices` (`GET /doctor/invoices`). All three are removed —
function, controller, route — rather than left alongside the new real ones; the
superseding endpoints are `invoice.service.ts`'s `getInvoiceByAppointmentId` /
`getPatientInvoices` / `getDoctorInvoices`. The two that were live
(`DoctorInvoice.jsx`, `Doctor/Dashboard/Dashboard.jsx`'s revenue stat,
`BookingInvoice.jsx`) are repointed to the new endpoints in this same commit — nothing
was left broken mid-migration.

## 5. Two more display bugs found and fixed while rewiring the consuming pages

- **Raw minor-unit amounts shown as if they were whole currency.** Pass 7 switched
  `Payment` amounts to minor units (paise/fils) but its own doc flagged the frontend
  checkout UI as explicitly not built — nothing on the display side was ever updated to
  match. `BookingInvoice.jsx` was rendering `${data.totalAmount}` directly, which would
  show e.g. "$6000" for what's actually 60.00, and be off by a factor of 10 again for
  KWD's 3-decimal fils. Added `src/utils/money.js` (frontend counterpart to
  `api/src/shared/money.ts`) and used it everywhere an amount is displayed
  (`BookingInvoice.jsx`, `DoctorInvoice.jsx`, both `Dashboard.jsx` revenue/spend stats,
  `PatientDashboard.jsx`'s invoice table).
- **`PatientDashboard.jsx`'s invoice table columns silently broken.** Two columns
  ('Doctor', 'Paid On') had no `dataIndex` and used `render: function(data)` treating
  `data` as the row record — but antd's `render` signature is `(value, record, index)`,
  and with no `dataIndex` set, `value` is `undefined`. Same bug class as the
  `isArchived` column fixed in Pass 13's doc. Both columns had been silently rendering
  blank/invalid output for every row. Fixed alongside the field-shape update these
  columns needed anyway (Payment → Invoice).

## 6. What this pass deliberately did not do

- **No soft-delete on `Invoice`.** Every other soft-deletable model in this schema has
  a `deletedAt`; Invoice doesn't. `VOID` already is the "does not count" state for a
  financial document — there is no additional "and also hidden" state one needs beyond
  that. Documented on the model itself.
- **No credit-note concept.** A partial refund does not touch the invoice at all (see
  §2) — full accounting systems would issue a credit note for the difference; that's a
  larger feature this pass doesn't build.
