# Pass 4 — Authorization & RBAC

Status: **Complete**

Scope: every route file and its backing controller/service across `doctor`, `patient`,
`appointment`, `doctorTimeSlot`, `medicine`, `prescription`, `blog`, and `reviews`
modules, plus one frontend fix (`Admin/Doctors.jsx`) needed to make a related backend fix
actually work. No stack change — same Express middleware pattern (`auth(...role)`)
already used throughout the app, applied consistently and backed by ownership checks
inside the services.

This pass turned into a full authorization audit rather than a narrow fix, because the
existing pattern (`auth(AuthUser.DOCTOR)` etc.) only ever checked **role**, never
**identity** — nothing anywhere verified that the doctor calling an endpoint was the
doctor who owned the resource being touched. That gap was close to universal, not
isolated to one or two routes.

---

## 1. Critical: cross-tenant data corruption (was live, not just readable)

**`doctorTimeSlot.updateTimeSlot`** — this is the one finding in this pass that wasn't
just "wrong person can read/write something," it was actively capable of **corrupting a
different doctor's data**:

- The `create` path looked up the target `DoctorTimeSlot` by `day` **alone**, with no
  `doctorId` filter. If Doctor B already had a Monday schedule row, Doctor A creating
  their own Monday schedule could resolve to *Doctor B's* row and attach new `ScheduleDay`
  entries to it.
- The `timeSlot` (edit) path updated `ScheduleDay` rows by id with no check that the row's
  parent `DoctorTimeSlot` belonged to the caller at all — any doctor could edit any other
  doctor's individual schedule entries by supplying arbitrary ids.

Fixed: the `create` lookup is now scoped by `doctorId`, and the update uses a nested
Prisma relation filter (`doctorTimeSlot: { doctorId: isDoctor.id }`) so it's a no-op
unless the row actually belongs to the caller — and a no-op is now treated as a `403`,
not a silent success.

---

## 2. IDOR fixed on mutating endpoints

The pattern was the same everywhere: the route checked *a role*, the service never
checked *whose* resource was being touched. Fixed identically across all of these —
caller must own the resource, or be admin:

| Endpoint | Before | After |
|---|---|---|
| `PATCH /doctor/:id`, `DELETE /doctor/:id` | any doctor, any target | self or admin |
| `PATCH /patient/:id`, `DELETE /patient/:id` | any patient / no auth at all | self or admin |
| `PATCH /appointment/:id` | any of admin/doctor/patient, any target, full body accepted | owner (patient or doctor on the appointment) or admin, **and** restricted to the `status` field only |
| `PATCH /appointment/doctor/update-appointment` | any doctor, any appointment, full body accepted | the appointment's own doctor only, restricted field set |
| `POST /prescription/create` | any doctor, any appointment | only the appointment's own doctor |
| `PATCH /prescription/update-prescription-appointment` | any doctor, any prescription | only the prescription's own doctor |
| `PATCH /prescription/:id`, `DELETE /prescription/:id` | any doctor/admin, any prescription, full body on update | owning doctor or admin; update restricted to clinical-content fields only |
| `POST/PATCH/DELETE` on medicine | any doctor, any prescription's medicine | only via the owning doctor's prescription |
| `PATCH /blog/:id`, `DELETE /blog/:id` | any doctor, any post | author or admin |
| `PATCH /reviews/:id/reply` | any doctor, any review | only the reviewed doctor |
| `DELETE /doctorTimeSlot/:id` | any doctor, any schedule | owner only |

### Mass-assignment fixed alongside ownership

Several of the above accepted the **entire request body** as the Prisma `data` payload
with no field allow-list, which is its own separate problem even after ownership is
fixed. The two that mattered most:

- **`doctor.updateDoctor`**: a doctor could include `verified: true` in their own
  profile-edit payload and self-approve, completely bypassing admin review. Now `verified`
  is stripped from the payload unless the caller is an admin.
- **`appointment.updateAppointment`**: any authenticated caller could set
  `paymentStatus`, `doctorId`, or any other column on an appointment they had access to.
  Checked the frontend first — every real caller (doctor Accept/Cancel buttons, the admin
  panel) only ever sends `{ status }` — so restricting the update to that one field closes
  the hole without breaking anything live.

---

## 3. Unauthenticated PII/PHI exposure fixed

Three endpoints had **no auth middleware at all**:

- `GET /patient` (list all patients — full PII) — real, used by the admin dashboard.
  Restricted to admin.
- `GET /patient/:id` — confirmed unused by the frontend (dead code), still a live,
  reachable, unauthenticated endpoint. Restricted to self or admin.
