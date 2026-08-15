# Pass 8 — Appointment State Machine

Status: **Complete**

Scope: `api/prisma/schema.prisma` (enum + audit fields), new
`api/src/app/modules/appointment/appointment-state-machine.ts`,
`api/src/app/modules/appointment/appointment.service.ts` (both update paths rewired),
plus every frontend file that read or wrote the old free-text status strings — 6 files.
No stack change.

---

## 1. What existed before this pass

Pass 1 documented `Appointments.status` as an unconstrained `String?` with real values
`"pending"`, `"scheduled"`, `"cancel"`, and a dead `"Completed"` referenced in 4 files but
never actually set. This pass, while grounding the fix in the live frontend code,
confirmed the problem was worse than a single dead string:

- **Doctor Dashboard's Accept button sent the literal string `'accept'`** — which matched
  *nothing* anywhere else in the app. `Doctor/Appointments/Appointments.jsx`'s Accept
  button, for the exact same real-world action, sent `'scheduled'` instead. Two different
  frontend components producing two different literal values for one semantic action.
- **`'cancel'` was overloaded** to mean two different things depending on when it was
  used: rejecting a request that was never accepted, and cancelling one that already was
  — collapsed into a single ambiguous string with no record of which actually happened or
  who did it.
- **`COMPLETED` and a "no-show" outcome had no UI path to reach at all.** Nothing in the
  entire product could ever mark an appointment completed or a no-show — despite the
  admin dashboard displaying a "Completed" stat and filter that could never have anything
  in it.
- The admin status filter dropdown additionally offered `'confirmed'` and `'InProgress'`
  as filter options — values that, per a full-codebase grep, **no code path had ever
  written**. Pure dead UI.

None of this was theoretical — these are all things a real user would hit today.

---

## 2. The enum and the graph

`Appointments.status` is now `AppointmentStatus?` (was `String?`), matching Pass 1's
target model exactly:

```
PENDING → SCHEDULED → COMPLETED
   ↓          ↓  ↓
DECLINED   CANCELLED_BY_PATIENT / CANCELLED_BY_DOCTOR / CANCELLED_BY_ADMIN
   ↓          ↓
EXPIRED    NO_SHOW
```

`appointment-state-machine.ts` implements this as two things checked together for every
transition, via `assertValidAppointmentTransition(currentStatus, requestedStatus,
actorRole)`:

1. **Shape** — is `requestedStatus` even a legal next-state from `currentStatus`
   (`TRANSITIONS` map)? Every terminal state (`COMPLETED`, `DECLINED`, any `CANCELLED_*`,
   `NO_SHOW`, `EXPIRED`) has zero legal outgoing transitions — once there, an appointment
   stays there.
2. **Actor** — is the caller's role allowed to make *that specific* move
   (`TRANSITION_ACTORS`, keyed `"FROM->TO"`)? E.g. only a patient or admin can move
   `SCHEDULED → CANCELLED_BY_PATIENT`; only a doctor or admin can move
   `SCHEDULED → CANCELLED_BY_DOCTOR`; only an admin can move `SCHEDULED →
   CANCELLED_BY_ADMIN`.

The current status is always read fresh from the database inside the service function —
never trusted from the client — before either check runs.

**`EXPIRED` is modeled in the graph but has no actor wired up at all** — calling the
transition function with it throws regardless of role. It's reserved for a future
scheduled job (Pass 23 — Background Jobs) that sweeps stale `PENDING` requests nobody
actioned in time. Specifying the edge now means that job, when built, implements an
already-agreed transition instead of inventing one under time pressure later.

---

## 3. Wired into both places `status` can be written

- **`updateAppointment`** (the endpoint Pass 4 already restricted to owner-or-admin +
  `status`-only) now calls the validator before writing anything, and on success: sets
  `statusChangedAt`/`statusChangedBy` (from `reqUser`, not client-supplied), optionally
  `statusChangeReason` if the caller sends one, and writes an `AuditLog` row —
  **Pass 2 built that table two passes ago; this is its first real writer.**
- **`updateAppointmentByDoctor`** (confirmed unused by the frontend since Pass 4, but
  still a live route) gets the same validation when its payload includes a `status`
  change, for consistency — "no arbitrary status updates" applies to every route that can
  attempt one, not just the one currently exercised.

### Payment consequence — deliberately not touched here

The plan's per-transition checklist includes "payment consequence." This pass does
**not** trigger refunds or any payment-side effect on a cancellation transition. Refund
eligibility and calculation rules are explicitly Pass 9's job (Cancellation &
Rescheduling) — building that logic here would mean guessing a policy (full refund? partial? cutoff window?) that Pass 9 is specifically scoped to define properly.

