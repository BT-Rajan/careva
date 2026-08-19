# Pass 11 — Doctor Schedule Engine

Status: **Complete for the critical wiring fix and the backend engine; timezone still deferred (see §7)**

Scope: `api/prisma/schema.prisma` (new model), `api/src/app/modules/doctorTimeSlot/*`,
`api/src/app/modules/appointment/appointment.service.ts` (blocked-date check),
`src/redux/api/timeSlotApi.js`, `src/components/Appointment/SelectApppointment.jsx`
(full rewrite), `src/components/Doctor/Schedule/Schedule.jsx`. No stack change.

---

## 1. The critical finding: the main booking flow doesn't use the schedule engine at all

Everything else in this pass would have been invisible to real patients without this
fix, so it's listed first even though it wasn't originally what "Doctor Schedule Engine"
suggested going in.

`SelectApppointment.jsx` — the time-picker step of the **primary, self-service booking
flow** (`AppointmentPage.jsx`) — rendered a hardcoded, doctor-agnostic list of 17 times
from `src/constant/global.js` (8am–5pm, 30-minute increments, skipping the 12–1pm hour).
**The same list, for every doctor, regardless of that doctor's actual configured hours,
existing bookings, or anything else.** A doctor who only works Tuesdays 10am–12pm showed
the exact same full-day list as a doctor working 8am–5pm every day.

Confirmed via grep that only the separate doctor-assisted flow
(`Booking/DoctorBooking/DoctorBooking.jsx`) called the real schedule endpoint
(`getAppointmentTimeOfEachDoctor`). Every fix from Pass 5 onward (capacity enforcement,
overlap protection, blocked dates below) was real and correct at the API layer, but
**most real patients never saw any of it reflected in what they were shown** — they'd
pick a plausible-looking time from the fake list and only find out it was invalid when
the actual booking submission got rejected server-side.

Rewrote `SelectApppointment.jsx` to call the same endpoint `DoctorBooking.jsx` already
used correctly, passing the actual selected date (not just a weekday name) so the
backend's availability recalculation (§3) applies. Added loading and empty states
("this doctor has no available times on the selected date") that didn't exist before,
since a real API call can be slow or come back empty in ways a hardcoded array never
could.

---

## 2. Overlap and invalid-time validation

Previously nothing checked that a doctor's submitted time ranges for one day didn't
overlap (`assertNoOverlap`, new) or that a range's start was actually before its end
(`assertValidTimeRange`, new). Both are wired into all three places a schedule can be
written: `createTimeSlot` (initial creation), and `updateTimeSlot`'s two paths — adding
more ranges to an existing day, and editing a range in place (checked against its
siblings, excluding itself).

---

## 3. Availability recalculation

`getAppointmentTimeOfEachDoctor` — flagged as a gap since Pass 5 ("a fully-booked slot
looks exactly as available as an empty one") — now:

1. Returns nothing at all if the requested date is blocked (§4).
2. Excludes any time-of-day already at capacity for that **specific date**, by grouping
   existing non-cancelled appointments by `scheduleTime` and comparing against
   `maximumPatient`.

This only activates when a real `date` is passed (not just a weekday name) — kept
backward compatible for any caller that only wants the theoretical weekly template.

**A date-format consistency issue found while wiring this up**: `Appointments.scheduleDate`
carries a time-of-day component (`"2026-08-20 00:00:00"`, per `AppointmentPage.jsx`'s
`handleDateChange`), but a blocked date means the whole calendar day. Comparing them with
exact string equality (what a Prisma unique lookup does) would have silently never
matched. Fixed by normalizing to `YYYY-MM-DD` specifically for the blocked-date check,
while the **capacity** check deliberately keeps using the raw, unnormalized date — it
needs to exact-match real `Appointments.scheduleDate` values, so the caller (`SelectApppointment.jsx`)
is responsible for sending the same date string to both this endpoint and the eventual
booking submission, which it now does.

---

## 4. Blocked dates (holidays, leave)

New `DoctorBlockedDate` model (`doctorId`, `date`, `reason`, `@@unique([doctorId, date])`)
— flagged as a gap since Pass 5 ("no schema concept of 'closed on Dec 25' at all").
Enforced in **two places**, not just the display endpoint: `assertSlotAvailable`
(`appointment.service.ts`, the actual booking-time check) also rejects a blocked date,
since display can be stale or bypassed and booking enforcement can't rely on the
frontend having already filtered it out — same principle Pass 5 already established for
everything else in that function.

Doctor-facing management UI added to `Schedule.jsx` — pick a date, optional reason, block
it; list of currently-blocked dates with remove buttons. Kept deliberately simple
(a `DatePicker` + plain text input), consistent with the pragmatic-over-polished choices
made in Pass 9.

---

## 5. Schedule deletion and modification rules

- **Deletion** (`deleteTimeSlot`): previously deleted an entire day's schedule
  unconditionally (ownership-checked since Pass 4, but nothing else). Now blocks the
  deletion with a clear count if any future non-cancelled appointment falls on that
  weekday — forces cancelling/rescheduling those appointments through the proper Pass 9
  flow first, rather than silently orphaning a patient who already booked against that
  schedule.
- **Modification** (`updateTimeSlot`'s in-place edit path): shrinking a time range (e.g.
  9–5 → 9–12) is blocked if it would leave any future non-cancelled appointment outside
  the new range. Growing a range, or moving it without shrinking the covered portion, is
  unaffected.

Both checks work in application code (fetch the doctor's future appointments, compare
weekday/time in JS) rather than a single SQL query, since `Appointments.scheduleDate` is
a free-text string (Pass 1's domain model), not a real date column — acceptable
performance-wise given a single doctor's future appointment count is always small.

---

## 6. "Future schedule changes" — confirmed, not built

The plan lists this as its own bullet. Checked rather than assumed: changing the
recurring `DoctorTimeSlot`/`ScheduleDay` template has no retroactive effect on
already-created `Appointments` rows — their `scheduleDate`/`scheduleTime` are independent
stored values, not derived from the template at read time. This was already correct
structurally; nothing needed fixing, just confirming.

---

## 7. What you need to run before this is live

```bash
cd api
npx prisma format && npx prisma validate
npx prisma migrate dev --name pass11-doctor-schedule-engine
```

No data-migration concerns this pass (purely additive schema — a new table, no changed
column semantics).

---

## 8. What this pass deliberately did not do

- **No timezone handling.** Same deferral, same reasoning as Pass 5: everything is naive
  local-time strings, front and back, and fixing it properly needs a coordinated decision
  across the whole stack, not a change buried in a schedule-engine pass.
- **No "past time today" filtering added to the display endpoint.** Checked before
  building anything: both booking UIs (`AppointmentPage.jsx` and `DoctorBooking.jsx`)
  already restrict date selection to tomorrow through +7/+8 days — same-day booking was
  never offered in the first place, so this specific gap (flagged as a possibility in
  Pass 5's notes) turned out not to exist in the actual product.
- **`src/constant/global.js`'s hardcoded `doctorTimeSlot` array was left in place**,
  confirmed now unused anywhere in the codebase (was only ever consumed by the component
  rewritten in §1). Not deleted — harmless dead code, and removing exports the app no
  longer needs is lower priority than the functional fixes in this pass, but worth a
  cleanup pass later.
- **No recurring/repeating blocked-date ranges** (e.g. "every Sunday" or "block March 1–15
  as one action") — `DoctorBlockedDate` is one row per single calendar date. A
  multi-select or date-range convenience UI would be a reasonable follow-up but wasn't
  built here.
