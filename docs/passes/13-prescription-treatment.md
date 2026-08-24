# Pass 13 — Prescription & Treatment

Status: **Complete**

Scope: `api/prisma/schema.prisma` (Prescription model + new `PrescriptionStatus` enum),
new `api/src/app/modules/prescription/prescription-lifecycle.ts`,
`api/src/app/modules/prescription/prescription.{service,controller,route}.ts`,
`api/src/app/modules/medicines/medicine.service.ts`, and four frontend files
(`Doctor/Prescription/Prescription.jsx`, `Doctor/Prescription/PrescriptionView.jsx`,
`Doctor/Dashboard/PatientDashboard.jsx`, `redux/api/prescriptionApi.js`). Schema change:
yes — this pass's whole job, per the target model in
`docs/passes/01-domain-state-model.md` §4.4 and the Pass 2 comment on
`Prescription.deletedAt` explicitly deferring soft-delete wiring here. No stack change.

---

## 1. Real prescription lifecycle, replacing two dead booleans

`Prescription.isFullfilled` / `isArchived` are gone, replaced by a real
`PrescriptionStatus` enum (`ISSUED → FULFILLED`, `ISSUED/FULFILLED → CORRECTED`,
`ISSUED/FULFILLED → ARCHIVED`), enforced by a new state machine —
`prescription-lifecycle.ts` — following the same two-part pattern as
`appointment-state-machine.ts` (Pass 8) and `doctor-lifecycle.ts` (Pass 10): a
transition table plus a per-transition actor table.

