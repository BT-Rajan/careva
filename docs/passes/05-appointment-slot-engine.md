# Pass 5 — Appointment & Slot Engine

Status: **Complete for the non-negotiable invariant; several sub-items explicitly deferred (see §4)**

Scope: `api/src/app/modules/appointment/appointment.service.ts` only. No schema changes,
no stack change — the fix uses PostgreSQL's built-in `SERIALIZABLE` isolation level via
Prisma's existing `$transaction` API, not a new mechanism.

---

## 1. What was confirmed broken

Pass 1 flagged this as Gap G9 — "nothing in the database or application code today
prevents two appointments from being created for the same doctor at the same
date/time" — based on schema inspection. This pass confirmed it directly in the code:
`createAppointment` and `createAppointmentByUnAuthenticateUser` (the only two places in
the entire codebase that create an `Appointments` row — verified by grepping for every
`appointments.create` call site) inserted a row using whatever `scheduleDate` /
`scheduleTime` strings the client sent, with:

- **No check that the requested time was even part of the doctor's configured hours.**
  A client could submit `"03:00 am"` for a doctor who only configured 9–5.
- **No cap on how many appointments could exist for the same doctor at the same exact
  date+time.** `DoctorTimeSlot.maximumPatient` — the field that exists specifically to
  cap how many patients can be seen in a given slot — was set at schedule-creation time
  and **never read anywhere else in the codebase**. It was pure decoration.
- **No connection at all between the slot-display logic and the booking logic.**
  `getAppointmentTimeOfEachDoctor` (what the frontend calls to show "available" times)
  generates every possible 30-minute slot from the doctor's configured hours and returns
  all of them — it doesn't check existing bookings or capacity either. A fully-booked
  slot looks exactly as available as an empty one.

Net effect: this wasn't a theoretical race condition waiting to happen under load — there
was no capacity enforcement *at all*, concurrent or not. Two, five, or five hundred
patients could all book the same doctor at the same minute, sequentially or
simultaneously, and every single request would succeed.

---

## 2. The fix

### 2.1 `assertSlotAvailable`

A new function, called as the **first thing** inside the booking transaction, before any
insert:

1. Resolves the weekday from `scheduleDate` (`moment(...).format('dddd').toLowerCase()`)
   and looks up the doctor's `DoctorTimeSlot` for that weekday. No configured schedule for
   that day → reject.
2. Checks `scheduleTime` actually falls within one of that day's configured
   `[startTime, endTime)` ranges, using the same 30-minute-grid logic
   `getAppointmentTimeOfEachDoctor` already uses for display — so the validation logic and
   the display logic agree on what a "valid" time even means. Outside configured hours →
   reject.
3. Counts existing appointments for that exact `(doctorId, scheduleDate, scheduleTime)`,
   excluding cancelled ones (`status: { not: 'cancel' }` — using today's actual literal
   status string per Pass 1's audit; this pass does not touch that representation, that's
   Pass 8's job), and compares against `DoctorTimeSlot.maximumPatient` (defaulting to 1 if
   unset). At capacity → reject with a clear "fully booked, choose another time" message.

### 2.2 Making it concurrency-safe: `SERIALIZABLE` isolation + retry

A count-then-insert check inside an ordinary transaction is **not** enough on its own —
under PostgreSQL's default `READ COMMITTED` isolation, two concurrent transactions can
both read the same "count = capacity - 1" snapshot and both proceed to insert, silently
overshooting capacity. This is the textbook failure mode for exactly this kind of
capacity-limited booking problem.

Fixed by wrapping both booking transactions in `Prisma.TransactionIsolationLevel
.Serializable`. Under `SERIALIZABLE`, PostgreSQL itself detects the conflict between two
concurrent transactions racing for the same slot and aborts one of them with a
serialization failure (Postgres error `40001`, surfaced by Prisma as error code `P2034`)
— it is not possible for both to commit. `runBookingTransaction` wraps this with one
automatic retry (standard practice for serializable transactions — most conflicts are
transient and a retry succeeds cleanly once the losing transaction sees the up-to-date
count), and only surfaces a user-facing "this slot was just booked by someone else" error
if the retry also loses the race.

