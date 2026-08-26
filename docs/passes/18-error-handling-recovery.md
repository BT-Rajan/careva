# Pass 18 — Error Handling & Recovery

Status: **Complete**

Scope: `api/src/server.ts`, `api/src/app.ts`, `api/src/helpers/uploadHelper.ts`. No
schema change, no stack change.

---

## 1. The process-level crash path was actively dangerous

`server.ts`'s `uncaughtException`/`unhandledRejection` handler had two bugs that
individually would each be bad, and together meant a crash left **zero trace of what
happened** and **no guarantee the process actually stopped**:

- Both handlers took no argument at all — `console.log('Handler Error')` — discarding
  the actual `Error`/rejection reason entirely. Whatever caused the crash was never
  logged anywhere.
- Neither ever called `process.exit()`. `server.close()` only stops accepting new
  connections; Node does not exit on its own until every open handle drains, which
  isn't guaranteed to happen promptly (or at all). A process manager or container
  orchestrator (PM2, systemd, Docker) relies on the process actually terminating to know
  to restart it — this could leave a corrupted, unresponsive process technically still
  "running" indefinitely after a crash.
- `SIGTERM` (what a container orchestrator sends on deploy/scale-down) had the same
  problem, plus no Prisma disconnect — in-flight database connections weren't closed
  cleanly on shutdown.

Rewrote as one `gracefulShutdown` path shared by both crash cases (`uncaughtException`/
`unhandledRejection`, exit code 1 — Node's own guidance is that a process must exit
after either, since its internal state is no longer trustworthy) and clean termination
(`SIGTERM`/`SIGINT`, exit code 0): logs the actual error, closes the HTTP server,
disconnects Prisma, and calls `process.exit()` with a correct code — with a 10-second
force-exit fallback so a shutdown that hangs (e.g. a slow client keeping a connection
open) can't block a deploy indefinitely.

## 2. The global error handler didn't distinguish infra failure from a real bug

Pass 17 taught the global handler to recognize `ZodError` and
`Prisma.PrismaClientKnownRequestError` (the database responded, just with a
client-input-shaped problem like a unique-constraint violation). This pass adds
`Prisma.PrismaClientInitializationError` — thrown when Prisma couldn't reach the
database **at all**. That's a transient infrastructure condition, not anything about
the request and not a bug in this codebase, and deserves a distinct 503 telling the
client retrying is worthwhile — not the same generic 500 an actual programming error
would produce. Previously both were indistinguishable, both to whoever reads the logs
and to any client trying to decide whether to retry.

## 3. External-service failures weren't classified either

`uploadHelper.ts`'s `uploadFile` (used by all four of doctor/patient/blog profile-image
and blog-cover-image uploads — none of the four call sites had their own try/catch)
had the same "everything looks like a 500" problem at a smaller scale:

- No file provided threw a bare `Error`, not an `ApiError` — a genuine client mistake
  (400) fell through to the generic fallback and came back as an opaque 500.
- A Cloudinary failure (network error, bad credentials, quota exceeded) rejected with
  whatever raw shape Cloudinary's own SDK returns — again, indistinguishable from an
  internal bug.

Now throws/rejects with a proper `ApiError` in both cases — 400 for "you didn't send a
file," 502 for "the upload service itself is unavailable, try again" — without any of
the four callers needing their own try/catch to get a sensible response.

## 4. What was checked and found already correct

- **`catchAsync` coverage across every controller** — confirmed complete. One
  apparent gap (`payment.controller.ts`) was a false positive from a grep blind spot
  (the factory-function pattern `(param) => catchAsync(...)` used by `webhook` and
  `telrReturn`) — both are, in fact, wrapped.
- **Every `NotificationService.dispatchNotification` call site** (7 across
  `appointment.service.ts`, `auth.service.ts`, `doctor.service.ts`) — all either
  `await`ed or `.catch()`-guarded, on top of `dispatchNotification` itself never
  throwing (Pass 16). No unhandled-rejection risk remains from any of Pass 16's work.
- **The payment webhook handler** (`payment.controller.ts`'s `webhook`) — already
  correctly wrapped in `catchAsync` and deliberately returns 200 for every outcome it
  has genuinely handled (including "already processed" and Telr's expected "ignored"),
  reserving a non-2xx response for real errors so the gateway's own retry logic fires
  only when it should. No changes needed — Pass 7 already got this right.
- **JWT verification** (`middlewares/auth.ts`) — already catches `jsonwebtoken`'s raw
  errors and converts them to a clean `ApiError(403, ...)`. No changes needed.
- **No un-awaited, un-caught async calls** found anywhere in `api/src/app/modules/**/*.service.ts`
  beyond the ones already covered above.

## 5. What this pass deliberately did not do

- **No health-check endpoint.** Adjacent to "recovery" in spirit, but this is
  operational/deployment tooling — better scoped to Pass 21 (Admin & Operational
  Controls) or Pass 26 (Production Readiness) than invented here.
- **No retry/backoff logic for transient database errors.** Pass 20 (Concurrency &
  Idempotency) is the more natural home for automatic retry semantics; this pass
  focuses on classifying and responding to failures correctly, not automatically
  retrying them.
- **Did not remove the pre-existing dead `else` branches** in the four Cloudinary
  upload call sites (`if (uploadImage) {...} else { throw ... }` — the `else` was
  already unreachable before this pass, since `uploadFile` always either resolved with
  a real result or rejected, never resolved falsy). Harmless and cosmetic, not a
  correctness issue this pass exists to fix; left alone to avoid scope creep across
  four unrelated files' unrelated code paths.
