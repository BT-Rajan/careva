# Pass 16 — Notifications

Status: **Complete**

Scope: `api/prisma/schema.prisma` (new `Notification` model + `NotificationChannel`/
`NotificationStatus` enums), new `api/src/app/modules/notification/` module
(`.service.ts`, `.controller.ts`, `.route.ts`), new `api/template/doctorStatus.html`,
wiring changes in `api/src/app/modules/appointment/appointment.service.ts`,
`api/src/app/modules/doctor/doctor.service.ts`, `api/src/app/modules/auth/auth.service.ts`,
and `api/src/app/routes/index.ts`. Schema change: yes. No stack change.

---

## 1. What was actually wrong

Six places in this codebase sent email via a bare `EmailtTransporter(...)` call, with
zero persisted record of whether the send ever succeeded. Every prior pass that touched
one of them (Pass 6, 8, 9, 10) explicitly named this as deferred to Pass 16 rather than
fixed in place. Auditing all six found two distinct problems, not one:

**Three were genuine crash risks, not just untracked** — `await`ed inside a
`try { ... } catch { throw new ApiError(...) }` block:
- `doctor.service.ts`'s `sendVerificationEmail`, called *after* the doctor's account
  transaction had already committed — a flaky mail provider would fail the entire
  registration request even though the account already existed.
- `auth.service.ts`'s reset-password email — the worse of the two, because this one ran
  **inside its own `$transaction`**. A transient email failure would roll back the
  `ForgotPassword` row the same transaction had just created, so the request would 500
  despite a perfectly valid reset token having been ready to issue.
- (The third crash risk, `doctor.service.ts`'s approval-status email, was already fixed
  to be `.catch()`-guarded before this pass — it only needed the tracking half, not the
  safety half.)

**The other three were already safely non-blocking** (Pass 6/9's `.catch()` convention)
but left no trace beyond a console line if they silently failed, and — a separate,
real bug found while retrofitting them — **two sent to two different people as one
comma-joined `To:` address** (`` `${patientEmail},${doctorEmail}` ``): both parties could
see each other's email address in the same header, and there was no way to tell "did
the patient's copy arrive" apart from "did the doctor's."

## 2. The `Notification` model

Persisted, queryable delivery tracking: `recipientId` (polymorphic, nullable for guest
bookings with no account row — same convention as `Auth.userId`), `recipientRole`,
`recipientEmail` (snapshotted at send time, not joined live), `event` (a stable key like
`appointment.scheduled`, not a freeform description), `status`
(`PENDING`/`SENT`/`FAILED`), `attempts`, `lastError`, `sentAt`, and
`relatedEntityType`/`relatedEntityId` (same pattern as `AuditLog`). `templatePath` and
`templateData` are stored on the row itself so a retry can resend the exact original
content without the caller reconstructing the render context.

**Multi-channel-ready, not multi-channel-built.** `channel` is a field and
`NotificationChannel` is an enum with exactly one member (`EMAIL`) — this app has one
real delivery mechanism (Gmail SMTP via `nodemailer`) and zero SMS/push provider
integration anywhere in the codebase. Modeling channel as an open enum costs nothing now
and means adding a real channel later is a new enum value and a new sender, not a
migration. Building a fake SMS/push integration with no real provider behind it would
have been invented scope, not multi-channel support.

## 3. `dispatchNotification` — the actual fix

`notification.service.ts`'s `dispatchNotification` is the one guarantee every fix in
this pass depends on: **it cannot propagate an exception to its caller**, regardless of
whether the caller `await`s it or fires it and walks away. Both halves — the initial
`Notification` row write and the send attempt itself — are wrapped in their own
try/catch, because the original bug (`doctor.service.ts`, `auth.service.ts`) was
specifically that the persistence-adjacent code path could throw. A failure anywhere
in this function degrades to a `FAILED` (or, if even the tracking write fails, an
unrecorded) notification — never a failed caller request.

`retryNotification` is admin-triggered only — resending a `FAILED` notification on a
schedule automatically is Pass 23's job (Background Jobs); this pass builds the data
model and the manual "try again" action a future automated retrier would call, not the
scheduler itself.

## 4. What got retrofitted

- **`doctor.service.ts`**: both email call sites now go through `dispatchNotification`.
  The verification email's crash risk is gone (see §1). The approval-status email gets
  a **dedicated template** (`doctorStatus.html`) — Pass 10 explicitly flagged reusing
  `appointment.html` for this as "visually an appointment template repurposed for an
  account-status message" and named a proper template as Pass 16's job.
- **`auth.service.ts`**: the reset-password email now runs **after** its transaction
  commits, not inside it — token issuance and email delivery are no longer coupled to
  each other's success.
- **`appointment.service.ts`**: all three email-producing paths (authenticated booking
  confirmation, guest booking confirmation, the shared cancel/reschedule notice
  function) go through `dispatchNotification`. The two combined-recipient sends
  (booking confirmation, cancel/reschedule) are now split into one dispatch per
  recipient, matching `Notification`'s one-row-per-recipient model and fixing the
  shared-`To:`-header issue in the same change.

## 5. What this pass deliberately did not do

- **No automated retry / scheduled re-send of `FAILED` notifications.** That's Pass 23
  (Background Jobs). This pass ships the data model and the admin-manual retry action;
  a future cron-style retrier is new code that calls the same `attemptSend` path, not a
  redesign.
- **No SMS or push channel actually implemented** — see §2. `NotificationChannel`
  exists specifically so this is additive later, not a redesign.
- **No patient/doctor self-service notification history.** `GET /notification` is
  admin-only in this pass — an operational/support view, not a "your notifications"
  inbox for end users. Worth adding later; not built here to keep this pass to the
  scope every prior pass actually named (fix the six existing sends, build the tracking
  model they should have used from the start).
- **No notifications added for events that never sent email before** (invoice
  issued/paid/voided — Pass 14; prescription fulfilled/corrected/archived — Pass 13).
  These weren't named as gaps by any prior pass the way the six email call sites were;
  extending `dispatchNotification` to cover them is a natural next step this
  infrastructure now makes easy, but adding it wasn't this pass's charter and risked
  turning a scoped fix into an open-ended feature build.