This is the direct implementation of the pass's own non-negotiable invariant: **two
concurrent users can never successfully book the same appointment slot** — enforced by
the database's own concurrency control, not by application-level locking that could have
its own races.

### 2.3 Applied to both booking paths

Both `createAppointment` (authenticated/known-patient booking) and
`createAppointmentByUnAuthenticateUser` (guest booking) now call
`assertSlotAvailable` before creating the appointment row, and both run under
`runBookingTransaction`. The guest path resolves `doctorId` (falling back to
`config.defaultAdminDoctor`) *before* the check, since capacity is meaningless without
knowing which doctor's slot is being checked.

---

## 3. Verification limitation

Same sandbox constraint as every prior pass: no live PostgreSQL instance here, so this
could not be exercised under actual concurrent load. The logic was verified by close
reading against Postgres's documented `SERIALIZABLE` behavior and Prisma's documented
transaction-isolation API, and by tracing every appointment-creation code path in the
repository to confirm there are exactly two, both now covered. **Before trusting this in
production**, run a real concurrency test — for example, fire N parallel requests at the
same doctor/date/time with `maximumPatient` set to a small number (e.g. 2) and confirm
exactly 2 succeed and the rest get the "fully booked" or "just booked by someone else"
error, never more than `maximumPatient` successful rows in the `Appointments` table for
that slot.

---

## 4. What this pass deliberately did *not* do

The original plan's Pass 5 scope is broad (availability calculation, slot generation,
slot **reservation**, reservation expiration, doctor holidays, timezone handling, booking
window, appointment duration). This pass focused entirely on the one item explicitly
marked non-negotiable — no double-booking — and left the rest as documented gaps rather
than guessing at product decisions or building on a data model that doesn't exist yet:

- **No "reserve then confirm" flow.** The app's current design is a single atomic
  booking request (patient info + payment info submitted together, one transaction) —
  there's no concept of "hold this slot for 5 minutes while the user enters payment
  details" today. Building that is a real UX/flow change (a slot would need a
  `PENDING_RESERVATION` state with an expiry, background cleanup for abandoned holds,
  etc.), not a database-level tweak — deferred rather than half-built.
- **No doctor holidays / one-off unavailable dates.** `DoctorTimeSlot` only models a
  recurring weekly pattern (`day: monday`, etc.) — there's no schema concept of "closed on
  Dec 25" or "on vacation March 1–15" at all. Adding this needs a new model and UI, which
  is schema/product scope beyond this pass.
- **No timezone handling.** `scheduleDate`/`scheduleTime` are naive strings with no
  timezone attached anywhere in the system, front or back. This pass's checks operate on
  those same naive strings — correct relative to the existing (timezone-unaware) design,
  but doesn't fix the underlying unawareness. A real fix means deciding a timezone
  strategy (store UTC + doctor's configured timezone, likely) across schema, API, and
  frontend simultaneously — too large and too risky to attempt as a side effect of this
  pass.
- **No explicit booking-window limit** (e.g. "can't book more than 60 days out" or "can't
  book in the past"). Considered adding a simple "reject past dates" check, but couldn't
  confirm there isn't a legitimate walk-in/backdating use case (e.g. staff logging a
  same-day walk-in patient after the fact) without a live environment to check against —
  rather than guess and risk breaking a real workflow, left this undecided and
  unimplemented.
- **Fixed appointment duration is still hardcoded** (`30` minutes, in
  `getAppointmentTimeOfEachDoctor`'s slot-slicing loop) rather than configurable per
  doctor or per visit type. Left as-is — changing it touches the same slot-generation
  code this pass deliberately didn't rewrite, to keep the change surface to exactly what
  the invariant required.
