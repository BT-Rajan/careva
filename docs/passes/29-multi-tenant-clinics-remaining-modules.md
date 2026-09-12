# Pass 29 — Multi-Tenant Clinics (remaining modules)

Status: **Backend query scoping done for Reviews, Blogs, Prescription, Invoice, and
(as a bonus — see below) Payment. Notification partially done. Medicines/Favourites
needed no changes. Frontend wiring NOT done — still Pass 30's job.**

---

## What this pass found (same severity pattern, every time)

Every module in this pass had at least one **completely unscoped** admin-facing
query — not partially leaky, zero-filter — matching the exact shape Pass 28 found in
appointments/doctors/patients:

- **`reviews.service.ts`'s `getAllReviewsForAdmin`**
- **`prescription.service.ts`'s `getAllPrescriptions`** — arguably the worst one found
  in the whole engagement: this exposes **diagnosis and medication data** across
  clinics, not just scheduling metadata.
- **`payment.service.ts`'s `getReconciliationQueue`** — not in the original Pass 27/28
  scope list, found while checking for the same pattern nearby. Exposes payments stuck
  in reconciliation across every clinic.
- **`reviews.service.ts`'s `deleteReviews`/`updateReview`** and **`blog.service.ts`'s
  `deleteBlog`/`updateBlog`** — the `isAdmin` check existed but granted access to
  *any* clinic's record, not just the admin's own (same "isAdmin bypasses ownership
  entirely" bug fixed in doctor/patient/appointment during Pass 28).

Fixed with the same pattern used throughout Pass 28: `clinicId` from the actor's own
token, `super_admin` unrestricted, everyone else checked against the actual resource's
`clinicId`.

## Schema additions this pass required

`clinicId` added to Reviews, Invoice, Prescription, Blogs (all required) and
Notification (nullable). Sourcing at creation time:

- **Reviews** — from the linked appointment's clinic, or the reviewing patient's own
  clinic if there's no appointment link.
- **Invoice / Prescription** — denormalized from the appointment being billed/treated,
  same pattern both places. Correction/versioning flows (both models support this)
  carry `clinicId` forward from the original rather than re-deriving it.
- **Blogs** — the doctor picks which clinic they're posting as/for at creation time,
  validated against their actual `DoctorClinic` affiliation (same check
  `doctorTimeSlot.service.ts`'s `createTimeSlot` uses).
- **Notification** — see the honest gap below.

## Payment: fixed via relation, no schema change

`Payment` did NOT get its own `clinicId` column — it already has an `appointmentId`
relation, and `Appointments.clinicId` exists since Pass 27, so `refundPayment`,
`getReconciliationQueue`, and `resolveReconciliation` are scoped by filtering/checking
through `appointment.clinicId` instead. Same protection, no migration needed for this
one.

## The honest gap: Notification

`getNotifications`, `getNotificationById`, and `retryNotification` are scoped and
fail closed — but **none of the 7 places that actually call `dispatchNotification`**
(across `doctor.service.ts`, `auth.service.ts`, `appointment.service.ts`) have been
updated to populate `clinicId` yet. Every notification sent today will have
`clinicId = NULL`, which means:

- A regular `admin` will currently see **zero** notifications in their own clinic's
  view (fails closed, not a leak — but broken from a "where did my emails go" UX
  standpoint).
- Only `super_admin` gets a working view of the notification log until the 7 call
  sites are updated.

This is a real, known limitation, not an oversight — threading `clinicId` through 7
call sites accurately needs the same care as everything else in this pass, and doing
it hastily risks getting the derivation wrong (e.g. a doctor-approval-status email has
an unambiguous clinic; a password-reset email might not). Left for Pass 30.

## What's deliberately NOT in this pass

- **Medicines** — no changes needed; always accessed through its parent Prescription
  (which is now scoped), never listed independently.
- **Favourites** — no changes needed; already scoped by the patient's own ownership
  (a patient bookmarking a doctor isn't a cross-clinic data exposure the way listing
  someone else's patients/appointments/prescriptions is).
- **Frontend — still entirely untouched.** In addition to the Pass 28 known-break
  (`Doctors.jsx`), every create flow that now requires `clinicId` (doctor signup,
  patient signup, blog creation, booking, availability lookup, schedule creation) has
  no corresponding frontend change. This backend will not work correctly against the
  current frontend build. Pass 30's job, alongside per-clinic email/doctor page
  routing as originally planned.

## Next passes

- **Pass 30** — frontend wiring (all of it, accumulated across Pass 28+29) + threading
  `clinicId` through Notification's 7 dispatch call sites + per-clinic Gmail sending +
  doctor page routing.
- **Pass 31** — per-clinic image hosting.
- **Pass 32** — self-serve clinic signup.
