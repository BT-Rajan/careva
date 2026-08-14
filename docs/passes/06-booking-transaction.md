# Pass 6 — Booking Transaction

Status: **Complete for idempotency + the failure mode found while implementing it; several sub-items already covered by Pass 5 or explicitly deferred (see §5)**

Scope: `api/src/app/modules/appointment/appointment.service.ts` (idempotency +
email-failure fix), `api/src/app/modules/appointment/appointment.controller.ts` (header
plumbing), `src/redux/api/appointmentApi.js`, `src/components/Appointment/AppointmentPage.jsx`,
`src/components/Booking/DoctorBooking/DoctorBooking.jsx` (frontend key generation +
header). No schema changes — reuses the `IdempotencyKey` table Pass 2 already added. No
stack change.

---

## 1. Idempotency for the booking transaction

The original plan explicitly calls out "use idempotency where appropriate" as part of
*this* pass, scoped to the booking transaction specifically — separate from Pass 20
(Concurrency & Idempotency), which stress-tests this pattern and extends it to other
operations (webhooks, refunds, cancellations, appointment transitions). This corrects a
framing note in `docs/passes/02-database-integrity.md`, which said the `IdempotencyKey`
table would be "consumed starting in Pass 20" — on closer reading of the original plan,
booking is where it's first used; Pass 20 is where it's verified under load and rolled
out further.

**The problem:** a double-click on "Confirm booking," or a client retrying after a
network timeout without knowing whether the first request landed, had no protection at
all before this pass. Each identical submission created a brand new appointment *and* a
brand new payment record — Pass 5's `SERIALIZABLE` isolation makes concurrent *different*
bookings safe against each other, but does nothing to stop the *same* logical attempt
from succeeding twice.

**The fix:**

- The client generates a UUID once per booking attempt (`AppointmentPage.jsx`,
  `DoctorBooking.jsx` — via `useRef`, so it survives re-renders and repeated clicks of the
  same attempt) and sends it as an `Idempotency-Key` header.
- Both the lookup and the record-keeping happen **inside the same booking transaction**
  as the appointment/payment insert — `getIdempotentReplay` checks for an existing
  completed record first; if found, its cached response is returned immediately and no
  new appointment is created. `recordIdempotentResponse` writes the cache entry right
  before the transaction returns, so it can only ever commit together with the
  appointment it describes.
- Because both the check and the write live in the same transaction, there's no separate
  "claim" step and no window where an orphaned in-progress marker could exist: either the
  whole thing (idempotency row + appointment + payment) commits together, or none of it
  does.
- Two genuinely concurrent submissions with the *same* key racing each other hit the same
  `SERIALIZABLE` conflict-detection Pass 5 already wired up (both attempt to insert the
  same `IdempotencyKey` row) — Postgres aborts one, `runBookingTransaction`'s existing
  retry-once logic re-runs it, and on retry it finds the winner's now-committed row and
  replays that response instead of creating a second appointment.
- Absent header = no idempotency protection for that request, same as before this pass.
  This is additive, not a breaking requirement — any client that doesn't send the header
  behaves exactly as it did previously.
- Response caching is Date-safe: the cached `response` is round-tripped through
  `JSON.stringify`/`JSON.parse` before being written to the `Json` column, since Prisma's
  `Json` type doesn't accept raw `Date` objects directly (the appointment response
  includes `createdAt`/`updatedAt` and the included doctor/patient records' timestamps).

Applied to both `createAppointment` (known/authenticated patient) and
`createAppointmentByUnAuthenticateUser` (guest booking) — confirmed via grep that these
are the only two appointment-creation code paths in the repository (same check already
done in Pass 5).

**Frontend note:** `createAppointmentByUnauthenticateUser`'s RTK mutation was updated to
the same `{ data, idempotencyKey }` argument shape for consistency with the backend
capability, even though it's confirmed unused by any current frontend component (verified
by grep — nothing calls `useCreateAppointmentByUnauthenticateUserMutation` anywhere in
`src/`; every real booking, guest or not, currently goes through the single
`createAppointment` endpoint, which already handles a missing `patientId` gracefully).
Flagging this explicitly since it's a call-signature change to an exported hook that
happens to have no current callers — if there's an integration outside this repo that
calls it directly, that caller needs updating too.

---

## 2. Found while implementing this: an email failure could crash the whole API

`EmailtTransporter` (confirmation emails) is an `async` function, called without `await`
inside the booking transaction — deliberately, so a slow email provider can't block or
fail a successful booking. But an un-awaited async call that throws becomes an
**unhandled promise rejection**, and Node 20+ (the version this project requires —
`api/package.json` engines field) **terminates the process by default** on unhandled
rejections. That means a single failed confirmation email — a bad SMTP config, a
transient Gmail outage, anything — could previously have crashed the entire API process,
taking down every other in-flight request with it, not just the one booking whose email
failed.

