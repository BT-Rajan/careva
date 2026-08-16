# Pass 9 — Cancellation & Rescheduling

Status: **Backend complete (cancellation + rescheduling); patient/doctor/admin cancellation UI built; rescheduling UI deferred (see §6)**

Scope: `api/src/config/index.ts` (policy config), `api/src/app/modules/appointment/appointment-state-machine.ts`
(one new edge), `api/src/app/modules/appointment/appointment.service.ts` (two new
functions + a guard on the existing update path), `api/src/app/modules/appointment/appointment.{controller,route}.ts`,
`api/src/app/modules/payment/payment.service.ts` (refund logic split), `api/.env.example`,
and five frontend files. No schema changes, no stack change.

---

## 1. What existed before this pass

Pass 8 built the state machine and the actor-authorization rules for every transition,
including the three `CANCELLED_BY_*` states — but nothing enforced *when* a cancellation
was reasonable, nothing calculated a refund, and there was **no patient-facing
cancellation UI anywhere in the product** (confirmed by checking
`src/components/Patient` — doesn't exist — and `src/components/TrackAppointment` before
starting). Doctor and admin could already cancel via Pass 8's UI, but doing so never
touched the `Payment` record at all — a doctor cancelling a fully-paid appointment left
the money exactly where it was, with no eligibility calculation, no refund attempt, no
record of what should have happened.

---

## 2. Cancellation: cutoff, refund eligibility, and calculation

`config.cancellation` (new, `api/src/config/index.ts`) — **stated plainly: these are
reasonable defaults, not a researched business policy.** Confirm/adjust with whoever owns
pricing decisions; they're env-var overridable specifically so that doesn't require a
code change:

- `cutoffHours` (default 24) — cancelling this many hours or more before the scheduled
  time is "on-time."
- `onTimeRefundPercent` (default 100) — refund percentage for an on-time cancellation.
- `lateRefundPercent` (default 50) — refund percentage for a late one.

`cancelAppointment` (new, `appointment.service.ts`) computes this only when there's
something to refund — a `Payment` row in `SUCCEEDED` status. It parses
`scheduleDate`+`scheduleTime` into a real moment, computes hours-until-appointment, and
applies the appropriate percentage to `Payment.totalAmount` (already in minor units per
Pass 7, so the refund amount is too). **Unparseable date/time data is treated as "late"**
— the safer default (never over-refund on a data-quality problem) rather than throwing,
since a cancellation request should never be blocked by an unrelated field being malformed.

The refund plan is written to `AuditLog` **regardless of whether the actual gateway
refund call succeeds** — so there's always a durable record of what should have
happened, distinct from what did. The gateway call itself happens after the transaction
commits (same anti-pattern-avoidance as Pass 7's `createProviderOrderForPayment` — no
external HTTP calls inside a database transaction), and a failed refund does **not** fail
the cancellation — the appointment is validly cancelled either way; a failed refund
becomes a billing follow-up, not a reason to trap the user in limbo.

---

## 3. Who can cancel what, and the "one Cancel button" design

Pass 8's graph only had `SCHEDULED → CANCELLED_BY_PATIENT` for patients. This pass adds
`PENDING → CANCELLED_BY_PATIENT` — a patient withdrawing a request the doctor hasn't
responded to yet is a different thing from `DECLINED` (which specifically means the
doctor rejected it), even though both leave the request equally dead.

`CANCEL_TARGET_BY_ROLE` (new) resolves the *exact* target enum value from just
`(actorRole, currentStatus)`, so every frontend "Cancel" button can call one endpoint
without needing to know or compute which of `DECLINED`/`CANCELLED_BY_PATIENT`/
`CANCELLED_BY_DOCTOR`/`CANCELLED_BY_ADMIN` applies — the backend figures it out, then
still runs it through `assertValidAppointmentTransition` as a belt-and-suspenders check
(the same source of truth every other transition in the app goes through).

### Architectural guarantee: cancel-type transitions can't skip refund logic

`updateAppointment` and `updateAppointmentByDoctor` now **explicitly reject** any request
to set status to `DECLINED`/`CANCELLED_BY_*` — with a clear error pointing at
`POST /:id/cancel` instead. This wasn't strictly required (I could have just updated
every frontend call site to use the new endpoint and called it done) but it closes the
gap architecturally: even if a future frontend change reintroduces a call to the generic
endpoint for a cancel-shaped status, the backend won't silently skip refund
eligibility — it'll fail loudly and obviously in testing, not silently in production.

