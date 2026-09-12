# Pass 28 — Multi-Tenant Clinics (query scoping)

Status: **Core booking-flow modules done (auth, doctor, patient, appointment,
doctorTimeSlot). Remaining modules and all frontend wiring are Pass 29+.**

Also includes one correction to Pass 27: the schema originally used `superadmin` for
the new role. The codebase already had a dead placeholder — `AuthUser.SUPER_ADMIN =
'super_admin'` in `enums/index.ts`, which Pass 4's own comments flagged as unreachable
because the Prisma enum never had a matching value. Renamed to `super_admin` to finally
make that placeholder real instead of introducing a third spelling.

---

## The two worst things this pass found and fixed

Both were **zero-scoping, not partial-scoping** — not "admin could see a bit more than
they should," but "any authenticated admin could see or destroy the entire platform's
data of this type":

1. **`appointment.service.ts`'s `getAllAppointments`** — `prisma.appointments.findMany()`
   with no `where` clause at all, gated only by `auth(AuthUser.ADMIN)`. Any admin, from
   any clinic, saw every appointment on the platform.
2. **`appointment.service.ts`'s `deleteAppointment`** — took no `reqUser` parameter at
   all. Any admin could hard-delete any clinic's appointment by id.

`doctor.service.ts`'s `getAllDoctorsForAdmin` and `patient.service.ts`'s
`getAllPatients` were the same shape of gap (the two called out in the original gap
analysis) and are fixed the same way.

## The fix pattern, applied consistently

Every admin-facing list/read/write in this pass follows the same shape:

```ts
const isSuperAdmin = reqUser?.role === 'super_admin';
const isAdmin = reqUser?.role === 'admin' && <resource>.clinicId === reqUser?.clinicId;
if (!isSuperAdmin && !isAdmin && !isOwner) { throw new ApiError(FORBIDDEN, ...) }
```

clinicId is always read from `req.user` (the verified JWT payload set by the auth
middleware), never from `req.query`/`req.body` for an `admin` actor — that's the actual
fix. A client-supplied clinicId would just move the trust boundary, not close it.

## Functional fixes, not just security (the app would not have run otherwise)

Adding required `clinicId` columns in Pass 27 broke things beyond authorization — these
had to be fixed for booking to work AT ALL, independent of the leak:

- **`assertSlotAvailable`** (the booking-capacity check) — `DoctorTimeSlot`'s uniqueness
  is now `(doctorId, clinicId, day)`. Without threading clinicId through, this can't
  disambiguate a doctor's schedule at Clinic A from Clinic B.
- **`buildAppointmentCore`** — doctor approval is now per-clinic (`DoctorClinic`), so the
  old `doctor.approvalStatus !== 'APPROVED'` check doesn't compile. Booking now requires
  `patientInfo.clinicId` (derived from the patient's own record if authenticated,
  required explicitly for guest bookings) and checks that SPECIFIC clinic's affiliation.
- **`doctorTimeSlot.service.ts`'s `createTimeSlot`** — requires `clinicId` and validates
  the doctor is actually affiliated with it before creating a schedule row.
- **`getAppointmentTimeOfEachDoctor`** (public availability display) — without
  `clinicId`, a doctor at two clinics would have both schedules merged into one
  combined availability view. Now requires `filter.clinicId`.
- **Doctor and patient signup** (`doctor.validation.ts`, `patient.validation.ts`) — both
  now require `clinicId`; otherwise a newly created account would have no clinic
  affiliation and be invisible everywhere.

## What's deliberately NOT in this pass

- **Reviews, Blogs, Prescription, Invoice, Medicines, Favourites, Notification** —
  untouched. Same fix pattern, same risk shape, genuinely deferred to keep this pass
  reviewable rather than one enormous diff — Pass 29's job.
- **Frontend** — `src/components/Admin/Doctors/Doctors.jsx` still reads
  `record.approvalStatus` directly off a Doctor row, which no longer exists there (it's
  now on the `clinics` relation returned by the API). This is a **known break**, not an
  oversight: fixing it properly means updating the API response shape's consumption AND
  testing the actual UI, which isn't reliable to do blind in a backend-only pass.
  Flagging rather than guessing at a fix. Same applies to any other frontend call site
  that will need `clinicId` added to its request payloads (doctor signup, patient
  signup, booking, availability lookup, schedule creation) — none of those have been
  touched.
- **`Doctor.clinicName` / `Doctor.clinicAddress`** — pre-existing free-text fields from
  the single-tenant era, now sitting oddly next to the real `Clinic` model. Not removed
  or migrated in this pass; worth a decision later on whether they're redundant now.

## Next passes

Unchanged from Pass 27's doc: Pass 29 (remaining modules' query scoping + frontend
wiring), Pass 30 (per-clinic Gmail + doctor page routing), Pass 31 (per-clinic image
hosting), Pass 32 (self-serve clinic signup).
