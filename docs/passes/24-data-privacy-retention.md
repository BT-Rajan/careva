# Pass 24 — Data Privacy & Retention

Status: **Complete**

Scope: `api/prisma/schema.prisma` (`Patient.piiScrubbed`),
`api/src/app/modules/patient/patient.{service,controller,route,validation}.ts`,
frontend: `src/redux/api/patientApi.js`,
`src/components/Doctor/ProfileSetting/PatientProfileSetting.jsx`. Schema change: yes.
No stack change.

---

## 1. The gap this pass closes

Pass 12 built patient soft-delete but deliberately kept it admin-only, naming a real
patient-initiated "delete my account" flow — with proper consent/confirmation UX — as
this pass's job to design and build.

## 2. Anonymization, not just deactivation — a genuinely different action

The admin path (`deletePatient`) sets `deletedAt` and leaves every field on the record
intact — correct for a reversible admin deactivation, but not a real answer to a
patient's own right-to-erasure request: the data is still sitting there, in full,
forever. At the same time, this app's own earlier passes established that
`Prescription` and `Invoice` records are **never hard-deleted** — they're medical and
legal records that must be retained. A patient's appointment/prescription/invoice
history references them by `patientId`; actually deleting the `Patient` row would
either cascade-orphan that legally-required history or require restructuring
foreign-key constraints across three other passes' work.

The standard resolution to "must erase personal data" vs. "must retain
financial/medical records" is anonymization: keep the row (so the historical
references stay valid and queryable), overwrite the actual personal information on it.
`deleteMyAccount` does exactly that — `firstName`/`lastName` become fixed placeholders,
`email` becomes a per-row unique placeholder (`Patient.email` is `@unique`, so a fixed
string would collide the second time anyone ever used this), and every other PII field
(`mobile`, `address`, `city`, `state`, `zipCode`, `country`, `dateOfBirth`,
`bloodGroup`, `gender`, `img`) is cleared. The `Auth` row is deleted (same as the admin
path already does). Nothing denormalizes patient PII anywhere else in this app —
appointments, prescriptions, invoices, and reviews all join the `Patient` row live via
`patientId`, never storing a name/email snapshot — so anonymizing this one row is
sufficient to scrub the patient's identity everywhere it would ever be displayed.

**New `Patient.piiScrubbed` flag** distinguishes this from an admin deactivation.
`reactivatePatient` now refuses to run against a scrubbed row — there's no real data
left to restore, only placeholders, so "reactivating" it would misleadingly suggest the
original account came back when it didn't. A patient wanting to return would need to
register a new account, same as Pass 12 already established for the admin-deletion
case.

## 3. Consent/confirmation UX

- **Backend**: requires the account's current password, re-verified via `bcrypt`
  against the live `Auth` record — standard security practice for a destructive,
  irreversible self-service action, and cheap protection against an unattended logged-in
  session being used to delete the account without its owner's knowledge.
- **Frontend**: added a "Danger Zone" section to the patient's profile settings page —
  a password field plus a button that opens a second, explicit confirmation dialog
  (Ant Design's `Modal.confirm`) describing what will happen (personal data removed,
  history retained anonymized, cannot be undone) before the request ever fires. On
  success, the frontend logs the user out and redirects to `/login` — their credentials
  no longer exist server-side, so there's nothing left for the session to authenticate
  against.

## 4. What was reviewed and found already correct, or reasonably out of scope

- **Historical `Notification.recipientEmail` snapshots are not scrubbed.** That field
  is explicitly documented (Pass 16) as "the actual address a send was attempted
  against, snapshotted at dispatch time" — a factual record of what happened, not a
  live reference to the patient's current contact info. Scrubbing it would misrepresent
  history the same way altering `Invoice`'s snapshotted charge amounts after a later
  refund would. Left alone as a reviewed, deliberate non-change.
- **No time-based automatic data purge / retention-period policy** (e.g. "auto-delete
  accounts inactive for N years"). Nothing in this app's domain model or any prior pass
  specifies a retention duration — inventing one would be exactly the kind of
  unrequested policy number Pass 23 was careful to avoid when designing its expiry
  jobs. This pass builds the *mechanism* for erasure (on request); a time-based
  auto-purge policy is a business decision for the product to make explicitly, not
  something to guess at here.
- **Doctor self-service account deletion was not built.** Pass 12's forward-reference
  and this pass's own charter are both specifically about *patient* data — a doctor
  account interacts with Pass 10's approval/suspension lifecycle in ways that would
  need their own dedicated consideration, and wasn't named as part of this pass's
  scope.
- **Real-time session invalidation on deletion is not solved** (a pre-existing,
  already-documented limitation — Pass 3/16 both note that this app's JWTs are
  stateless and the server cannot force-invalidate a token a client already holds).
  Deleting the `Auth` row means any subsequent request that looks up the patient
  record will correctly fail (most already filter `deletedAt: null` or check for
  existence), but a already-issued token remains technically verifiable until it
  naturally expires. Solving this fully would require a stateful session/token-
  blocklist store, which is the same "stack decision this pass does not make
  unilaterally" every prior pass touching this topic has deferred.