---

## 4. Frontend: fixed the real bugs, not just relabeled strings

- **`DashboardPage.jsx`'s Accept/Cancel handler** — no longer sends the raw `type`
  parameter as the status. Accept now correctly resolves to `SCHEDULED`; Cancel now
  checks the appointment's *current* status to send `DECLINED` (if still pending) or
  `CANCELLED_BY_DOCTOR` (if already scheduled) — matching the same context-aware logic
  already present in the other Accept/Cancel pair.
- **`Doctor/Appointments/Appointments.jsx`** — the Cancel button for a `PENDING`
  appointment now correctly sends `DECLINED` (previously sent the ambiguous `'cancel'`).
  Added a new action block for `SCHEDULED` appointments — **Mark Completed, No-Show, and
  Cancel** — since before this pass there was no way to reach those states through the
  product at all.
- **Admin's per-row status `Select`** — now filtered to only offer transitions that are
  actually legal from the row's current status (mirrors the backend's admin-triggerable
  edges), and is fully disabled/read-only for rows already in a terminal state, instead
  of offering every status value regardless of whether the backend would accept it. The
  dead `'confirmed'`/`'InProgress'` options are gone.
- **Every dashboard stat/filter/color-map** across `Admin/Appointments/Appointments.jsx`,
  `Admin/Dashboard/Dashboard.jsx`, `Doctor/Appointments/Appointments.jsx`,
  `Doctor/Dashboard/Dashboard.jsx`, `Doctor/Dashboard/doctor/DashboardPage.jsx` updated to
  the real enum values — verified via a full-repo grep afterward that zero old-casing
  literals (`'pending'`, `'scheduled'`, `'cancel'`, `'Completed'`) remain anywhere in
  `src/` or `api/src/`.
- **Guest tracking page's status help text** (`src/constant/appointmentStatus.js`) — the
  `appointment` description map previously mixed a few real (lowercase) values with
  several that never corresponded to any actual data (`'FollowUp'`, `'Canceled'`,
  `'Follow-up Scheduled'`, `'archived'`, `'InProgress'`, `'confirmed'`). Replaced with one
  real, accurate description per actual enum value.
- **`TrackDetailPage.jsx`'s `statusTagColor`** needed no change — it already does
  case-insensitive substring matching (`.includes('cancel')`, etc.), which happens to
  work correctly against the new uppercase enum values without modification. Checked,
  not assumed.

---

## 5. Legacy-string migration mapping (for any existing production data)

If there's existing data using the old free-text values, here's the mapping this pass
assumes when converting the column to the new enum:

| Old value | New value | Note |
|---|---|---|
| `"pending"` (or `NULL`) | `PENDING` | matches the old and new defaults |
| `"scheduled"` | `SCHEDULED` | |
| `"cancel"` | `CANCELLED_BY_DOCTOR` | best-effort — the actor was never actually recorded historically (per Pass 1 §4.2), so this can't be perfectly reconstructed; `CANCELLED_BY_DOCTOR` was chosen since the only UI that ever wrote `'cancel'` was doctor-facing |
| `"Completed"` | `COMPLETED` | was dead/never-written prior to this pass, so this row should be empty for any real dataset |
| anything else | needs manual review | the column was unconstrained before this pass — don't assume only these four values exist |

---

## 6. What you need to run before this is live

Same as every schema-touching pass — no live Postgres in this sandbox:

```bash
cd api
npx prisma format && npx prisma validate
npx prisma migrate dev --name pass8-appointment-state-machine
```

Casting an existing `String` column to a new enum type is not automatic — review the
generated migration SQL carefully, and if there's real data in `status` today, write and
test a data migration using the mapping in §5 before applying this against production
data, not directly against it.

---

## 7. What this pass deliberately did *not* do

- **No automated `EXPIRED` sweep.** The transition is specified in the graph; the
  background job that actually triggers it is Pass 23's job.
- **No refund/payment-consequence automation on cancellation.** Pass 9's job — see §3.
- **No patient-facing cancellation UI.** Confirmed before starting this pass that none
  exists anywhere in `src/components/Patient` or `src/components/TrackAppointment` — the
  backend now correctly supports `CANCELLED_BY_PATIENT` as a legal, patient-authorized
  transition (via the existing `updateAppointment` endpoint), ready for Pass 9 to build
  UI against, but no new UI was added in this pass.
- **No notification wiring on transitions** (the plan's "notification" column in its
  per-transition checklist). Sending an email/message on status change is Pass 16's job
  (Notifications) — this pass only guarantees the state itself is trustworthy; what
  happens as a side effect of it changing is a separate concern.
