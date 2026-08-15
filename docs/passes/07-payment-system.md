# Pass 7 — Payment System

Status: **Backend infrastructure complete; frontend checkout UI explicitly not built (see §7)**

Scope: new `api/src/app/modules/payment/` module, `api/src/shared/money.ts` (new),
schema changes (`Payment` model reworked, `PaymentWebhookEvent` added, `Doctor.currency`
added, three new enums), `api/src/app/modules/appointment/appointment.service.ts` (booking
flow rewired), `api/src/app.ts`, `api/src/config/index.ts`, `api/src/app/middlewares/rateLimiter.ts`,
`api/src/app/routes/index.ts`, `api/src/interfaces/index.d.ts`, `api/.env.example`.

**Markets: India (INR) via Razorpay, Kuwait (KWD) via Telr** — chosen per-doctor via a new
`Doctor.currency` field, a dual-gateway design rather than a single pan-region gateway
(that choice, and why Telr specifically for Kuwait, was discussed with the person
requesting this work before building anything).

---

## 1. What existed before this pass

Confirmed at the code level (this was Gap G6 from Pass 1, and Pass 6 documented it too):
`Appointments.paymentStatus` was set to `'paid'` **unconditionally, at booking time**,
before any gateway was ever involved. There was no `Payment.status` field at all — a
`Payment` row meant "an appointment was created," not "money was received." No gateway
integration existed anywhere in the codebase. This pass replaces that with a real
lifecycle backed by two actual gateways.

---

## 2. Schema

### 2.1 `Currency`, `PaymentProvider`, `PaymentStatus` enums (new)

`Currency` is `INR | KWD`. Both markets, one field. **KWD is a 3-decimal-place currency**
(1000 fils = 1 KWD, not 100 like INR/USD) — this matters throughout, see §3.

`PaymentStatus` implements the exact lifecycle Pass 1 specified as the target model
(§4.3 of `docs/passes/01-domain-state-model.md`): `PENDING → PROCESSING → SUCCEEDED /
FAILED / CANCELLED / EXPIRED`, plus `REFUNDED`, `PARTIALLY_REFUNDED`, and
`UNKNOWN_RECONCILING` for when a gateway's answer doesn't match what was expected (see
§5) — never silently guessed.

### 2.2 `Doctor.currency` (new, defaults to `INR`)

Determines which gateway handles bookings with that doctor. Existing doctors default to
INR since that was the implicit assumption everywhere before this pass — **any actually
Kuwait-based doctors in existing data need this set to `KWD` explicitly post-migration; a
default can't know that.**

### 2.3 `Payment` model reworked

Added: `status`, `provider`, `currency`, `providerOrderId`, `providerPaymentId`
(`@unique` — two Payment rows must never claim the same real-world gateway transaction),
`providerSignature` (audit trail), `failureReason`, `refundedAmount`. Added indexes on
`status` and `providerOrderId`.

**`DoctorFee`/`bookingFee`/`vat`/`totalAmount` changed meaning**: previously whole
currency units (e.g. `60` meaning ₹60, ambiguous since no currency field existed at all),
now minor units (paise/fils) — see §3. This is a real semantic change to existing
columns, not just additions; if there's existing production data in these columns, it
needs a data migration to multiply by the right factor per row's currency before this
schema change is applied — flagged prominently in §8.

### 2.4 `PaymentWebhookEvent` (new)

Stores every inbound webhook raw, before processing. `@@unique([provider,
providerEventId])` is the actual idempotency mechanism — a gateway retrying a
notification (both Razorpay and, per some Telr documentation found, Telr do this) hits
this constraint on retry and is safely recognized as already-processed rather than
reprocessed.

---

## 3. Money handling: `api/src/shared/money.ts`

The single most important correctness detail for a Kuwait+India system: **KWD has 3
decimal places, INR has 2.** Storing amounts as floats and assuming "2 decimals
everywhere" is a real, easy-to-make bug that would silently overcharge or undercharge
Kuwaiti patients by a factor of 10.

