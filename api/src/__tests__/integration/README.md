# Integration tests — not present here, and why

Pass 25 (Testing) added a real unit-test suite (`src/__tests__/unit/`) covering every
lifecycle state machine, the money/tracking-id utilities, and the Zod request-validation
schemas — all pure functions with no database dependency, and all genuinely run and
pass in this repository's CI/build environment.

**Service-layer and route-level integration tests are not included here.** Every
service function in this app (`*.service.ts`) is a thin-ish wrapper around Prisma calls
against a real Postgres database — the actual sandbox this pass was built in has no
database reachable at all (confirmed repeatedly across many prior passes: `prisma
generate`/`db push` cannot even reach `binaries.prisma.sh` to fetch engine binaries in
this environment, let alone connect to a live Postgres instance). Writing integration
tests that would need a real database, in an environment that has never had one, would
mean shipping test files that fail on every single run here — worse than not writing
them, because a red test suite that's *expected* to be red teaches nobody anything and
erodes trust in the rest of the suite.

## What a real integration-test setup would look like

If/when this project is run somewhere with a real (or containerized/test) Postgres
instance available:

1. Add a `.env.test` pointing `DATABASE_URL` at a disposable test database (a local
   Postgres, a Docker Compose service, or a CI-provisioned ephemeral instance).
2. `npx prisma migrate deploy` (or `db push`) against that test database before the
   suite runs — a `globalSetup`/`globalTeardown` in `jest.config.js` is the natural
   place to wire this, resetting/migrating the schema once per test run.
3. Write tests against `src/app/modules/**/*.service.ts` directly (calling the real
   Prisma client against the real test database, not a mock) — this is where this
   app's actual business logic and highest-risk bugs live: the SERIALIZABLE
   booking-transaction retry (Pass 5/6), the optimistic-concurrency refund/void logic
   (Pass 20), the webhook duplicate-delivery race fix (Pass 20), cascading
   soft-delete/anonymization behavior (Pass 12/24).
4. Route-level (supertest-against-a-running-app) tests are the next layer up from
   that, covering auth middleware, validation wiring, and the global error handler
   end-to-end.

Mocking Prisma instead of using a real test database was considered and rejected: this
app's most consequential logic (concurrency control, optimistic locking, transaction
retry) is specifically about *real database semantics* — a mocked Prisma client that
just returns canned responses would test nothing about the actual behavior these
functions exist to get right, and would risk giving false confidence that these are
covered when the tests would really just be asserting that a mock returns what it was
told to return.

## Manual verification still required after every pass

Since this environment cannot run `prisma generate`, `db push`, migrations, or any real
database query, every prior pass's commit message has asked for manual verification —
`npx prisma generate && npx prisma db push && npx tsc --noEmit`, run wherever this
repository actually has database access. That request stands for this pass too, and
for any integration-test setup added later.