All frontend call sites that could previously trigger a cancel-type status — doctor's
Appointments page, doctor's Dashboard quick actions, admin's per-row status dropdown —
were updated to call the new dedicated endpoint instead. Verified via grep that no
remaining call site sends a cancel-type status to the generic update endpoint.

---

## 4. Slot release

No new code needed — confirmed, not assumed. `assertSlotAvailable` (Pass 5, extended in
Pass 8 to the enum) already excludes every cancel/decline-shaped status when counting a
slot's capacity. The moment a cancellation transaction commits, the slot is free for a
new booking. This pass just confirms and documents that property rather than duplicating it.

---

## 5. Rescheduling

`rescheduleAppointment` (new) — only `PENDING` or `SCHEDULED` appointments can be
rescheduled. Reuses `assertSlotAvailable` and the `SERIALIZABLE`-isolation
`runBookingTransaction` wrapper from Pass 5/6 for the **new** slot — "rescheduling
conflicts" is the same problem booking-time slot conflicts are, just checked against an
existing row's update instead of a fresh insert, so the same concurrency-safety guarantee
applies without new machinery.

**Policy decision, stated explicitly**: a *patient* rescheduling an already-`SCHEDULED`
appointment resets it to `PENDING`, requiring the doctor to re-confirm the new time — the
doctor agreed to the *original* slot, not automatically to whatever the patient picks
next. A doctor or admin rescheduling keeps the current status, since their own action
already implies consent. This is a reasonable default, not something confirmed with a
product owner — flag if a different policy is wanted.

No cutoff/refund logic applies to rescheduling — deliberately not extended from
cancellation, since "reschedule cutoff" would be inventing a second undiscussed policy
dimension. If wanted, it's a small addition once the cancellation cutoff numbers are
confirmed as correct in the first place.

---

## 6. Frontend

**Built:**
- **Patient cancellation** (`PatientDashboard.jsx`) — the first patient-facing
  cancellation UI in the product. A Cancel button on `PENDING`/`SCHEDULED` rows, calling
  the new endpoint.
- **Doctor and admin cancel flows** rewired to the dedicated endpoint (§3).
- Reason capture uses `window.prompt` throughout, not a designed modal — a deliberate,
  pragmatic choice for an engineering-hardening pass focused on correctness over visual
  polish. Functional, not pretty; revisit if/when there's a dedicated UI pass.

**Deliberately not built: a rescheduling UI.** The backend capability is complete and
correct. Building the frontend properly means either reusing the existing slot-picker
component from the booking flow (`SelectApppointment.jsx` / `getAppointmentTimeOfEachDoctor`)
— real integration work, or falling back to raw date/time text prompts, which risks
shipping something actively confusing (a patient typing a free-text time string that
doesn't match the expected format gets a confusing rejection, no capacity feedback,
no visible list of open slots). Given the amount of work already in this pass and that a
bad reschedule UI could be worse than none, this was deliberately left as a documented
gap rather than rushed — same reasoning Pass 7 applied to the payment checkout UI. The
API is ready (`POST /appointment/:id/reschedule`, body
`{ scheduleDate, scheduleTime, reason }`) whenever this gets built.

---

## 7. What you need to run before this is live

No schema changes this pass — nothing to migrate. Fill in the three
`CANCELLATION_*` env vars in `.env.example` if the defaults aren't right for the
business (see §2), and confirm the refund percentages with whoever owns pricing.

---

## 8. What this pass deliberately did not do

- **No rescheduling UI** — see §6.
- **No reschedule cutoff/refund policy** — see §5.
- **No automatic `EXPIRED` handling** — still Pass 23's job (unchanged from Pass 8).
- **No notification beyond a best-effort email**, reusing Pass 6/7's exact pattern
  (non-blocking, `.catch()`-guarded, same template). A real notification system —
  multi-channel, retries, delivery tracking — is still Pass 16's job; this pass's email is
  the same minimal, "better than nothing" precedent every prior pass has followed, not an
  attempt to build that system early.