- `GET /appointment` (list all appointments — PII + reason-for-visit) — real, used by the
  admin dashboard (`adminApi.js`'s `getAllAppointments` hits this exact route).
  Restricted to admin.
- `DELETE /appointment/:id` — confirmed unused by the frontend. Restricted to admin.

`appointment.getPaymentInfoViaAppintmentId` already required login but never checked the
appointment belonged to the caller — any authenticated patient or doctor could view any
other appointment's financial breakdown and the patient/doctor names+addresses attached
to it. Fixed with an ownership check.

### Deliberately left public: `GET /appointment/:id`

Checked the frontend before touching this one: `BookingSuccess.jsx` (the guest,
unauthenticated post-booking confirmation page) and `BookingInvoice.jsx` both depend on
this being reachable without login. Locking it down would break a real, core product flow
for guest bookings. Left public, but this is exactly the kind of endpoint Pass 15
(Tracking & Public Access) exists to harden properly — e.g. moving guest access onto the
purpose-built opaque `trackingId` instead of the raw database `id`, adding rate limiting,
etc. Flagged there rather than fixed here.

---

## 4. Two broken (not insecure — just non-functional) endpoints fixed

Found while auditing route definitions, unrelated to authorization directly but caught in
the same sweep:

- **`prescription.route.ts` had `router.delete('/:', ...)`** — a typo missing the param
  name, so `req.params.id` was always `undefined`. This is a **live, frontend-wired
  feature** (`Doctor/Prescription/Prescription.jsx` calls it) — doctors clicking delete on
  a prescription have been hitting a guaranteed failure. Fixed to `/:id`.
- **`doctorTimeSlot`'s delete/update routes had no `:id` in the URL at all**
  (`router.delete('/', ...)`), and the service's `deleteTimeSlot` was confirmed unused by
  the frontend (defined as a `build.query`, never called from any component) — so this one
  had zero live impact, but is now fixed to `/:id` for consistency and correctness anyway.
- **`AuthUser.SUPER_ADMIN`, used on the blog-delete route, isn't a real role** — the
  Prisma `UserRole` enum only has `admin | patient | doctor`. That branch could never
  match a real logged-in user, so admins had **no working path to delete blog content at
  all**. Replaced with the real `AuthUser.ADMIN`.
- **The admin "verify doctor" toggle was silently broken**: `Admin/Doctors.jsx` sent
  `{ verified: !doctor.verified }` as a plain JSON body, but the backend endpoint expects
  a multipart `FormData` with a `data` field containing a JSON *string* (the convention
  the doctor's own profile-edit form correctly uses). Every click would have hit a
  `JSON.parse` error server-side. Fixed the frontend call to match the expected shape —
  necessary anyway once the route was opened up to admins (§2), since a fixed-but-
  unreachable endpoint doesn't help.

---

## 5. What you need to run before this is live

No schema changes this pass, so no `prisma migrate` needed. Do run the app's normal build/
type-check in your own environment — same sandbox limitation as prior passes means
`prisma generate` never ran here, so the TypeScript compiler currently reports "no
exported member 'Doctor'/'Patient'/etc. from @prisma/client" across the whole codebase
(pre-existing, not introduced by this pass — verified by confirming the same errors
appear in files nobody touched). Those clear on their own once you run `npx prisma
generate` for real. I verified every file touched in this pass compiles clean of *new*
errors beyond that pre-existing noise, and did a brace-balance sanity check across all 22
touched files as a lower-bar syntax check given I couldn't run the TypeScript compiler's
full resolution here.

---

## 6. What this pass deliberately did *not* do

- **Transition-legality rules** (e.g. can a `COMPLETED` appointment go back to
  `PENDING`?) — this pass only controls *who* can act and *what field* they can touch, not
  which status values are valid to move between. That's Pass 8's job (Appointment State
  Machine), which owns turning `status` into a real enum with defined transitions.
- **`GET /appointment/:id` hardening** — see §3. Deferred to Pass 15.
- **Full admin field permissions** — `updateAppointment` now restricts *everyone*,
  including admins, to the `status` field, since that's 100% of real usage today. If
  admins need broader edit capability later, that's a deliberate new capability to design
  (with its own allow-list), not something to quietly re-open here.
- **Rewriting `getAllPrescriptions`/`getPrescriptionById`'s admin-list default** — these
  were locked to admin/owner respectively based on confirmed current frontend usage, not
  redesigned.
- **Reviews.replyReviewByDoctor's underlying moderation model** — full review moderation
  (flagging, removal states) is Pass 21's job; this pass only fixed *who* can attach a
  reply to *which* review.
