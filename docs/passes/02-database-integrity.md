# Pass 2 — Database Integrity

Status: **Complete**

Scope: `api/prisma/schema.prisma` (schema changes) + one 4-line fix in
`favourites.service.ts` (the minimum application-code change needed to make one of the
schema fixes actually take effect). No other code touched. No stack change — still
PostgreSQL + Prisma.

**Important limitation, read first:** this sandbox has no network access to
`binaries.prisma.sh`, so `prisma generate`, `prisma validate`, and `prisma migrate` could
not be run here — confirmed by directly testing `npx prisma validate`, which fails on
downloading the schema-engine binary (403), independent of anything in this schema. The
schema below was hand-authored and hand-reviewed against the actual current service-layer
code (not guessed), but **you must run the commands in §6 in your own environment before
trusting this in production.**

---

## 1. Referential integrity fixes

### 1.1 `Appointments.doctorId` — made required (was optional)

Every code path that creates an appointment already resolves a real doctor before
calling `.create()` — `createAppointment` throws `NOT_FOUND` if the doctor doesn't exist,
and `createAppointmentByUnAuthenticateUser` falls back to `config.defaultAdminDoctor`.
The schema now matches actual behavior. Closes Gap G2 (partially — `patientId` stays
optional; that's legitimate guest-checkout design, not a gap; see Pass 1).

### 1.2 `Favourites` — fixed the "one favourite per doctor, system-wide" bug (Gap G4)

This was a real, live bug, not a theoretical one. The old schema had
`doctorId String @unique`, and `favourites.service.ts` checked for an existing favourite
with `findFirst({ where: { doctorId } })` — no `patientId` in the filter. Net effect: the
first patient to favourite a doctor made that doctor permanently un-favouritable by every
other patient (`"AllReady doctor is Favourite !!"` for everyone else, forever).

Fixed both sides together — they only work as a pair:
- **Schema:** replaced `doctorId @unique` with `@@unique([patientId, doctorId])`, and made
  `patientId` required (a favourite with no owning patient was never valid).
- **Code:** `favourites.service.ts` — both `createFavourite`'s duplicate-check and
  `removeFavourite`'s lookup now filter by `doctorId` **and** `patientId`. Without this
  change, the schema fix alone would have just changed the error into a generic unique-
  constraint violation instead of fixing the actual bug.

### 1.3 `Reviews.appointmentId` — added (nullable), closes Gap G3

A review can now be linked to the specific appointment that justifies it. Left nullable
because existing reviews predate this column and can't be backfilled automatically.
Requiring it for *new* reviews is an application-layer decision left to Pass 21 (review
moderation) — this pass only makes the link possible.

### 1.4 Explicit `onDelete` behavior on every relation

Previously, none of the relations declared an explicit referential action, which meant
deletion behavior was left to Prisma/Postgres defaults rather than a deliberate decision.
Now explicit everywhere:

| Relation | Action | Reasoning |
|---|---|---|
| `Appointments.doctor` | `Restrict` | Never silently orphan appointment history by deleting a doctor |
| `Appointments.patient` | `SetNull` | Already-optional by design; deleting a patient account detaches, doesn't destroy, appointment history |
| `Payment.appointment` | `Restrict` | Financial records are never silently cascaded away |
| `Prescription.doctor` / `.patient` / `.appointment` | `Restrict` | Medical/legal records — same reasoning |
| `Medicine.prescription` | `Cascade` | Medicine lines have no independent meaning without their prescription |
| `Reviews.doctor` / `.patient` | `Restrict` | Don't silently orphan review history |
| `Reviews.appointment` | `SetNull` | Optional link (see 1.3); losing the appointment shouldn't delete the review |
| `Favourites.doctor` / `.patient` | `Cascade` | Low-stakes preference data — fine to clean up automatically |
| `DoctorTimeSlot.doctor`, `ScheduleDay.doctorTimeSlot` | `Cascade` | Schedule templates are pure config owned by the doctor, not historical record |
| `Blogs.user` | `Restrict` | Don't silently orphan authored content |

**Behavior change worth knowing about:** three existing admin API routes —
`DELETE /appointments/:id`, and the doctor/patient account-deletion routes — will now
correctly **fail with a foreign-key error** if the target has any appointments, payments,
prescriptions, reviews, or (for doctors) blog posts attached, instead of silently
succeeding and orphaning that data. Checked the frontend: **none of these three routes
are currently called from any UI** (no delete-appointment, delete-doctor, or
delete-patient button exists anywhere in `src/`) — they're only reachable by a direct API
call today, so this closes a real hazard with zero live blast radius. If a genuine "admin
removes a doctor/patient/appointment" feature is needed later, it should be built as a
soft delete using the `deletedAt` columns added below (§2), not a restored hard delete.

---

## 2. Soft-delete scaffolding (schema only — not wired up yet)

Every hard `delete()` call in the codebase today (`doctor.service.ts`,
`patient.service.ts` / `patientService.ts`, `appointment.service.ts`,
`prescription.service.ts`, and others) permanently destroys the row. For anything with
medical or financial weight, that's the wrong default.

Added a nullable `deletedAt DateTime?` column to `Patient`, `Doctor`, `Appointments`, and
`Prescription` (Payment already covered — see §3). **This pass only adds the column.** No
service code was changed to actually use it — rewiring each hard `.delete()` call to an
`.update({ data: { deletedAt: new Date() } })`, and updating every read query to filter
`deletedAt: null`, is real behavioral surface that belongs to the pass that owns each
entity's lifecycle:

| Entity | Owning pass for soft-delete wiring |
|---|---|
| `Doctor` | Pass 10 — Doctor Lifecycle |
| `Patient` | Pass 12 — Patient Data & Medical Records |
| `Appointments` | Pass 8 — Appointment State Machine |
| `Prescription` | Pass 13 — Prescription & Treatment |
| `Payment` | Pass 14 — Invoice & Financial Records |

---

## 3. Payment — added timestamps

`Payment` had **no `createdAt`/`updatedAt` at all** — no way to tell when a payment was
recorded or last modified, which is a basic audit-trail gap for a financial record. Added
both, plus a `deletedAt` soft-delete column per §2. No change to the payment *logic*
itself (still no real status field, still no gateway) — that's Pass 7's job in full.

---

## 4. Indexes added

| Index | Reason |
|---|---|
| `Appointments(doctorId, scheduleDate)` | The booking flow, doctor dashboard, and admin dashboard all filter appointments by doctor + date; this was an unindexed scan before |
| `Appointments(status)` | Every dashboard filters/counts appointments by status |
| `AuditLog(entityType, entityId)`, `AuditLog(actorId)` | For Pass 22, added now alongside the table (see §5) |

Not added: individual indexes on plain foreign-key columns (`patientId`, `doctorId` on
most tables) — Prisma's PostgreSQL connector creates those automatically as part of the
FK constraint itself, so adding them explicitly would be redundant.

---

## 5. Scaffolding tables: `IdempotencyKey`, `AuditLog`

Pass 2's own scope explicitly lists "Idempotency records" and "Audit records" as
database-integrity concerns. Both tables are added now, **unused by any service code in
this pass** — no endpoint reads or writes them yet:

- `IdempotencyKey` (`key`, `response`, `statusCode`, `createdAt`) — first consumed by
  **Pass 6 — Booking Transaction** (correction: originally written here as "starting in
  Pass 20," which undersold it — Pass 6's own scope explicitly calls for booking-specific
  idempotency; Pass 20 stress-tests the pattern and extends it to other operations like
  webhooks and refunds once those exist). See `docs/passes/06-booking-transaction.md`.
- `AuditLog` (`actorId`, `actorRole`, `action`, `entityType`, `entityId`, `metadata`,
  `createdAt`) — will be consumed starting in **Pass 22 — Audit & Observability**.

Defining the shape now means passes 3–21 can be written idempotency/audit-aware from the
start (writing to a table that already exists) instead of every mutating endpoint needing
a retrofit later.

---

## 6. What you need to run before this is live

This could not be validated in the sandbox (see limitation notice at top). In your own
environment, with `DATABASE_URL` pointed at a real (ideally non-production first)
Postgres instance:

```bash
cd api
npx prisma format          # normalizes formatting, catches basic syntax errors
npx prisma validate        # confirms the schema is internally consistent
npx prisma migrate dev --name pass2-database-integrity
```

`migrate dev` will generate the actual SQL migration and apply it. Review the generated
SQL before running it against production data — in particular, confirm your existing data
has no `Appointments` rows with a null `doctorId` (there shouldn't be any, per §1.1's
analysis of the code, but real data can surprise you) and no `Favourites` rows that would
collide under the new `(patientId, doctorId)` uniqueness — both would cause the migration
to fail outright rather than silently corrupt anything, so failure here is safe, just
needs a look.

---

## 7. What this pass deliberately did *not* do

- **`Auth.userId` was not converted to a real foreign key** (Gap G1 from Pass 1). It's a
  polymorphic reference (points to `Patient.id` or `Doctor.id` depending on `role`), and
  it's embedded directly into every issued JWT. Fixing it properly means changing the JWT
  payload shape, which cascades into every authenticated request across API *and*
  frontend, and invalidates every session currently in the wild. That's authentication
  surface, not database surface — deliberately deferred to Pass 3/4, documented in the
  schema itself so it isn't mistaken for an oversight later.
- No soft-delete call sites were rewired (see §2 — schema only).
- No idempotency or audit logic was wired to the new scaffolding tables (see §5).
- `Appointment.status`, `paymentStatus`, and `prescriptionStatus` were left exactly as
  they are — converting `status` to a real enum is Pass 8's job (it also needs the actual
  state-machine transition rules, not just a type change).
- No slot-level uniqueness constraint was added on `(doctorId, scheduleDate,
  scheduleTime)`. It was considered and rejected: `DoctorTimeSlot.maximumPatient` implies
  a single time slot can legitimately hold more than one appointment (batch/group slots),
  so a strict uniqueness constraint here would be *incorrect*, not just incomplete. Real
  capacity-aware slot reservation is Pass 5's job.