`toMinorUnits`/`fromMinorUnits`/`formatMinorUnitsAsDecimalString` centralize this:
everything internal (schema, both adapters' internal math) works in integer minor units;
conversion to/from human decimals happens at the two boundaries that need it — reading
`Doctor.price` (a human decimal string) at booking time, and formatting Telr's
`ivp_amount` field (which wants a decimal string, not an integer, unlike Razorpay which
takes minor units natively).

**Found and fixed while rewriting this code**: the pre-existing fee calculation computed
`totalAmount = vat + docFee`, silently **omitting `bookingFee` entirely** — a patient was
charged less than the sum of the line items actually shown. Fixed in both booking
functions (`appointment.service.ts`) alongside the minor-units conversion.

---

## 4. Provider abstraction

`payment-provider.interface.ts` defines one contract (`createOrder`, `verifyPayment`,
`verifyWebhookSignature`, `refund`); `razorpay.provider.ts` and `telr.provider.ts`
implement it; `providers/index.ts` selects by currency. `payment.service.ts` never
branches on which gateway it's talking to — a third market later means one more adapter
class, not touching the booking/payment service logic.

### 4.1 Razorpay (India)

Built against Razorpay's documented conventions, confirmed via their own docs and
multiple independent integration guides while building this:
- Orders API (`orders.create`), amount natively in paise (matches our minor-unit
  representation directly, no conversion needed).
- Checkout-callback verification: HMAC-SHA256 of `order_id|payment_id`, keyed with the
  API key secret, compared to `razorpay_signature` — **constant-time comparison**
  (`crypto.timingSafeEqual`), not `===`, to avoid a timing side-channel.
- Webhook verification: HMAC-SHA256 of the **raw** request body, keyed with a *separate*
  webhook secret, compared to the `X-Razorpay-Signature` header. `x-razorpay-event-id`
  header is the dedup key for `PaymentWebhookEvent`.
- Refunds via the official `razorpay` npm SDK (added as a new dependency — installed and
  type-checked locally against the real package; both `orders.create` and
  `payments.refund` calls compile clean against its actual shipped TypeScript types, not
  guessed).

This adapter compiles with **zero errors** against the real installed SDK — the strongest
verification possible in this sandbox (no live Razorpay account to actually call).

### 4.2 Telr (Kuwait)

Built against Telr's documented Hosted Payment Page flow: a single endpoint
(`POST https://secure.telr.com/gateway/order.json`), `ivp_`-prefixed form fields, a
`create` method returning `{ order: { ref, url } }` to redirect the browser to, and a
`check` method for server-side status verification (`order.status.code === 3` confirmed
as "Paid" across sources).

**Important limitation, flagged in the code itself, not just here**: no confirmed,
documented webhook *signature* scheme for Telr's Hosted Payment Page flow was found while
building this — their model appears to center on redirect + server-side `check`, not a
signed push webhook the way Razorpay does it. Rather than invent a plausible-sounding but
unverified signature algorithm, `TelrProviderAdapter.verifyWebhookSignature` **always
returns `valid: false`** — this is deliberate, not a bug. Telr payment confirmation in
this pass goes entirely through `verifyPayment` (the `check` call), triggered from the
`return_auth`/`return_decl`/`return_can` redirect routes, which is the confirmed-correct,
"never trust the browser" pattern regardless of whether a webhook exists. Telr's `refund`
method is similarly flagged as **unverified** — no confirmed source for its exact field
names was found; written by convention with the rest of their API but needs confirmation
against Telr's actual docs/support before relying on it.

---

## 5. Reconciliation: `UNKNOWN_RECONCILING`

Both `verifyAndFinalizePayment` (checkout-callback path) and the Razorpay webhook handler
compare the gateway-confirmed amount against the expected `Payment.totalAmount` before
marking anything `SUCCEEDED`. A mismatch — the gateway says it collected a different
amount than expected — sets `UNKNOWN_RECONCILING` instead of guessing which number to
trust. Nothing in this pass auto-resolves that state; it's surfaced for manual review by
design, per the plan's explicit "never trust the browser as proof of payment" instruction
and Pass 1's invariant that financial state changes are never silent.

---

## 6. Idempotent by construction, not by accident

- **Gateway order creation** (`createProviderOrderForPayment`) is deliberately placed
  **outside** the booking transaction (calling an external HTTP API from inside a
  `SERIALIZABLE` transaction is a well-known anti-pattern — it holds locks open across a
  network call, and a later unrelated rollback would orphan a real gateway order with no
  local record). It's made idempotent a different way: if `Payment.providerOrderId` is
  already set, it returns the existing order instead of calling the gateway again. Called
  unconditionally after every booking (fresh or an idempotency-key replay from Pass 6) —
  self-healing if a previous attempt got the appointment created but didn't finish
  creating the gateway order (process restart, network blip).
- **Webhook processing** is idempotent via the `PaymentWebhookEvent` unique constraint
  (§2.4).
- **A booking that fails to get a gateway order** is not a lost booking — the Appointment
  and a `PENDING` Payment row exist regardless; `POST /payment/:paymentId/checkout` can be
  called again later to retry, without re-running the whole booking flow.

---

## 7. What this pass deliberately did *not* build: the frontend checkout UI

This is the single biggest thing left undone, stated plainly: **the actual "redirect to
gateway, complete payment, come back" user experience was not built.** What exists is a
complete, correct backend — an appointment now gets created in a real `PENDING` payment
state, and a gateway order gets created alongside it — but nothing in
`AppointmentPage.jsx` / `DoctorBooking.jsx` yet reads `result.checkout.redirectUrl` and
sends the browser there, and nothing yet integrates Razorpay's Checkout.js widget (which,
unlike Telr, has no redirect URL — the frontend must load Razorpay's script and open an
in-page widget using `providerOrderId`).

