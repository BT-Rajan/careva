# Pass 10 — Doctor Lifecycle

Status: **Complete**

Scope: `api/prisma/schema.prisma` (new enum + fields), new
`api/src/app/modules/doctor/doctor-lifecycle.ts`, `api/src/app/modules/doctor/doctor.{service,controller,route}.ts`,
`api/src/app/modules/auth/auth.service.ts` (login gate), `api/src/app/modules/appointment/appointment.service.ts`
(booking-eligibility check, both paths), `api/.env.example` not touched (no new
env vars), plus `src/redux/api/doctorApi.js` and three admin frontend files. No stack
change.

---

## 1. What existed before this pass — worse than a conflation

The plan frames this pass around separating concepts that get wrongly merged into one
flag. Checking the actual code turned up something more concrete than a naming problem:
`Doctor.verified` was the *only* status field that existed, and it was used for exactly
two things — gating login, and being flipped `true` by the email-verification link. It
never represented admin approval, because **there was no admin approval concept at all**.

Confirmed directly in the code before touching anything:

- `getAllDoctors` (the public doctor-search listing) had **no filter on any status field
  whatsoever** — a doctor who registered five minutes ago, whose profile no admin has
  ever looked at, was fully visible in patient-facing search.
- `createAppointment` and `createAppointmentByUnAuthenticateUser` (both booking paths)
  checked only that the doctor *existed* — never their standing. **A patient could book,
  and pay, an appointment with a doctor account nobody had ever reviewed.**
- The admin's own Doctors management page labeled the `verified` toggle "Active"/
  "Inactive" in the UI — actively telling the admin that flipping email-verification was
  the same thing as approving a doctor to practice on the platform.

This is exactly Pass 1's invariant #6 ("a doctor must be Approved/Active to be
bookable"), confirmed unenforced, not just underspecified.

---

## 2. The two concepts, now actually separate

- **`Doctor.verified`** (unchanged) — still means email verified, still the only thing
  that gates whether `verified === false` blocks login. Nothing about its behavior
  changed; the fix was making sure nothing else in the app treated it as more than that.
- **`Doctor.approvalStatus`** (new enum, `DoctorApprovalStatus`) — `PENDING_APPROVAL`
  (default for every new registration) → `APPROVED` / `REJECTED`, with `SUSPENDED` and
  `DEACTIVATED` reachable from `APPROVED` and reversible back to it. Full graph and
  per-transition actor authorization in `doctor-lifecycle.ts`, same pattern as Pass 8's
  appointment state machine (`TRANSITIONS` + `TRANSITION_ACTORS` +
  `assertValidDoctorApprovalTransition`).

A doctor can self-`DEACTIVATED`/reactivate their own account (going on leave, etc.);
only an admin can approve, reject, suspend, or lift a suspension.

---

## 3. "Profile Complete" already existed — reused it, didn't reinvent it

Found `src/utils/doctorProfileCompletion.js` already implements a real, six-field
completeness check, used to gate the doctor's own dashboard (`DoctorProfileCompletionGate.jsx`)
until required fields are filled. This was **client-side only** — nothing server-side
verified it, so an admin could technically approve an incomplete profile if the UI gate
were ever bypassed or if approval logic didn't check.

`getProfileCompleteness` in `doctor-lifecycle.ts` is a deliberate server-side port of the
exact same six checks (same field names, same 30-character biography threshold).
`updateApprovalStatus` blocks the `PENDING_APPROVAL → APPROVED` transition outright if
the profile is incomplete, returning the specific missing fields in the error.

**This duplication is flagged, not hidden**: there's no shared package between the
frontend and this Express backend to import the same function from, so if the frontend's
completeness rules ever change, `doctor-lifecycle.ts`'s copy needs to change with it.
Both files' comments point at each other.

---

## 4. Enforcement: booking, login, and public listing

- **Booking** (`appointment.service.ts`, both paths) — now rejects with a clear message
  if `doctor.approvalStatus !== 'APPROVED'`, checked immediately after confirming the
  doctor exists, before any slot-availability logic runs. This is the fix for the
  invariant-#6 gap in §1.
- **Login** (`auth.service.ts`) — `SUSPENDED`/`DEACTIVATED` now blocks login, checked
  separately from and in addition to the existing email-verification check.
  **Deliberately does not block `PENDING_APPROVAL` or `REJECTED`** — a doctor should
  still be able to log in to see their status and finish or fix their profile while
  awaiting or recovering from a review decision; only suspension/deactivation locks the
  account out entirely.
- **Public listing** (`getAllDoctors`) — now filters to `APPROVED` only by default. Took
  care not to break the admin's own review queue in the process (see §5).

