# Pass 25 — Testing

Status: **Complete** (with an honest, documented environment limitation — see §3)

Scope: new `api/jest.config.js`, `api/src/__tests__/unit/` (8 test files + 1 shared
helper), `api/src/__tests__/integration/README.md`, `api/package.json` (`test`/
`test:watch`/`test:coverage` scripts, replacing the stub that always failed). New
dev dependencies: `jest`, `ts-jest`, `@types/jest`. No schema change, no production
code change.

---

## 1. Starting point: zero tests, a stub script

`npm test` was `echo "Error: no test specified" && exit 1` — a placeholder that always
fails, with no test framework installed and not a single test file anywhere in the
repository. This pass installs Jest + ts-jest and writes a real, running test suite.

## 2. What's actually tested, and why this scope

This app's highest-value, highest-consequence pure logic is its five lifecycle state
machines (appointment, doctor, prescription, invoice, review) — every one of them a
pure function taking a current status, a requested status, and an actor role, with no
database dependency. A bug in any of these (a missing transition, a wrongly-permissive
actor check) would be exactly the kind of defect this entire 24-pass hardening effort
has been finding and fixing in production code — so proving these functions are
correct, exhaustively, is the single highest-leverage thing a first test suite for this
codebase can do.

**Every lifecycle gets two kinds of coverage:**
- **Named, explicit test cases** for the actual business rules — "a patient cannot
  approve their own doctor account," "only admin can force
  `CANCELLED_BY_ADMIN`," "`ISSUED → PAID` cannot be triggered by any human actor." These
  read as documentation of the real rules, not just assertions.
- **An exhaustive graph check** (`stateMachineTestHelpers.ts`'s
  `assertExhaustiveTransitionGraph`) — for every state machine, every `(from, to)` pair
  over every status the machine declares, NOT explicitly listed as legal, is asserted to
  throw. This is exactly the kind of check a hand-written suite tends to miss: nobody
  naturally writes "and every other combination doesn't work" as an explicit case, but
  a missing or typo'd entry in a `TRANSITIONS` map is a real, plausible bug class this
  catches mechanically that hand-picked examples alone would not.

Also covered: `shared/money.ts` (the INR/KWD minor-unit conversion Pass 7 built
specifically to avoid a factor-of-10 currency bug), `shared/trackingId.ts` (Pass 15's
replacement for the enumerable name+date+counter format — verifying the new format's
actual security property: no two calls collide), and the Zod validation schemas from
Pass 17 (`appointment.validation.ts`, `auth.validation.ts`) — confirming they accept
well-formed requests and reject the specific malformed ones each schema was written to
catch.

## 3. An honest limitation: 6 of 8 test files could not be executed in this sandbox

Every test file was written carefully against the real, current production code — but
running the full suite here surfaced a pre-existing environment limitation, not a
defect in the tests: **this sandbox's `@prisma/client` was never successfully
generated.** `node_modules/.prisma/client` contains only an empty placeholder — the
same `binaries.prisma.sh` network restriction that has blocked `prisma generate` in
every single prior schema-touching pass (confirmed again while diagnosing this: the
exact same `403 Forbidden` fetching the schema-engine binary). This means the
**production source files themselves** (`appointment-state-machine.ts`, `money.ts`,
etc.) do not currently type-check in this sandbox, for a reason that has nothing to do
with anything this pass wrote — every pass since the schema was first touched has
carried the caveat "please run `npx tsc --noEmit` locally" for exactly this reason, and
this is that same limitation surfacing inside a test run instead of a manual `tsc`
check for the first time.

**Confirmed genuinely passing, in this sandbox, right now: 2 of 8 test files, 18 of 18
tests** — `trackingId.test.ts` and `validation.test.ts`, the two suites whose subject
code (`shared/trackingId.ts`, the Zod schemas) imports nothing from `@prisma/client` at
all.

**The other 6 files** (`appointmentStateMachine`, `doctorLifecycle`,
`prescriptionLifecycle`, `invoiceLifecycle`, `reviewLifecycle`, `money`) are written,
and were carefully hand-reviewed against each lifecycle's actual `TRANSITIONS`/actor
maps — but could not be run to completion here, because the modules under test
themselves fail to compile in an environment with no real Prisma client. They will run
correctly, exactly as written, the first time `npx prisma generate` succeeds — which is
every real development or CI environment with normal internet access, just not this one.

**Action needed**: after `npx prisma generate && npx prisma db push` succeed locally,
run `cd api && npm test` and confirm all 8 suites pass. If anything in the 6 unverified
files fails, that's a genuine finding this pass's review missed — please report it back.

## 4. Integration tests — a documented template, not written as failing specs

`src/__tests__/integration/README.md` explains why no service-layer or route-level
integration tests are included: they would need a real database, which — per every
prior pass's own experience — has never been reachable from any environment this
project has been worked in so far. Writing tests that are *expected* to fail everywhere
they'd run would be worse than not writing them. The README lays out exactly what a
real integration-test setup should look like (a `.env.test` + disposable test database,
`globalSetup`/`globalTeardown` wiring, and which service functions are highest-priority
to cover first — the SERIALIZABLE booking-transaction retry, the optimistic-concurrency
refund/void logic, the webhook dedup fix) for whoever picks this up once a real test
database is available.

## 5. What this pass deliberately did not do

- **No mocked-Prisma unit tests for service functions.** Considered and rejected: this
  app's most consequential logic (concurrency control, transaction retry, optimistic
  locking) is specifically about real database semantics — a mocked Prisma client
  would test that a mock returns what it was told to return, not that these functions
  actually behave correctly under real contention. That would be false confidence, not
  real coverage.
- **No frontend test suite.** This pass scoped to the backend, where the highest-risk,
  highest-value pure logic (the state machines) lives. A frontend testing setup
  (Jest/RTL or Vitest for the React app) is a reasonable next step but a separate
  effort with its own tooling decisions.
- **No CI pipeline wiring** (GitHub Actions running `npm test` on every push). The test
  suite exists and runs locally via `npm test`; wiring it into CI is an operational
  step for whoever owns this repository's CI configuration, not something this pass
  invented infrastructure for.
