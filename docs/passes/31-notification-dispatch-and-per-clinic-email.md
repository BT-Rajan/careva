# Pass 31 — Notification dispatch clinicId + Per-Clinic Email

Status: **Both halves done on the backend. No frontend UI for a clinic to actually
enter its own Gmail credentials yet — the API exists, nothing calls it.**

---

## Part 1: Notification's 7 dispatch call sites

Pass 29 scoped Notification's admin endpoints but left this honest gap: none of the
places that actually call `dispatchNotification` populated `clinicId`, so every
notification had `clinicId = NULL` and only `super_admin` could see any of them.

All 7 now populate it:

| Call site | Source of clinicId |
|---|---|
| `doctor.service.ts` — signup verification email | `payload.clinicId` (the clinic the doctor is joining) |
| `doctor.service.ts` — approval-status-change email | the affiliation's own clinicId (already a required parameter) |
| `auth.service.ts` — password-reset email | `Auth.clinicId` directly — no extra lookup needed, it's been on that row since Pass 27/28 |
| `appointment.service.ts` — booking confirmation ×2 (patient/guest, doctor) | `appointment.clinicId` |
| `appointment.service.ts` — cancel/reschedule status email ×2 (shared helper) | `appointment.clinicId` |

One honest residual gap, not fixed: a **doctor's** password reset still gets
`clinicId = null`, because `Auth.clinicId` is deliberately never set for the `doctor`
role (a doctor's clinic scoping lives on `DoctorClinic`, not `Auth` — see Pass 27's
JWT table). Doctors are cross-clinic by design, so there's no single "right" clinic to
tag their own account-level notifications with. Left as null rather than guessing.

## Part 2: Per-clinic Gmail actually sending

This is the feature the person originally asked for back when this whole conversion
started ("per-client Gmail"). `Clinic.gmailAppEmail`/`gmailAppPassEnc` have existed as
schema columns since Pass 27; nothing read or wrote them until this pass.

- **`helpers/credentialCrypto.ts`** (new) — AES-256-GCM encrypt/decrypt, using a
  dedicated `CLINIC_CREDENTIAL_ENCRYPTION_KEY` env var. Deliberately a separate secret
  from the JWT signing key or Cloudinary secret — key separation, so a leak of one
  doesn't expose the others.
- **`helpers/Transporter.ts`** — `getTransporterForClinic(clinic)` builds (and caches)
  a nodemailer transporter using the clinic's own decrypted credentials, falling back
  to the platform-wide default `Transporter` when a clinic hasn't configured its own
  yet (every clinic today) or if decryption fails for any reason (fails safe to the
  default sender, not a hard failure — the recipient still gets their email).
- **`helpers/emailTransporter.ts`** — `EmailtTransporter` now takes an optional
  `clinic` param and sends "From" whichever address is actually authenticated,
  matching the transporter chosen (sending "from" an address you're not authenticated
  as is what gets flagged as spoofing by mail providers).
- **`notification.service.ts`'s `attemptSend`** — looks up the `Clinic` row by
  `clinicId` (when present) and threads its credentials through. `retryNotification`
  gets this for free, reading `clinicId` off the already-stored `Notification` row.
- **`PATCH /clinic/:id/email-settings`** (new) — the write side. Admin-only, scoped to
  the caller's own clinic (`super_admin` can target any clinic). Takes the plaintext
  app password over the wire and encrypts it before it ever reaches the database; the
  ciphertext is never selected back out of any response.

## What's NOT in this pass

- **No frontend settings page.** The API to set a clinic's Gmail credentials exists;
  no UI calls it. A clinic admin today has no way to actually use this feature yet.
- **No credential verification/test-send.** `updateEmailSettings` stores whatever it's
  given — if a clinic enters a wrong app password, they won't find out until the next
  real notification silently fails and falls back to the default sender (or genuinely
  fails, if decryption itself throws). A "send test email" endpoint would close this;
  not built here.
- **Image hosting** — still just schema columns, nothing reads/writes them. That's
  Pass 32, unchanged from the original plan.

## Compile/runtime risk

Same standing caveat, worth repeating given this pass adds a new crypto dependency
path: `credentialCrypto.ts` has never been run. If `CLINIC_CREDENTIAL_ENCRYPTION_KEY`
is missing or malformed, `updateEmailSettings` will throw at call time (by design —
see `getKey()`'s explicit checks) rather than silently storing plaintext or garbage,
but this has not been exercised against a real Node process in this sandbox.

## Next passes

- **Pass 32** — per-clinic image hosting (same credential-storage pattern as this
  pass's Gmail work).
- **Pass 33** — self-serve clinic signup + a real multi-clinic picker UI (Pass 30's
  `clinics[0]` shortcut) + a frontend settings page for this pass's email-credentials
  API + a test-send endpoint.