Fixed with `.catch(err => console.error(...))` on both call sites (authenticated and
guest booking). This makes "email is best-effort, never blocks or crashes booking" an
explicit, deliberate behavior instead of an accidental crash risk. Real retry/delivery-
tracking for notifications is Pass 16's job — this only stops a failure from being able
to take the server down.

---

## 3. Confirmed already correct (Pass 5's work extends here for free)

Checked these against the plan's list of booking-transaction failure modes; all already
hold, and didn't need new code:

- **Payment success + appointment failure** — can't happen. `Payment` and `Appointments`
  rows are created inside the exact same transaction; they commit or roll back together.
  There is currently no *real* payment gateway in the loop (Pass 7's job — today
  `paymentStatus` is set to `paid` unconditionally, per Pass 1's audit), so this atomicity
  guarantee is about the *record-keeping* being consistent, not yet about a real external
  payment provider's success/failure being reconciled with it.
- **Backend crash mid-transaction** — Postgres transactions are crash-safe by construction
  (ACID); a crash mid-transaction means the transaction never committed, full stop. No
  application-level recovery logic was needed.
- **Duplicate tracking-ID generation under concurrent load** — both booking functions
  compute the next `trackingId` by reading the most recently created appointment and
  incrementing. Under plain `READ COMMITTED` this would be a real race (two concurrent
  bookings for *different*, unrelated doctors could compute the same ID and one would
  fail on the `trackingId` unique constraint). Pass 5's `SERIALIZABLE` isolation already
  closes this too — both transactions have a read dependency on "the most recent
  appointment row" that the other's write invalidates, which is exactly the write-skew
  pattern Postgres's serializable snapshot isolation is built to catch. Verified this is
  genuine coverage, not a coincidence, by tracing the actual read/write pattern — not
  re-implemented, since it was already correctly covered.

---

## 4. Confirmed already in place (not added by this pass)

- **UI-level double-click prevention.** Both booking forms (`AppointmentPage.jsx`,
  `DoctorBooking.jsx`) already disable their submit button via Ant Design's `loading`
  prop while the mutation is in flight. This reduces but doesn't eliminate double-submit
  risk (it doesn't cover a network-timeout-then-retry, or a user hitting back/forward and
  resubmitting a cached form) — which is exactly the gap the idempotency key in §1 closes.
  Noted here so it's clear the UI guard was already there; §1 is the complementary,
  request-level layer.

---

## 5. What this pass deliberately did *not* do

- **No real payment processing.** "Process payment" in the plan's booking-transaction
  flow is still a placeholder — `paymentStatus` is set to `paid` unconditionally at
  creation, same as documented in Pass 1. That's explicitly Pass 7's job (Payment System).
- **No invoice generation as a persisted record.** Same as Pass 1's Gap G7 — there's still
  no `Invoice` entity; what the frontend calls an "invoice" is rendered client-side from
  `Appointment` + `Payment` data. Pass 14's job.
- **No slot "reservation" step separate from the final booking.** Documented already in
  Pass 5 §4 — the app's flow is single-step atomic booking, not reserve-then-confirm.
  Repeating the note here since the plan's step list for this pass
  ("choose slot → **reserve slot** → enter patient details → ... → confirm appointment")
  implies a multi-step flow that doesn't exist in the current design. Not built in this
  pass either, for the same reasons given in Pass 5.
- **No broader idempotency rollout** (webhooks, refunds, cancellations, appointment
  transitions) — that's explicitly Pass 20's scope, once those operations exist in a form
  that needs it (webhooks/refunds don't exist yet at all — Pass 7; cancellation flows
  don't exist yet — Pass 9).
- **Did not fix the same fire-and-forget-email pattern elsewhere in the codebase**
  (`auth.service.ts`'s verification/reset emails, `doctor.service.ts`'s verification
  email). Same underlying risk, confirmed present, but out of this pass's scope (booking
  transaction specifically) — worth a follow-up, either as part of Pass 16 (Notifications)
  or a small standalone fix, since the crash risk isn't unique to booking.

---

## 6. Verification limitation

Same as every prior pass: no live PostgreSQL instance in this sandbox, so the
idempotency-replay behavior and the interaction with Pass 5's `SERIALIZABLE` retry logic
could not be exercised end-to-end here. Verified by close reading of both the new code
and Prisma's/Postgres's documented transaction semantics. Recommended test before
trusting this in production: fire the same booking request twice with an identical
`Idempotency-Key` header (simulating a double-click) and confirm exactly one `Appointments`
row and one `Payment` row exist afterward, with both responses identical.
