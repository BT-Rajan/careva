# Pass 21 — Admin & Operational Controls

Status: **Complete**

Scope: `api/prisma/schema.prisma` (`ReviewStatus` enum + `Reviews.status`), new
`api/src/app/modules/reviews/review-lifecycle.ts`,
`api/src/app/modules/reviews/reviews.{service,controller,route}.ts`,
`api/src/app/modules/payment/payment.{service,controller,route}.ts` (reconciliation
queue), `api/src/app.ts` (health check), and frontend:
`src/redux/api/reviewsApi.js`, `src/components/Admin/Reviews/Reviews.jsx`. Schema
change: yes. No stack change.

---

## 1. Review moderation — closing Gap G8

Every review was created and immediately, permanently visible everywhere with no
moderation step at all — Gap G8 in the domain model, explicitly owned by this pass.
Added a real `ReviewStatus` lifecycle (`SUBMITTED → PUBLISHED`, with `FLAGGED`/`REMOVED`
as admin-moderation states — target model §4.6) via `review-lifecycle.ts`, following
the same transition-graph pattern as prescription/invoice/doctor. Every transition is
admin-only — unlike those other lifecycles, nothing in this graph is patient- or
doctor-triggered; there's no "report this review" feature anywhere in the app for an
end user to invoke, so that edge doesn't exist.

`REMOVED` is not fully terminal, unlike Invoice's `VOID` or Prescription's `CORRECTED`
— an admin restoring a review removed by mistake is a real, plausible moderation
action with no equivalent need on the financial/clinical-record side, so
`REMOVED → PUBLISHED` is a legal transition.

**The schema default is `PUBLISHED`, not `SUBMITTED`.** That default only governs what
an existing row (or one inserted out-of-band) becomes when this column is added — it's
what correctly grandfathers in every review that predates moderation, rather than
making every review on the platform vanish from every doctor's profile the instant
this migration runs. The real business rule — new reviews start unmoderated — is
enforced in `reviews.service.ts`'s `create`, which explicitly sets `status: 'SUBMITTED'`
on every new row, overriding the column default for the one path that matters.

**Visibility filtering, split by audience:**
- `getAllReviews` (public listing) and `getDoctorReviews` (a doctor's reviews, shown on
  their public profile) — filtered to `PUBLISHED` only, unconditionally.
- `getSingleReview` (public, by id) — filtered too: an unpublished review's id
  shouldn't become readable just because someone knows or guesses it.
- New `getAllReviewsForAdmin` (`GET /review/admin/all`) — the actual moderation queue,
  every status, admin-only. Same "public listing filters, `/admin/all` sees
  everything" convention Pass 10 established for doctors.

`getDoctorReviews` filters to `PUBLISHED` regardless of caller role, even though its
route allows both `DOCTOR` and `PATIENT` — its real use is a patient browsing a
doctor's profile before booking, which is exactly where showing unmoderated content
matters most. A doctor wanting visibility into their own pending/flagged reviews would
need a separate view; nothing in the current UI asks for that, so it wasn't built.
This filter also fixes a knock-on effect for free: `Doctor/Reviews/Reviews.jsx`
computes a doctor's displayed average rating client-side directly from this same
endpoint's data, so an unmoderated or since-removed review can no longer skew a
doctor's public rating either.

## 2. Gap G3 — partially addressed, not silently, not fully

Pass 2 left "require `appointmentId` on new reviews" as an explicit application-layer
decision for this pass. Found that the only real review-creation UI
(`Doctor/DoctorProfile/Review.jsx`, reachable from any doctor's public profile) has
never collected or sent one — there's no "which of your appointments is this about"
picker anywhere in this app. Requiring it outright would break every real review
submission with no corresponding frontend fix, which is a larger feature (building that
picker) than this pass's actual charter. What **is** enforced now: if an
`appointmentId` is supplied (by a future frontend, or a direct API caller), it must
actually belong to the reviewing patient and the reviewed doctor — closing the spoofing
gap without requiring a capability the app doesn't have yet. Flagged here as a
deliberate partial fix, not a silent one.

## 3. Two real, pre-existing bugs found while touching the admin Reviews page

`Admin/Reviews/Reviews.jsx` was the natural place to wire the new moderation actions
into — and while doing that:

- **`reviewsApi.js`'s `deleteReview`/`updateReview` were defined as `build.query`**
  despite being DELETE/PATCH actions — the same misclassification Pass 13 found and
  fixed for prescriptions. A `build.query` endpoint auto-fetches on
  mount/param-change; a delete or update firing itself just because a component
  rendered with an id in scope would be a serious bug. Never actually triggered in
  production because the one real call site — this page's delete handler — worked
  around it by never calling the generated hook at all: it was a stub
  (`message.info('Delete review API needs proper implementation')`) with the
  mutation hook imported but unused. Converted both to `build.mutation` and wired the
  real handler.
- **The page's "Status" column never showed a moderation status** (there wasn't one
  before this pass) — it actually showed whether the doctor had replied
  ("Replied"/"Pending"), mislabeled. Split into two honestly-labeled columns:
  "Moderation" (the real `ReviewStatus`, with publish/flag/remove actions) and "Doctor
  Reply" (the original reply-presence indicator, kept, correctly labeled).

## 4. Health-check endpoint

`GET /health`, mounted at the bare root rather than under `/api/v1` — an
orchestrator's health check (Docker, Kubernetes, a load balancer) shouldn't need to
know this API's versioning scheme just to ask "are you up." Checks real database
connectivity (`SELECT 1`), not merely "the Node process is running" — a process that's
up but can't reach Postgres should report unhealthy, since it can't actually serve any
real request. Pass 18 already classifies a live Prisma connection failure as a 503 in
the global error handler; this does the equivalent check proactively rather than
waiting for a real request to reveal it.

## 5. Payment reconciliation queue — closing Pass 20's flagged gap

`PaymentStatus.UNKNOWN_RECONCILING` (added in Pass 7, first actually triggered by Pass
20's optimistic-concurrency check on concurrent refunds) had no admin-facing way to see
or resolve payments stuck in it — a comment in the code pointed to a `reconcilePayment`
function that was never built. Added `GET /payment/reconciliation` (admin, lists every
payment awaiting reconciliation) and `PATCH /payment/:paymentId/resolve-reconciliation`
(admin, sets the true final status — `SUCCEEDED`/`FAILED`/`REFUNDED`/
`PARTIALLY_REFUNDED` — with a required note). Deliberately human-in-the-loop: an admin
checks the payment gateway's own dashboard directly to see what actually happened, then
tells this app the true state. Building real automated reconciliation (polling the
gateway's API to resolve these without a human) is a larger feature this pass does not
attempt.

## 6. What this pass deliberately did not do

- **No "report this review" feature for end users.** Nothing in the current UI has a
  button for this; `FLAGGED` is reachable only through admin moderation. Documented in
  `review-lifecycle.ts` as a natural place a future reporting feature would land, not
  retrofitted onto this pass.
- **No frontend UI for selecting which appointment a review is about**, and
  `appointmentId` is therefore still optional on review creation — see §2.
- **No automated payment reconciliation** — see §5.
