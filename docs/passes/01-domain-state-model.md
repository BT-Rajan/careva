# Pass 1 — Domain & State Model

Status: **Complete** (specification only — no code changed in this pass)

This is the authoritative domain/state specification for Careva. It is grounded in the
**actual current implementation** (schema + code as of this pass), not an idealized
rewrite. Where the current implementation diverges from what a production system needs,
that is called out explicitly as a **gap**, to be closed in the pass that owns it. No
schema or code changes happen until that owning pass.

---

## 1. Entities

| Entity | Table | Represents |
|---|---|---|
| `Auth` | `Auth` | Login identity: email + password + `role` (`admin` \| `patient` \| `doctor`) + `isDemo` flag |
| `Patient` | `Patient` | Patient profile |
| `Doctor` | `Doctor` | Doctor profile |
| `Appointments` | `Appointments` | A booking between a patient and a doctor |
| `Payment` | `Payment` | Payment record attached to one appointment |
| `Prescription` | `Prescription` | Treatment record attached to one appointment |
| `Medicine` | `Medicine` | Line item belonging to one prescription |
| `Reviews` | `Reviews` | Patient review of a doctor |
| `Favourites` | `Favourites` | Patient's saved/favourited doctor |
| `DoctorTimeSlot` / `ScheduleDay` | same | Doctor's recurring weekly availability |
| `Blogs` | `Blogs` | Doctor-authored blog post |
| `UserVerfication` / `ForgotPassword` | same | Time-limited tokens for email verification / password reset |

**Admin** is not a separate table — it is `Auth.role = 'admin'` with no corresponding
profile entity. `isDemo` marks a read-only demo admin account.

---

## 2. Ownership relationships

