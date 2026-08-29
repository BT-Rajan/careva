# Pass 23 — Background Jobs

Status: **Complete**

Scope: new `api/src/jobs/` (`index.ts`, `expireAppointments.job.ts`,
`expirePayments.job.ts`, `retryFailedNotifications.job.ts`),
`api/src/app/modules/appointment/appointment-state-machine.ts` (shape-only assertion),
`api/src/app/modules/notification/notification.service.ts` (batch retry function),
`api/src/server.ts`. New dependency: `node-cron` (+ `@types/node-cron`). No schema
change.

---

## 1. Three explicitly-flagged gaps, all with the same shape

Three separate prior passes each specified a transition or a retry mechanism, then
explicitly deferred the thing that actually *triggers* it to this pass:

- **Pass 8**: `EXPIRED` is a real edge in the appointment state machine's transition
  graph, with a comment reading almost verbatim "reserved for a future scheduled job...
  modeling it in the graph now means that job, when built, implements an already-agreed
  transition instead of inventing one under time pressure later."
- **Pass 7**: `PaymentStatus.EXPIRED` has existed since the payment system was built,
  but "if a patient abandons checkout, that Payment row sits in PENDING indefinitely
  today — no background job marks it EXPIRED."
- **Pass 16**: `Notification.status = FAILED` rows just sit there — "no automated
  retry / scheduled re-send... that's Pass 23's job. This pass builds the data model
  and the manual 'try again' action a future automated retrier would call."

All three needed the same thing: a scheduler. This app is a single Express process
with no separate worker/queue infrastructure (no Redis, no BullMQ) — added `node-cron`,
a minimal, dependency-free, in-process cron scheduler that matches the app's actual
deployment model rather than introducing infrastructure it doesn't otherwise need.
Started once from `server.ts`'s `bootstrap()`, after the HTTP server is listening.

## 2. Appointment expiry — an objective criterion, not an invented policy number

`expireAppointments.job.ts` sweeps every `PENDING` appointment every 15 minutes and
expires the ones whose scheduled date/time has already passed. Deliberately **not**
"expire after N hours of no response" — that would be inventing a business policy
number nothing in this app has ever specified. "The scheduled time already happened"
is an objective fact requiring no invented threshold: nobody can attend a slot that's
already in the past, regardless of how quickly or slowly a doctor would otherwise have
responded.

Required adding a shape-only assertion (`assertValidAppointmentTransitionShape`) to
`appointment-state-machine.ts` — the existing `assertValidAppointmentTransition`
deliberately has no actor entry at all for `PENDING→EXPIRED` (by design, per Pass 8's
own comment: "nothing here lets a human being trigger it directly"), so calling it from
this job would always throw regardless of what role was passed. Same split, same
reasoning, as `invoice-lifecycle.ts`'s existing `assertValidInvoiceTransitionShape` —
the job itself is the trust boundary, not a request actor.

Each expiry re-reads the appointment fresh inside its own transaction before writing —
something else (a doctor confirming or declining, a patient withdrawing) may have moved
it out of `PENDING` in the gap between the initial candidate scan and this job actually
getting to it, and that legitimate concurrent action must win, not be silently
overwritten by a stale sweep.

## 3. Payment expiry — a stated, conservative local policy

`expirePayments.job.ts` expires `PENDING`/`PROCESSING` payments older than 24 hours.
Unlike the appointment case, there's no equivalent objective fact to anchor this to (a
payment session has no analogous "already happened" moment) — 24 hours is a stated,
conservative abandonment threshold: long enough that a patient who stepped away
mid-checkout and came back later the same day isn't punished, short enough that a
genuinely abandoned session doesn't sit open forever. Uses the same optimistic
conditional `updateMany` pattern Pass 20 established for payment writes, rather than
building a dedicated payment lifecycle file for one background sweep — no such file
exists yet (Pass 20's own note: payment transitions are inline checks, not a separate
state machine), and inventing one now would be more scaffolding than this job needs.

## 4. Notification retry — capped, not infinite

`retryFailedNotifications.job.ts` runs every 10 minutes and calls a new
`NotificationService.retryFailedNotificationsBatch`, which retries every `FAILED`
notification with fewer than 5 recorded attempts. The cap matters: a permanently
broken recipient (a typo'd email, a mailbox that will never accept mail) must not be
retried forever — once a notification has failed 5 times, it stays `FAILED` for an
admin to find via Pass 22's audit-log/notification-listing endpoints, rather than the
job silently hammering a dead address on every run indefinitely.

## 5. Every job is doubly guarded against crashing the process

Both `errorlogger`-wrapped: an inner `try/catch` around each individual item (one
appointment or payment failing to expire shouldn't stop the rest of the batch), and an
outer `try/catch` around the entire job function (a failure reading the candidate list
itself — a transient DB blip — must not throw uncaught into `node-cron`'s scheduler,
which could otherwise trip `server.ts`'s `uncaughtException` handler and take the whole
process down over a background sweep, not a real request). Every failure is logged via
Pass 22's now-real `errorlogger`, not a `console.error` that vanishes on restart.

## 6. What this pass deliberately did not do

- **No automated payment gateway reconciliation.** Pass 21 already scoped this out as
  a larger feature (polling a gateway's API to resolve `UNKNOWN_RECONCILING` payments
  without a human) — this pass's payment job only handles simple time-based expiry, not
  reconciliation.
- **No job-run history/dashboard.** Each run logs a summary via the real logger; there
  is no persisted "job execution log" table or admin UI to browse past runs. Worth a
  follow-up if job reliability ever needs closer monitoring than log files provide.
- **No configurable schedule/thresholds via environment variables.** The three
  intervals (15/15/10 minutes) and the payment abandonment window (24 hours) are
  hardcoded constants with documented reasoning, not tunable per-deployment — simpler,
  and nothing about this app's current scale suggests per-environment tuning is needed
  yet.