While grounding this against the real code, found that **neither boolean had ever been
reachable from any UI**: the frontend mutation meant to set them
(`prescriptionApi.js`'s `updatePrescription`) exported its RTK Query hook as
`useUpdatePrescriptionQuery` — a name RTK Query never generates for a `build.mutation`
endpoint (only `build.query` endpoints get a `use...Query` hook). The import resolved to
`undefined` everywhere, and no component ever called it. That whole endpoint
(`PATCH /prescription/:id`, `PRESCRIPTION_EDITABLE_FIELDS`) is removed rather than fixed
— it's superseded by the dedicated lifecycle endpoints below.

New endpoints:

- `PATCH /prescription/:id/fulfill` — `ISSUED → FULFILLED`. Actors: **patient**, doctor,
  admin. The patient is the primary actor here (only they reliably know whether they
  obtained the medication); doctor/admin can also record it, e.g. reported at a
  follow-up visit.
- `PATCH /prescription/:id/archive` — `ISSUED/FULFILLED → ARCHIVED`. Doctor (own record)
  or admin only. Visibility-only, matching the target model; deliberately terminal — no
  caller anywhere needs an "unarchive," so none is built.
- Correction: see §2.

Frontend: `Prescription.jsx`'s stat cards and status tag now read `status` instead of
`isArchived`; added Mark Fulfilled / Archive action buttons, gated to the states that
legally allow them. `PatientDashboard.jsx` had a second, independent bug in its own
`isArchived` column — antd passes the raw cell *value* to `render` when `dataIndex` is
set, not the row object, so `render: function({isArchived})` was destructuring a
boolean and always got `undefined`; the column had been silently rendering "Under
Treatment" for every row regardless of actual value. Replaced with a `status`-based
column read directly off the record.

## 2. Correction (versioning), not in-place editing

The target model's `CORRECTED` state means "create a new linked version; original stays
intact for audit" — once issued, a prescription's clinical content is never mutated in
place again. `updatePrescriptionAndAppointment` (the endpoint `TreatmentEdit.jsx`
already calls to "edit" a prescription) is rewritten to perform a real correction
instead of a `tx.prescription.update` on the existing row:

- The existing row transitions `ISSUED/FULFILLED → CORRECTED` (via
  `assertValidPrescriptionTransition`) and stays intact — same `id`, same `createdAt`,
  everything.
- A new row is created with `status: ISSUED` and `supersedesId` pointing back at the
  original, carrying forward whichever fields the client sent as overrides.
- The new version's medicines are copied forward as new `Medicine` rows — the
  original's medicines stay attached to the original, corrected version gets its own
  copy that a further edit will version again.
- Appointment-side fields (`isFollowUp`, `patientType`) are follow-up/scheduling
  metadata, not part of the versioned medical record, and continue to update in place
  as before.

Kept this as the *same* endpoint/request shape the frontend already calls rather than
adding a new, separately-wired "correct" action — the existing edit flow now does the
right thing without needing new frontend plumbing. `Prescription.jsx`'s "Edit" button is
relabeled "Correct" to reflect what it actually does, and is hidden once a row is
`CORRECTED`/`ARCHIVED` (both terminal — there's nothing left to correct there).
`PrescriptionView.jsx` now shows a banner linking a corrected row forward to its current
version, and a corrected row backward to the one it replaced.

**Medicine immutability, closed at the source.** Without a matching guard in the
`medicines` module, a doctor could still add/edit/delete medicine line items on a
`CORRECTED` or `ARCHIVED` prescription directly through `medicine.service.ts`, bypassing
the whole "original stays intact" guarantee above. All three medicine mutations
(`createMedicine`, `updateMedicine`, `deleteMedicine`) now reject unless the owning
prescription is `ISSUED` and not soft-deleted.

## 3. Prescription soft-delete — wired, not just scaffolded

`Prescription.deletedAt` (added in Pass 2) carried an explicit comment: "Prescriptions
are medical/legal records and should never be hard-deleted going forward; wiring is
Pass 13's job." Before this pass, `deletePrescription` still hard-deleted the row
outright — exactly the hazard that comment flagged.

Now, matching Pass 12's `Patient` soft-delete convention exactly:

- `deletePrescription` sets `deletedAt` instead of deleting the row.
- Every prescription list-fetcher (`getAllPrescriptions`, `getDoctorPrescriptionById`,
  `getPatientPrescriptionById`) filters `deletedAt: null`.
- Added `reactivatePrescription` (admin-only) as the reverse.
- Both actions, plus every lifecycle transition above, write to `AuditLog`.

**Deliberately did not filter `getPrescriptionById`** (the direct-by-id fetch) by
`deletedAt`/`status` — unlike the list endpoints, this is how the app displays a
specific historical version (e.g. following a `supersededBy`/`supersedes` link). Hiding
a corrected or deactivated row here would break the exact record continuity soft-delete
and correction are designed to preserve.

## 4. A second, independent frontend bug fixed along the way

`prescriptionApi.js`'s `deletePrescription` mutation took no argument and always issued
`DELETE ${PRESCRIPTION_URL}/` (no id, trailing slash) — a URL shape the backend's
`DELETE /:id` route (fixed in Pass 4, see that pass's doc) never matches. Every call
from `Prescription.jsx`'s confirm-delete button (`deletePrescription(id)`) was silently
ignoring the `id` it was given and hitting a URL that 404s. Fixed to accept and forward
the id.

## 5. What this pass deliberately did not do

- **No `DRAFT` state.** The target model's full lifecycle
  (`docs/passes/01-domain-state-model.md` §4.4) includes `DRAFT → ISSUED`, but every real
  code path creates a prescription already-complete and atomically transitions the
  appointment to `COMPLETED` in the same transaction (Pass 12) — there is no partial-save
  UI anywhere that would ever leave a row in a draft state. Adding an unused enum
  value/scaffold for it would be exactly the kind of speculative surface these hardening
  passes have been removing, not adding. Flagged here as a deliberate omission.
- **No pharmacy/fulfillment-provider entity.** `FULFILLED` is a patient/doctor/admin
  self-report, not a verified pharmacy integration — no such entity exists in the app,
  and inventing one wasn't asked for.
- **No "unarchive."** `ARCHIVED` is modeled as terminal. Nothing in the app has ever
  asked for a reverse edge; adding one nobody can trigger yet would be speculative.
- **No changes to `Appointments.prescriptionStatus`** (the separate, pre-existing
  `issued`/`notIssued` enum on the Appointments table). That's appointment-side summary
  state set once at creation time (Pass 12) and is orthogonal to the real
  `Prescription.status` lifecycle this pass builds — left untouched.