| Resource | Owned by | Notes |
|---|---|---|
| `Patient` profile | the patient (via `Auth.userId`) | `Auth.userId` is a plain string, **not** a foreign key today (Gap G1) |
| `Doctor` profile | the doctor (via `Auth.userId`) | same as above |
| `Appointments` | the patient (`patientId`, nullable) and the doctor (`doctorId`, nullable) | both FKs are **optional** — an appointment can exist with no linked doctor or patient record (Gap G2) |
| `Payment` | the appointment (`appointmentId`, required) | 1 appointment → many payment rows possible; nothing currently prevents duplicates |
| `Prescription` | doctor + patient + appointment (all required) | |
| `Medicine` | its `Prescription` (required) | |
| `Reviews` | doctor + patient (both required) | no link back to a specific appointment (Gap G3 — can't verify the review is from a real visit) |
| `Favourites` | intended: patient → doctor (many-to-many) | `doctorId` is marked `@unique`, meaning **only one favourite row can exist per doctor, system-wide** — this breaks multi-patient favouriting (Gap G4, see §5) |

Admins have cross-cutting read/manage access to all of the above. A demo admin
(`isDemo = true`) is intended to be **read-only** — enforcement of that is Pass 4's
responsibility, not verified yet.

---

## 3. Current (as-implemented) state fields

These are the fields that exist today, and the values actually observed in the codebase
(frontend + backend), not just what the schema declares.

### 3.1 Doctor — `verified: Boolean` (default `false`)

Binary only. Set by an admin toggle. No richer lifecycle (no "pending", "rejected",
"suspended" states exist today).

### 3.2 Appointment — `status: String?` (default `"pending"`)

**Not an enum — a free-text column.** Values actually written/read across the codebase:

| Value | Set by | Where |
|---|---|---|
| `"pending"` | system, at creation | `appointment.service.ts` |
| `"scheduled"` | doctor, via "Accept" button | `Doctor/Appointments/Appointments.jsx` |
| `"cancel"` | doctor, via "Cancel" button | same file — note: **not** `"cancelled"` |
| `"Completed"` | — | referenced in filters/dashboards/stat cards in 4 files, but **no code path anywhere sets it**. It is dead/unreachable today (Gap G5). |

Because this column is an unconstrained string, nothing stops any other value from being
written by a future bug (typo-status = orphaned record, invisible to every filter that
checks for `'Completed'` vs `'completed'`).

### 3.3 Appointment — `paymentStatus: paymentStatus?` (`paid` \| `unpaid`, default `unpaid`)

Set to `paid` **unconditionally at appointment-creation time**, before any real payment
gateway involvement — there is no payment gateway integrated today. This field currently
means "an appointment was created", not "money was received" (Gap G6 — owned by Pass 7).

### 3.4 Appointment — `prescriptionStatus: prescriptionStatus?` (`issued` \| `notIssued`, default `notIssued`)

Flipped when a doctor completes a treatment/prescription flow. Behaves consistently.

### 3.5 Prescription — `isFullfilled: Boolean`, `isArchived: Boolean`

Two independent booleans with no declared relationship between them (e.g. can a
prescription be archived without being fulfilled? Today: yes, nothing prevents it).

### 3.6 Payment — no status field at all

`Payment` is a flat record (`DoctorFee`, `bookingFee`, `vat`, `totalAmount`,
`paymentMethod`, `paymentType`) with no `status`. It represents "a payment happened", not
a lifecycle. There is also no `Invoice` entity — the frontend `BookingInvoice` component
renders an invoice view from `Appointment` + `Payment` data on the fly; nothing is
persisted as an immutable financial document (Gap G7 — owned by Pass 14).

### 3.7 Reviews — no status field

Created and immediately visible. No moderation/flagging state (Gap G8 — owned by
Pass 21).

---

## 4. Target state machines (to be implemented pass-by-pass — not built yet)

These are the **target** models later passes will implement. Writing them down now so
every later pass builds toward the same shape instead of improvising independently.

### 4.1 Doctor lifecycle (target — owned by Pass 10)

```
Registered → EmailVerified → ProfileComplete → PendingApproval → Approved → Active → Bookable
                                                       ↓
                                                   Rejected

Active → Suspended → Reactivated → Active
Active → Deactivated
```

Migration note: today's single `verified: Boolean` maps onto `Approved`/`Active`. Pass 10
replaces the boolean with a proper enum; until then, `verified = true` is read as
"Approved and Active" everywhere.

### 4.2 Appointment lifecycle (target — owned by Pass 8)

```
PENDING → SCHEDULED → COMPLETED
   ↓          ↓  ↓
DECLINED   CANCELLED_BY_PATIENT / CANCELLED_BY_DOCTOR / CANCELLED_BY_ADMIN
   ↓          ↓
EXPIRED    NO_SHOW
```

Legacy string mapping: `"pending"` → `PENDING`, `"scheduled"` → `SCHEDULED`,
`"cancel"` → `CANCELLED_BY_DOCTOR` (best-effort — the actor was never actually recorded
historically), `"Completed"` → `COMPLETED` (currently unreachable, becomes reachable once
Pass 8 adds a real "mark complete" transition).

### 4.3 Payment lifecycle (target — owned by Pass 7)

```
INTENT_CREATED → PENDING → PROCESSING → SUCCEEDED
                                ↓            ↓
                             FAILED      REFUNDED / PARTIALLY_REFUNDED
                                ↓
                            CANCELLED / EXPIRED

(any state) → UNKNOWN_RECONCILING   (webhook/gateway disagreement — never silently resolved)
```

Today's `paid`/`unpaid` enum is a placeholder with no real gateway behind it. Pass 7 owns
replacing it.

### 4.4 Prescription lifecycle (target — owned by Pass 13)

```
DRAFT → ISSUED → FULFILLED
           ↓
       CORRECTED (creates a new linked version; original stays intact for audit)

ISSUED / FULFILLED → ARCHIVED   (visibility only — does not erase history)
```

### 4.5 Invoice lifecycle (target — owned by Pass 14)

No `Invoice` entity exists yet. Target: `Invoice` becomes its own persisted, immutable
record generated once an appointment reaches `SCHEDULED` (or `COMPLETED`, decision
deferred to Pass 14), linked 1:1 with `Payment`, with `DRAFT → ISSUED → PAID → VOID`
states. Corrections create a new invoice; existing ones are never edited in place.

### 4.6 Review lifecycle (target — owned by Pass 21)

`SUBMITTED → PUBLISHED`, with `FLAGGED` and `REMOVED` as admin-moderation states.

### 4.7 Schedule/slot model (target — owned by Pass 5)

Today, `DoctorTimeSlot`/`ScheduleDay` describe a doctor's **recurring weekly template**
(e.g. "Mondays 9–5"), but booking an `Appointment` just writes a free-text
`scheduleDate`/`scheduleTime` pair with **no foreign key to a slot, and no reservation or
locking mechanism**. Nothing in the database or application code today prevents two
appointments from being created for the same doctor at the same date/time. This is the
single most important gap in the system (Gap G9) and is the reason Pass 5 exists as its
own dedicated pass rather than being folded into Pass 6.

---

## 5. Gaps found while grounding this spec (carried forward, not fixed here)

| ID | Gap | Owning pass |
|---|---|---|
| G1 | `Auth.userId` is not a real foreign key to `Patient`/`Doctor` | Pass 2 |
| G2 | `Appointments.patientId` / `doctorId` are both optional — an appointment can float with no linked doctor | Pass 2 |
| G3 | `Reviews` has no link to the `Appointments` that justifies it | Pass 2 / Pass 21 |
| G4 | `Favourites.doctorId` is `@unique`, so only one favourite row can exist per doctor **system-wide**, breaking multi-patient favouriting | Pass 2 |
| G5 | Appointment status `"Completed"` is referenced in 4 frontend files but never actually set anywhere | Pass 8 |
| G6 | `paymentStatus` is set to `paid` at creation time regardless of real payment | Pass 7 |
| G7 | No persisted `Invoice` entity; "invoice" is a client-side render only | Pass 14 |
| G8 | Reviews have no moderation state | Pass 21 |
| G9 | No slot reservation/locking — concurrent double-booking is possible today | Pass 5 |

---

## 6. System invariants (target — enforced progressively across later passes)

1. An appointment slot can be booked by at most one appointment. *(Pass 5/6)*
2. `paymentStatus` becomes `paid` only after real gateway confirmation, never at creation
   time. *(Pass 7)*
3. Appointment status changes only happen through defined transitions in §4.2 — no
   arbitrary string writes. *(Pass 8)*
4. A patient can read/modify only their own records; a doctor only their own; enforced
   server-side, not just hidden in the UI. *(Pass 4)*
5. Financial records (`Payment`, future `Invoice`) are immutable once finalized;
   corrections create new records rather than overwriting. *(Pass 14)*
6. A doctor must be `Approved`/`Active` to be bookable. *(Pass 10/11)*
7. `isDemo` admin accounts can never perform mutating requests. *(Pass 4)*

## 7. Forbidden transitions (explicit)

- `COMPLETED → *` (any other appointment state) — a completed appointment is terminal;
  corrections happen via audited admin override only, never a plain status write.
- `CANCELLED_* → SCHEDULED` — a cancelled appointment is never resurrected; book a new one.
- `paymentStatus: paid → unpaid` outside of an explicit, audited refund flow.

---

## 8. What this pass did *not* do

- No schema changes.
- No enum additions.
- No code changes.
- No renaming of existing status strings (`"cancel"` stays `"cancel"` until Pass 8 owns
  the migration).

This document is the reference every later pass implements against.