---

## 5. Admin needs to see *everyone*, not just approved doctors

Filtering the public listing to `APPROVED` would have broken the admin's Doctors page,
which uses the exact same underlying query to show *every* doctor for review. Rather than
retrofit optional/conditional auth onto a route that's public by design, added a
genuinely separate, real `auth(AuthUser.ADMIN)`-gated route:
`GET /doctor/admin/all` (`getAllDoctorsForAdmin`, wrapping the same service function with
an `includeAllStatuses` flag). Registered before `GET /:id` so `"admin"` is never
captured as a doctor id. Three admin-context frontend files
(`Admin/Doctors/Doctors.jsx`, `Admin/Dashboard/Dashboard.jsx`,
`Admin/Specialites/Specialites.jsx`) switched to it; the five genuinely public-facing
callers (`SearchDoctor.jsx`, `OurDoctors.jsx`, `BookDoctor.jsx`, `SelectDoctor.jsx`,
`About.jsx`) were left calling the now-filtered public endpoint — correctly, since seeing
only approved doctors is exactly the fix those callers needed.

---

## 6. Admin UI: replaced the misleading toggle, didn't just relabel it

The "Status" column showing `verified` as an "Active"/"Inactive" `Switch` is gone,
replaced with a real approval-status `Tag` plus contextual action buttons (Approve/
Reject from `PENDING_APPROVAL`, Suspend from `APPROVED`, Reactivate from `SUSPENDED`/
`DEACTIVATED`, Re-open for review from `REJECTED`) — only the buttons valid from the
row's *current* status are shown, mirroring Pass 8's admin appointment-status dropdown
filtering. The email-verification toggle still exists (legitimate admin capability — e.g.
manually marking email verified if delivery failed) but is now its own clearly-labeled
column ("Email Verified"), not conflated with doctor standing.

`updateDoctor` (the generic profile-edit endpoint) now **unconditionally** strips
`approvalStatus` and its audit fields from the request body — even for admin callers —
forcing every approval change through `updateApprovalStatus`, which is the only path that
validates the transition graph and checks profile completeness. Same architectural
pattern as Pass 9's cancel-endpoint enforcement: not just updating the UI to call the
right endpoint, but making the wrong path structurally incapable of bypassing the checks.

---

## 7. What you need to do before this is live

```bash
cd api
npx prisma format && npx prisma validate
npx prisma migrate dev --name pass10-doctor-lifecycle
```

**Two things need manual attention on real data, not just the schema migration:**

1. Every existing doctor row will default to `approvalStatus = PENDING_APPROVAL` after
   this migration — including doctors who are already live, verified, and actively
   taking bookings today. **Every existing doctor needs to be explicitly set to
   `APPROVED`** (a one-time bulk update, e.g. `UPDATE "Doctor" SET "approvalStatus" =
   'APPROVED' WHERE verified = true;` as a starting point, reviewed against your actual
   data) or they'll all simultaneously become unbookable and invisible in search the
   moment this deploys.
2. `config.defaultAdminDoctor` (env var `DEFULT_ADMIN_DOCTOR` — the fallback doctor used
   for guest bookings that don't specify one) **must also be set to `APPROVED`**, or the
   guest-booking flow breaks entirely as of this pass.

---

## 8. What this pass deliberately did not do

- **No doctor-facing approval-status display** beyond the login-rejection message and the
  best-effort notification email. A dashboard banner showing "your account is pending
  review" would be a nice addition but wasn't built here — checked
  `DashboardSidebar.jsx`/`DoctorProfileCompletionGate.jsx`, neither currently reference
  approval status, so there's a clean spot to add it later without conflict.
- **No dedicated email template** — reused `template/appointment.html` (same file Pass
  6/9 already reuse for booking/cancellation notices) for approval/rejection/suspension
  emails. It renders acceptably since the template's fields are all optional, but it's
  visually an "appointment" template repurposed for an account-status message. A proper
  template is Pass 16's job (Notifications).
- **No automatic handling of a suspended/deactivated doctor's existing scheduled
  appointments.** Suspending a doctor does not auto-cancel their upcoming bookings —
  deliberately: that's a consequential decision (refund implications, patient
  notification) that should be a deliberate admin action, not an automatic side effect of
  a status change. Left as a known gap, not silently decided.
- **No "Bookable" as a separate stored/computed status distinct from Approved.** The plan
  lists `Active → Bookable` as a further step; considered adding a computed check for
  "has at least one configured schedule slot," but the existing slot-generation logic
  already naturally communicates "no available times" for an approved doctor with no
  schedule — adding a redundant stored status would risk drifting out of sync with the
  real schedule data for no real behavioral gain.
