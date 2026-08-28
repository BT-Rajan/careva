# Pass 20 — Concurrency & Idempotency

Status: **Complete**

Scope: `api/src/app/modules/payment/payment.service.ts`,
`api/src/app/modules/payment/payment.controller.ts`. No schema change (reuses the
`IdempotencyKey` table Pass 2 laid down and `PaymentStatus.UNKNOWN_RECONCILING`, added
in Pass 7). No stack change.

---

## 1. Webhook duplicate-delivery race (real bug, now fixed)

`handleWebhook`'s idempotency check was a classic time-of-check-to-time-of-use race:
`findUnique` (check) and `create` (act) were two separate, non-atomic calls. Payment
gateways routinely deliver the same webhook event twice in close succession — that's
the entire reason `PaymentWebhookEvent`'s unique constraint on `(provider,
providerEventId)` exists — and two near-simultaneous deliveries could both pass the
`findUnique` check before either had actually inserted its row. The loser then hit the
unique constraint on `create` itself, which propagated as an uncaught
`PrismaClientKnownRequestError` instead of the graceful `{ status: 'already_processed'
}` this function is supposed to return for exactly this situation. A gateway receiving
a non-2xx response for what should have been a successful duplicate acknowledgment
would very likely just retry again — potentially indefinitely.

Fixed by wrapping the `create` in a try/catch and treating a `P2002` (unique
constraint) specifically as the success case it actually is: `already_processed`.

## 2. Refund double-processing — two distinct races, both closed

`processRefund`/`refundPayment` had no concurrency protection of any kind around a flow
that makes a real, irreversible external call (the gateway refund) and then updates
local bookkeeping based on a value read *before* that slow call. Two different races
were possible here, and needed two different fixes:

**Race A — the same logical request, retried.** A client (the admin dashboard) that
times out waiting for a response and retries, or an admin who impatiently double-clicks
"Refund," had no way to signal "this is the same attempt, not a new one" — each
identical submission would call the gateway again, refunding the money twice.

*Fix:* an `Idempotency-Key` header (same convention Pass 6 established for booking),
now accepted on `POST /:paymentId/refund` and threaded through to
`claimIdempotencyKey`/`finalizeIdempotencyKey`/`releaseIdempotencyKeyOnFailure` —
new functions in `payment.service.ts` reusing the exact `IdempotencyKey` table Pass 2
built for this. Booking's version of this pattern does the claim and the record-keeping
inside one DB transaction because nothing external happens in between; refunds can't do
that (holding a transaction open across a slow HTTP call to a payment gateway is the
same anti-pattern Pass 7 already avoided for the initial charge), so this version claims
via a bare `create` *before* the gateway call (the unique constraint on `key` is what
actually closes the race — two requests with the same key can only have one winner),
calls the gateway, then fills in the stored response afterward. A retry with the same
key that arrives after success replays the stored response without ever touching the
gateway again; one that arrives after failure finds the claim row deleted (so it's
retryable, not permanently stuck) and proceeds fresh; one that arrives *while the first
is still in flight* gets a clean `409` — it's not far enough along to have a response to
replay, and letting it through would risk a second real gateway call.

**Race B — two genuinely different refund requests for the same payment.** Two admins
(or the policy-driven cancellation path and a manual admin refund) both reading the same
`payment.refundedAmount` before either has written back, both independently deciding
their refund fits within the remaining balance, both calling the gateway, and then
racing to write `refundedAmount` — the loser's write would silently overwrite the
winner's, corrupting the record of how much was actually refunded. An `Idempotency-Key`
does nothing for this case (it's not a duplicate of the same request).

*Fix:* the final bookkeeping write changed from an unconditional `update` to an
optimistic-concurrency `updateMany` — the `WHERE` clause requires `refundedAmount` and
`status` to still match exactly what was read before the gateway call. If 0 rows match,
someone else's refund committed in between. Critically, by that point **the gateway
call has already succeeded** — the money genuinely moved, so silently discarding or
blindly retrying would be worse than the race itself. This is exactly the situation
`PaymentStatus.UNKNOWN_RECONCILING` (added in Pass 7, previously never actually
triggered by any code path) exists for: the payment is flagged for manual
reconciliation with a clear `failureReason`, and the caller gets a `409` explicitly
telling them not to retry — the fact that real money moved is never silently lost.

## 3. Existing SERIALIZABLE booking-retry logic — reviewed, no defect found

The domain doc calls this pass out to "stress-test" `runBookingTransaction`'s existing
retry pattern (Pass 5/6). No live database exists in this sandbox to run genuine
concurrent load against (same limitation every prior pass touching this area has
noted), so this was a close code review instead: confirmed the retried transaction
callback is the same closure re-invoked fresh inside a brand-new `$transaction` call —
no stale state is reused across the retry — and that the idempotency-key check inside
it re-runs on every attempt, including the retry. No defect found; Pass 5/6's
implementation holds up. **Still recommend an actual concurrent-load test** (fire N
parallel requests at the same slot) before trusting this under real production traffic,
per Pass 5's own original recommendation.

## 4. What this pass deliberately did not do

- **No compare-and-swap / optimistic locking added to every other lifecycle
  transition in the app** (doctor approval, prescription correction, invoice
  void/correct, appointment status changes). Audited and found lower-risk than the
  payment/refund path specifically because none of them make an irreversible external
  call in between reading and writing — the practical likelihood and consequence of two
  admins clicking "approve" on the same doctor in the same millisecond is negligible
  next to a refund being charged twice at a real payment gateway. Adding the same
  pattern everywhere would be a large, low-value expansion given that risk profile;
  scoped this pass to the two places where a race has real financial consequences.
- **No distributed lock / Redis-based mutex.** Postgres's own unique constraints
  (idempotency claim, webhook dedup) and optimistic concurrency (`updateMany` with a
  matching `WHERE`) are sufficient for a single-database deployment and don't add new
  infrastructure this app doesn't otherwise need.
- **Did not build a reconciliation admin tool/endpoint for `UNKNOWN_RECONCILING`
  payments.** A comment in the schema already pointed to a `reconcilePayment` function
  that was never actually built — surfacing and resolving these flagged payments is
  real, valuable future work, but is an admin-tooling feature (naturally Pass 21's
  territory), not a concurrency fix in itself.
