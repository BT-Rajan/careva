# Pass 30 — Multi-Tenant Clinics (frontend wiring)

Status: **Core flows wired (signup, both booking paths, blog creation, schedule
creation, admin doctor-approval table). Notification dispatch call sites, per-clinic
email/image, and clinic self-serve signup still not started.**

---

## Gap found before any frontend work could start: no Clinic API existed

Passes 27-29 built the entire `Clinic` data model — schema, `DoctorClinic` affiliation,
`clinicId` scoping across every module — but never built an API for the `Clinic` model
itself. There was no way for any frontend form to even list clinics for a signup
picker. This should have been flagged explicitly in Pass 27's scope and wasn't — an
oversight, not a deferred decision.

Fixed by adding a minimal, public, read-only `api/src/app/modules/clinic` module
(`GET /clinic`, `GET /clinic/:slug`) — deliberately narrow, exposing only
`id`/`name`/`slug`/`status`, never the integration credential fields on `Clinic`
(`gmailAppPassEnc` etc.). Clinic *creation* is still Pass 32's job (self-serve signup)
— this only makes existing clinics (so far just the "Legacy Clinic" from Pass 27's
migration) visible and selectable.

## What's wired now

- **`SignUp.jsx`** — added a clinic picker (calls the new `GET /clinic`), required
  before submit, for both patient and doctor signup.
- **`AppointmentPage.jsx` / `SelectApppointment.jsx`** (patient self-service booking) —
  `clinicId` threaded into both the availability lookup and the booking submission.
- **`DoctorBooking.jsx`** (doctor-assisted booking) — same fix, sourced from the
  doctor's own profile fetch.
- **`AddBlog.jsx`** — `clinicId` resolved from the doctor's own affiliations and sent
  on blog creation.
- **`Schedule.jsx`** — same pattern, for schedule (`DoctorTimeSlot`) creation.
- **`Doctors.jsx`** (admin table) — reads `approvalStatus` from the `clinics` relation
  instead of the removed `Doctor.approvalStatus` field. Required a backend companion
  fix: `doctor.service.ts`'s `getAllDoctors`/`getDoctor` didn't actually `include` the
  `clinics` relation at all before this pass, so there was nothing for the frontend to
  read even after fixing the field path. Scoped to the admin's own clinic on the admin
  path; restricted to `APPROVED`-only affiliations on the public path, so a doctor's
  `PENDING`/`REJECTED`/`SUSPENDED` standing at some *other* clinic never leaks publicly
  through their profile at a clinic they're legitimately approved at.

## The known, deliberate limitation running through all of this

Every one of these fixes picks **the doctor's first `APPROVED` clinic affiliation**
(`selectedDoctor.clinics[0].clinicId`) with no UI for a patient or doctor to choose
between clinics when one exists. This is fine for the common case — most doctors,
including every doctor migrated by Pass 27, have exactly one clinic — and a real gap
for a genuinely multi-clinic doctor: a patient booking them, or the doctor posting a
blog or setting their own schedule, has no way to specify which clinic they mean.
Building an actual clinic-picker step into each of these flows is follow-up work, not
done here — flagging honestly rather than pretending `clinics[0]` is a complete
solution.

## What's still not done

- **Notification's 7 `dispatchNotification` call sites** (Pass 29's own honest gap) —
  still don't populate `clinicId`.
- **Per-clinic Gmail/image hosting credentials** — `Clinic` has the columns
  (`gmailAppPassEnc`, `imageApiKeyEnc`, etc.) but nothing reads or writes them yet.
- **Self-serve clinic creation** — still just the one "Legacy Clinic" in existence;
  the picker added in `SignUp.jsx` has exactly one option until Pass 32.
- **A real multi-clinic picker UI** — see the limitation above.
- **Compile/runtime verification** — same standing caveat as every pass so far: no
  `npx prisma generate` / `npx tsc --noEmit` / actual browser testing has been run in
  this sandbox (no network access to Prisma's engine binaries, and no way to run a dev
  server against a real database here). This pass touches more files across more
  layers (schema + 3 backend modules + 7 frontend files) than any single previous
  pass — treat the compile-risk warning as stronger here, not weaker.

## Next passes

- **Pass 31** — thread `clinicId` through Notification's dispatch call sites, wire
  per-clinic Gmail sending.
- **Pass 32** — per-clinic image hosting.
- **Pass 33** — self-serve clinic signup + a real multi-clinic picker UI, retiring the
  `clinics[0]` shortcut everywhere it was used in this pass.