This was a deliberate scope boundary, not an oversight:
- It's genuinely new UI work (not hardening an existing flow, the pattern every prior
  pass followed), with real UX decisions (loading states while waiting for gateway
  redirect, handling the user closing the payment tab, etc.) that deserve their own
  focused attention.
- It cannot be tested end-to-end in this sandbox regardless (no network access to either
  gateway's servers) — building untested checkout UI against untested backend
  integration compounds risk in a way that contradicts the "no drift, careful patchwork"
  approach this whole plan has followed.
- Real API credentials (Razorpay test keys, Telr test store) are needed to build this
  properly against sandbox environments, which only the account owner can provision.

**What you need to do next**, concretely:
1. Sign up for Razorpay (India) and Telr (Kuwait) test/sandbox accounts, get credentials.
2. Fill in the `RAZORPAY_*`/`TELR_*`/`BACKEND_ORIGIN*` variables added to `.env.example`.
3. Set `Doctor.currency = 'KWD'` on any doctors that should actually use Telr (defaults
   to `INR`/Razorpay otherwise).
4. Build the frontend: after `createAppointment` resolves, check
   `result.checkout?.redirectUrl` — if present (Telr), navigate the browser there; if
   `result.checkout?.provider === 'razorpay'`, load Razorpay's Checkout.js and open it
   with `result.checkout.providerOrderId`, then POST the resulting
   `razorpay_order_id`/`razorpay_payment_id`/`razorpay_signature` to
   `POST /api/v1/payment/:paymentId/verify`.
5. Point Razorpay's dashboard webhook URL at
   `${BACKEND_ORIGIN}/api/v1/payment/webhook/razorpay` and set `RAZORPAY_WEBHOOK_SECRET`
   to match what you configure there.
6. Test the full loop in both gateways' sandbox modes before going anywhere near a real
   card.

---

## 8. What you need to run before this is live

Same sandbox limitation as every prior pass — no live Postgres, no network access to
Razorpay/Telr, so none of this was executed end-to-end here.

```bash
cd api
npm install                # picks up the new razorpay dependency
npx prisma format && npx prisma validate
npx prisma migrate dev --name pass7-payment-system
```

**If there is existing production data** in `Payment.DoctorFee`/`bookingFee`/`vat`/
`totalAmount`: those columns now mean minor units, not whole currency units. Existing
rows need a one-time data migration (multiply by 100 for INR rows, 1000 for KWD rows —
but nothing was KWD before this pass, so almost certainly ×100 for all existing rows)
**before** or as part of applying this migration, or historical payment amounts will read
as 100x too small. Write and test that migration against a copy of production data, not
directly against production.

---

## 9. What this pass deliberately did not do (beyond §7)

- **No refund UI, no admin refund dashboard.** The backend endpoint
  (`POST /payment/:paymentId/refund`, admin-only) exists and calls the real gateway
  refund methods; nothing in the admin frontend calls it yet.
- **No automatic expiry of stale `PENDING`/`PROCESSING` payments.** If a patient abandons
  checkout, that Payment row sits in `PENDING` indefinitely today — no background job
  marks it `EXPIRED`. That's Pass 23's job (Background Jobs).
- **No retry/backoff for failed gateway calls** beyond what's described in §6 (manual
  retry via the checkout endpoint). Systematic retry policy is part of Pass 18 (Error
  Handling & Recovery).
- **Telr's exact status-code table beyond code 3 ("Paid")** wasn't fully confirmed from
  available sources — `verifyPayment` treats anything other than exactly `3` as "not
  succeeded" (safe default: never falsely reports success) rather than distinguishing
  Cancelled vs Declined vs Expired precisely. Refine once Telr's full code table is
  confirmed against their actual current docs.
