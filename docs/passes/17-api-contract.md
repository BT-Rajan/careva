# Pass 17 — API Contract

Status: **Complete**

Scope: `api/src/app.ts` (global error handler), new `api/src/errors/handlePrismaError.ts`
(replacing two deleted dead files), new `api/src/app/middlewares/validateRequest.ts`,
new `*.validation.ts` files in the `appointment`, `auth`, `doctor`, `patient`, and
`prescription` modules, and the corresponding `*.route.ts` wiring. No schema change, no
stack change (Zod was already a dependency, unused).

---

## 1. What was actually there before this pass

Two separate, unrelated gaps, both about the same thing: nothing enforced what a
request to this API was supposed to look like, and nothing gave a client a clean answer
when a request wasn't well-formed.

**`zod` was a dependency doing nothing.** `errors/handleZodError.ts` existed, correctly
written, ready to format a `ZodError` into this app's error-response shape — but no
route anywhere validated a request against a Zod schema, so a `ZodError` could never
actually be thrown. Every service function across the entire codebase is typed
`payload: any`; request shape was enforced only by whatever ad hoc `if (!x) throw
ApiError(...)` checks a given function happened to have written inline, inconsistently,
one function at a time.

**The other two error formatters were dead code from a different stack entirely.**
`handleValidationError.ts` and `handleCastError.ts` were both *entirely commented out*
and written against `mongoose.Error.ValidationError` / `mongoose.Error.CastError` — this
app has never used Mongoose (it's Prisma/Postgres throughout). They were boilerplate
left over from whatever starter template this project began from, and could never have
applied here. Deleted rather than fixed — there was no working version underneath the
comments to restore.

**The global error handler in `app.ts` only special-cased one error type.** `ApiError`
got a clean, well-formatted response. Anything else — a raw Prisma error escaping a
service function (e.g. two simultaneous requests racing past an application-level
uniqueness check and hitting the database's real unique constraint), or, going forward,
a `ZodError` from newly-added validation — fell into the generic fallback: either a raw
error message leaked to the client (`config.showErrorDetails` on) or an opaque 500
"Something Went Wrong" (off). Neither is a real API contract.

## 2. What this pass builds

**`handlePrismaError.ts`** — the real equivalent of the two deleted dead files, for the
ORM this app actually uses. Maps Prisma's `PrismaClientKnownRequestError` codes to
clean, well-formed responses: `P2002` (unique constraint) → 409 naming the field,
`P2025` (record not found) → 404, `P2003` (foreign key violation) → 400 naming the
reference. Anything else still gets a 400 with Prisma's own message rather than falling
through to the generic 500 fallback.

**`app.ts`'s error handler** now dispatches by error type: `ApiError` (unchanged),
`ZodError` → `handleZodError` (finally reachable), `Prisma.PrismaClientKnownRequestError`
→ `handlePrismaError` (new), else the existing generic fallback (unchanged).

**`validateRequest.ts`** — a Zod-schema-parameterized middleware, the standard
`validateRequest(schema) => (req, res, next)` shape. Parses `{ body, query, params }`
against the schema and calls `next(error)` on failure, letting the global handler take
it from there. Convention: every schema file lives at `<module>/<module>.validation.ts`
and wraps its shape in `z.object({ body: z.object({...}) })`, even when only `body` is
constrained, so a schema can start validating `query`/`params` later without changing
how it's invoked.

## 3. Where it's wired

Ten endpoints across five modules — the highest-traffic and highest-consequence write
paths:

- **Appointment** (`appointment.validation.ts`): `POST /create`,
  `POST /create-un-authenticate`, `POST /tracking`. Booking is this app's highest-traffic
  write path and the one most exposed to adversarial input (guest booking needs no auth
  at all — Pass 15). The two creation schemas deliberately diverge on whether
  `doctorId` is required, matching what the two service functions actually do
  (`createAppointment` 404s without it; `createAppointmentByUnAuthenticateUser` falls
  back to a default admin doctor) — validation enforces the real contract, not an
  invented stricter one.
- **Auth** (`auth.validation.ts`): `POST /login`, `POST /reset-password`,
  `POST /reset-password/confirm`, `POST /change-password`.
- **Doctor** (`doctor.validation.ts`) / **Patient** (`patient.validation.ts`):
  `POST /` (registration) for each. Only the account-creation core
  (firstName/lastName/email/password) is required, matching the schema — both models
  make every other field optional by design (a doctor's profile is expected to start
  sparse; see Pass 10's profile-completeness scoring), so the validation schema doesn't
  invent a stricter contract than the data model has. `.passthrough()` so the rest of a
  real registration payload isn't rejected.
- **Prescription** (`prescription.validation.ts`): `POST /create`. Only `appointmentId`
  and `disease` are required, again matching what's actually non-nullable on the
  `Prescription` model.

Card-payment fields (`cardNumber`, `cvv`, etc.) in the appointment schemas stay loosely
typed on purpose — validating card-number format here would just be re-implementing
what a real payment provider integration validates, and Pass 7 already owns the
transaction/charge logic. This layer's job is "is the request well-formed enough to
process," not full business-rule enforcement — approval status, slot availability,
ownership checks, and everything else already correctly living in each service
function stays exactly where it is, not duplicated into a schema.

## 4. What this pass deliberately did not do

- **Not every endpoint got a schema.** This establishes the pattern and covers the ten
  highest-value write paths; dozens of other routes (most PATCH/update endpoints across
  every module) still validate only via each service function's own inline checks. Full
  coverage is a natural, mechanical extension of the pattern this pass sets up, not a
  design decision still to be made — deferred for scope, not silently skipped.
- **No response-shape/output validation.** This pass is about request input; validating
  that what a service function *returns* matches a declared shape is a different
  (larger, more invasive) kind of contract enforcement not attempted here.
- **No OpenAPI/Swagger spec generation.** A machine-readable API spec is a reasonable
  next step once schema coverage is broader, but generating one from ten schemas would
  be more scaffolding than substance right now.
