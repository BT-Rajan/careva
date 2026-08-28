# Pass 22 — Audit & Observability

Status: **Complete**

Scope: new `api/src/app/modules/audit-log/` module (`.service.ts`, `.controller.ts`,
`.route.ts`), `api/src/app/routes/index.ts`, `api/src/shared/logger.ts`, `api/src/app.ts`,
`api/src/server.ts`, `api/src/app/modules/auth/auth.service.ts`. No schema change. No
stack change (winston/winston-daily-rotate-file were already dependencies, unused).

---

## 1. An audit trail nobody could read

Passes 8 through 21 have all faithfully written to `AuditLog` on every significant
state change — appointment transitions, doctor approval decisions, prescription
corrections, invoice lifecycle, notification dispatch, payment reconciliation, review
moderation. Before this pass, **nothing anywhere could read any of it back** — no
route, no service function, not even an internal script ever called
`auditLog.findMany`. An audit trail that cannot be queried isn't serving the purpose an
audit trail exists for.

New `audit-log` module, admin-only:

- `GET /audit-log` — filterable (`entityType`, `entityId`, `actorId`, `action`,
  `from`/`to` date range), paginated. `limit` is capped at 200 server-side, not just
  defaulted — this table is append-only by every other pass's design and expected to
  grow indefinitely, so an unbounded client-supplied limit could turn one request into
  a full table scan.
- `GET /audit-log/:entityType/:entityId` — a focused shortcut for the single most
  common real investigation ("show me everything that ever happened to this one
  appointment/payment/doctor"), equivalent to the filtered query above but not
  requiring the caller to know `AuditLog`'s query-param names — reads naturally from an
  entity's own admin detail view.

## 2. A fully-configured logger that was never actually used

`winston` and `winston-daily-rotate-file` have been dependencies since before this
pass, and `shared/logger.ts` had a complete, working `logger`/`errorlogger` setup —
disk-persisted, daily-rotated, 14-day retention — but grep confirms it was never
imported anywhere else in the codebase. Every error this API has ever produced,
including the crash diagnostics Pass 18 specifically fixed to be captured at all, went
to `console.error`/`console.log` only: gone the moment stdout scrolled away or the
process restarted. The label baked into every log line was `"PH"` — leftover,
uncustomized branding from whatever starter template this project began from, the same
class of dead boilerplate Pass 17 found in two entirely-commented-out Mongoose error
handlers.

Relabeled to `"Careva"` and wired `errorlogger` into the two highest-value chokepoints:

- **`app.ts`'s global error handler** — every error that reaches this point, across
  every route in the entire API, is now persisted to a rotated log file, not just
  printed to a console that may not be watched or retained.
- **`server.ts`'s crash/shutdown handler** — the exact diagnostic trace Pass 18 fixed
  to stop being silently discarded now survives the process actually dying, which is
  the whole point of capturing it in the first place.

Left the many scattered informational `console.log` calls elsewhere in the codebase
(startup messages, routine shutdown steps, per-request operational logs in individual
service functions) as plain console output — lower forensic value than error paths,
and a full sweep-and-replace across 20+ files would be a large, low-margin change for
this pass to take on.

## 3. Two auth events that had no trace at all

Pass 3 built the failed-login counter and account lockout, but recorded only the
*current* count — which resets on the next success and carries no history. An admin
investigating "was this account targeted, and when" had literally nothing to look at
beyond a number that might already have been reset by the time anyone looked.

Added three audit events to `loginUser`: `auth.failed_login` (wrong password, account
not yet locked), `auth.account_locked` (the attempt that crossed the threshold), and
`auth.login_succeeded` (every successful login) — all attached to the `Auth` row via
`entityType: 'Auth'`, so `GET /audit-log/Auth/:authId` gives a complete login history
for one account, failed and successful attempts together (useful for spotting the
pattern of "several failures immediately before a success," a classic sign of a
correctly-guessed credential rather than a legitimate user mistyping their own
password).

## 4. What this pass deliberately did not do

- **No audit log for failed logins against a non-existent email.** This is a common
  account-enumeration attack pattern and arguably worth recording, but doing so
  requires deciding what to anchor the log row to (no `Auth` record exists to attach
  `entityId` to) and risks unbounded log growth from pure enumeration spam with no
  natural rate limit beyond the existing `loginRateLimiter`. Flagged as a deliberate
  omission, not a silent one — the two cases fixed (wrong password on a real account,
  successful login) are the highest-value, most actionable signals available without
  that added complexity.
- **No sweep-and-replace of `console.log`/`console.error` across the rest of the
  codebase.** See §2 — scoped to the two chokepoints with the clearest forensic value.
- **No structured/JSON log format, no correlation/request-ID middleware.** Real
  improvements, but a larger investment than "make the logger that already exists
  actually get used" — worth a dedicated future pass if deeper observability tooling
  (log aggregation, tracing) is ever adopted.
- **No UI for browsing the audit log.** This pass builds the API; an admin-dashboard
  page to browse/filter it visually is a natural next step, not built here.
