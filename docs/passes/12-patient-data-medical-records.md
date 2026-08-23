# Pass 12 — Patient Data & Medical Records

Status: **Complete**

Scope: `api/src/app/modules/prescription/prescription.service.ts` (critical bug fix +
audit trail), `api/src/app/modules/patient/patient.{service,controller,route}.ts`
(soft-delete wiring), and two frontend files
(`Doctor/Treatment/Treatment.jsx`, `Doctor/Treatment/TreatmentEdit.jsx`). No schema
changes (Pass 2 already added `Patient.deletedAt` as scaffolding, explicitly deferred to
this pass to wire up). No stack change.

Most of "ownership" for patients/appointments/prescriptions was already built in Pass 4;
this pass found and fixed what was still missing, starting with something serious found
while grounding the "prescription creation" bullet in the actual code.

---

## 1. Critical, live-breaking bug: prescription creation was broken by Pass 8

While reviewing "prescription creation" against the real code, found that
`createPrescription` and `updatePrescriptionAndAppointment` both took a raw `status`
string straight from the client and wrote it **directly** to `Appointments.status` via
Prisma — completely bypassing `assertValidAppointmentTransition` (Pass 8's state
machine). The client side of this, `Doctor/Treatment/Treatment.jsx` and its edit
counterpart, sourced that string from a dropdown built on a stale constant
(`src/constant/global.js`'s `appointmentStatus` array: `"confirmed"`, `"InProgress"`,
`"Completed"` wrong-case, `"FollowUp"`, `"archived"`, etc.) — **none of which have ever
been valid, and definitely aren't valid `AppointmentStatus` enum members since Pass 8
turned that column into a real enum.**

Net effect: since Pass 8 shipped, **every single option that dropdown offered would
cause the appointment update to fail with a Prisma validation error**, meaning doctors
could not successfully complete treatment or issue a prescription through this form at
all. This was a real regression I introduced and didn't catch at the time — Pass 8's
sweep covered every file I could find that *compared against* the old status strings,
but missed this one, which *wrote* a value sourced from a completely separate, stale
constant never touched by that pass.

**Fixed at the root, not patched.** There was never a good reason for this to be a
free-form field the client controls: successfully creating a prescription always means
treatment was given, which always means the appointment is now `COMPLETED`. So:

- `createPrescription` no longer accepts a `status` field at all — it validates and
  performs the `<current> → COMPLETED` transition itself, through
  `assertValidAppointmentTransition`, same as every other transition in the app. A
  useful side effect: this now correctly **rejects** completing an appointment that's
  still `PENDING` (never accepted) — a real workflow guarantee that didn't exist before
  (previously, any string could be written regardless of the appointment's actual state).
- `updatePrescriptionAndAppointment` (editing an already-created prescription) drops
  `status` entirely — by the time a prescription exists to edit, its appointment is
  already `COMPLETED`, a terminal state with zero legal outgoing transitions, so there
  was never anything valid for this to do with a status field anyway.
- The frontend dropdown ("Change Appointment Status") is **removed**, not just fixed —
  there's no longer any ambiguity for the doctor to resolve; completing the form
  completes the appointment, automatically, server-side.

---

## 2. Medical-record audit trail

Prescription create/update had no audit trail at all — a clinical record with real legal
weight was exactly as unaudited as any other CRUD row. Both now write to `AuditLog`
(`prescription.created`, `prescription.updated`), same pattern established in Pass
8/9/10 for appointment and doctor-lifecycle changes. The appointment's forced
`→ COMPLETED` transition inside `createPrescription` also gets its own
`appointment.status_changed` entry, consistent with every other transition in the app.

---

## 3. Patient soft-delete — wired, not just scaffolded

Pass 2 added `Patient.deletedAt` and explicitly deferred wiring it here. Before this
pass, `deletePatient` still **hard-deleted** the row (and its `Auth` row) outright —
exactly the hazard Pass 2's `onDelete: Restrict`/`SetNull` choices on
`Appointments`/`Reviews`/`Prescription` were designed to guard against at the database
layer, undermined by deleting the referenced row in the first place.

Now:

- `deletePatient` sets `deletedAt` and deletes only the `Auth` row (so the account can no
  longer log in — `loginUser` already throws "User is not Exist" once `Auth` is gone, no
  extra login-gate code needed, unlike Pass 10's doctor suspension which needed an
  explicit check since doctor `Auth` rows are never deleted).
- `getAllPatients` and `getPatient` now filter `deletedAt: null` — a deactivated patient
  disappears from the admin roster and can no longer be looked up directly.
- Added `reactivatePatient` (admin-only) as the reverse — clears `deletedAt`. Does **not**
  restore the deleted `Auth` row; full credential restoration is a bigger decision left
  undecided rather than guessed at (the patient would need to register again with the
  same email, which is possible once the old `Auth` row is gone).
- Both actions write to `AuditLog`.

**Deliberately did not touch** nested `patient: { include: ... }` lookups inside
appointment/prescription/review queries (a doctor's own patient list, appointment
history, etc.) — a deactivated patient's name should still appear in historical records a
doctor already has a relationship with; filtering those out would break record
continuity for no privacy benefit, since the doctor already has a legitimate
prior relationship with that specific patient's data.

**Deliberately admin-only**, matching the existing Pass 4 route restriction — a real
patient-initiated "delete my own account" flow with proper consent/confirmation UX is
Pass 24's job (Data Privacy & Retention), which owns that decision.

---

## 4. Sensitive-field restrictions — reviewed, not changed

Checked what `getDoctorPatients` (a doctor's own patient list, scoped to patients they've
had a real, verified appointment with — Pass 4 already enforces that scoping) actually
returns: the full `Patient` record, no field-level trimming. Considered restricting this
further, but concluded the existing **relationship-based** access control (Pass 4 — only
doctors with a real appointment history, only the patient themselves, or admin) is the
correct primary control here; a treating doctor legitimately needs most of what's on the
record (contact info, blood group, date of birth) for care purposes. Didn't invent
additional per-field restrictions without a clearer signal of what's genuinely
over-exposed to a legitimate treating relationship — noting this as a reviewed, deliberate
non-change rather than an unconsidered gap.

---

## 5. What this pass deliberately did not do

- **No prescription versioning/correction** (the plan's target model:
  `ISSUED → CORRECTED`, creating a new linked version while the original stays intact).
  `Prescription.isFullfilled`/`isArchived` remain simple booleans, and
  `updatePrescriptionAndAppointment` still edits in place. Building real versioning means
  a schema change (a self-referential "supersedes" link or a separate version table) and
  deciding what "the current version" means for every reader of prescription data across
  the app — a bigger, more consequential change than the time remaining in this pass
  could responsibly cover on top of the critical bug fix in §1. Flagged clearly as
  unbuilt rather than silently skipped.
- **No Invoice ownership enforcement beyond what Payment already has.** There's still no
  real `Invoice` entity (Pass 1's Gap G7, owned by Pass 14) — nothing new to enforce
  ownership on yet.
- **No patient-initiated account deletion.** See §3 — Pass 24's job.
