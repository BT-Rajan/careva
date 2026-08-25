# Pass 15 — Tracking & Public Access

Status: **Complete**

Scope: new `api/src/shared/trackingId.ts`,
`api/src/app/modules/appointment/appointment.{service,controller,route}.ts`, and
frontend: `redux/api/appointmentApi.js`, `Booking/BookingSuccess.jsx`,
`Booking/DoctorBooking/DoctorBooking.jsx`, `Appointment/AppointmentPage.jsx`,
`TrackAppointment/TrackAppointment.jsx`. No schema change, no stack change.

---

## 1. The gap this pass closes

Pass 4 found and explicitly deferred this exact item — the comment was still sitting on
`GET /appointment/:id` in `appointment.route.ts`: *"intentionally left public ...
Locking it down properly (e.g. requiring the opaque trackingId instead of the raw
database id) is Pass 15's job."*

Two things were actually wrong, not one:

**`GET /appointment/:id` had no auth at all**, and returned the complete raw row —
`include: { doctor: true, patient: true }`, every column on both — to anyone who
supplied any appointment UUID. It wasn't only serving its one legitimate public
consumer (`BookingSuccess.jsx`, guest post-booking confirmation): two authenticated
doctor-dashboard pages, `ViewAppointment.jsx` and `Treatment.jsx`, were *also* fetching
through this same unauthenticated route, meaning the doctor dashboard's own appointment
detail view had silently been relying on a public IDOR the whole time.

**The `trackingId` meant to be the "opaque" identifier wasn't opaque.** The app's own
public tracking page (`TrackAppointment.jsx`) tells patients outright: *"Only someone
with your tracking ID can load this summary."* That statement was false. `trackingId`
was generated as `first 3 letters of the patient's name + year + month + day-of-year +
a 3-digit sequential counter` — a first name isn't a secret, the date is often known or
narrow to search, and a 3-digit counter is trivially enumerable per clinic-day. The
"opaque token" Pass 4 pointed to as the fix wasn't actually opaque, so pointing
`BookingSuccess.jsx` at it without also fixing its generation would have "fixed" the
gap in name only.

## 2. What changed

**`shared/trackingId.ts`** — new `generateTrackingId()`: `CV` + 12 hex characters from
6 random bytes (2^48 possibilities), replacing the name/date/counter format at both
call sites (`createAppointment`, `createAppointmentByUnAuthenticateUser`). Short enough
to still type/paste (matching `TrackAppointment.jsx`'s own UX — a search box expecting
a pasted code), but no longer derivable from public information. This also removed the
"look up the previous row and parse its suffix" dance entirely — a random token needs
no collision-avoidance counter — along with a latent formatting bug in it
(`dayOfYear().toString().padStart(2,'0')` doesn't truncate, so the "day" segment was
inconsistently 2-or-3 digits from day 100 of the year onward).

**`getAppointment`** (the raw-id endpoint) now takes `reqUser` and requires
admin/doctor-owner/patient-owner — closing the IDOR for `ViewAppointment.jsx` and
`Treatment.jsx`, which get this for free since the frontend already attaches the auth
token to every request when logged in (`axiosInstance.js`). Route now sits behind
`auth(PATIENT, DOCTOR, ADMIN)`.

**`getAppointmentByTrackingId`** now has an explicit, deliberately-curated top-level
`select` — previously a bare `findUnique` with no top-level select, meaning every
scalar column on `Appointments` (including internal-only fields like
`statusChangedBy`, a raw actor id) was implicitly part of the public response, and
would silently stay that way for any future column added to the table. The selected
fields are exactly what `TrackDetailPage.jsx` and `BookingSuccess.jsx` render — status,
schedule, trackingId, contact info, reason for visit, a curated doctor/patient subset —
nothing more. This endpoint stays genuinely public and unauthenticated: with a real
random `trackingId`, that's now the correct design, not a gap.

**`BookingSuccess.jsx`** now looks its appointment up via the trackingId-keyed query
(new `useGetAppointmentByTrackingQuery` hook, added alongside the existing
`useTrackAppointmentMutation` — same endpoint, query-shaped so it auto-fetches on
mount instead of needing a manual trigger) instead of the now-locked-down raw-id route.
Both places that navigate to this page (`DoctorBooking.jsx`, `AppointmentPage.jsx`)
pass `trackingId` instead of `id`. Its own "View in dashboard" link (only shown to a
logged-in patient) switches to `data.id` — the raw database id is still present in the
trackingId-lookup response and is exactly what `ViewAppointment.jsx`'s route expects.

## 3. What this pass deliberately did not do

- **`POST /appointment/create-un-authenticate` stays unauthenticated** and unaudited
  beyond the trackingId fix already applied to it. Confirmed unused by the frontend
  today — both booking flows (`DoctorBooking.jsx`, `AppointmentPage.jsx`) already use
  the regular `POST /create` regardless of login state — but it's still a live,
  directly-callable API route, so its trackingId generation got the same fix as the
  authenticated path. Broader cleanup of this route (or removing it if it's truly
  dead) is not this pass's charter.
- **`POST /appointment/create` staying open with no auth is intentional, not a gap.**
  Booking an appointment without an account is a legitimate product decision (you
  shouldn't need to register before you can book), unlike a `GET` that hands out an
  existing patient's data to anyone who asks — that distinction is why this pass
  touched the read path and not the create path.
- **No rate-limiting added to `POST /tracking`.** A random 2^48-space token doesn't
  need it to resist guessing, but repeated lookups from a single client are still an
  observability gap in principle — that's Pass 19's territory (Security Hardening) or
  Pass 20's (Concurrency & Idempotency has its own rate-limit-shaped concerns), not
  this pass's.
