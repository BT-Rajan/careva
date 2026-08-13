# Pass 3 — Authentication

Status: **Complete**

Scope: `api/src/app/modules/auth/*`, `api/src/app/middlewares/rateLimiter.ts` (new),
`api/src/app/modules/doctor/doctor.service.ts` (1 line), `api/src/app/modules/patient/patientService.ts`
(1 line), `api/prisma/schema.prisma` (2 new fields on `Auth`), `api/.env.example`,
`software_requirements.md`. No other code touched. No stack change — same
Express/Prisma/JWT/bcrypt stack, plus one new small npm package (`express-rate-limit`,
in-process, no new infrastructure).

Same sandbox limitation as Pass 2: no network access to `binaries.prisma.sh`, so the new
`Auth` schema fields could not be validated with `prisma generate`/`validate`/`migrate`
here. Also could not cleanly regenerate `package-lock.json`/`yarn.lock` for the new
`express-rate-limit` dependency — every attempt rewrote the entire lockfile (an npm-
version formatting difference, not a real dependency change), so those files were left
untouched. **Run `npm install` (or `yarn install`) in your own environment** to pick up
the new dependency before running the app; see §7.

---

## 1. Critical fix: email verification token was never actually checked

This was a real, live vulnerability, not a theoretical one.

`GET /api/v1/auth/user/verify/:userId/:uniqueString` is the link doctors click from their
verification email. The route received `uniqueString` as a param but **the controller
never read it** — it only checked whether a `UserVerfication` row existed for the given
`userId` and hadn't expired, then marked the doctor verified. The actual secret token in
the link was generated correctly (a random UUID, bcrypt-hashed at rest, raw value emailed
— that part was already right) but was **never compared against anything**.

Net effect: anyone who knew a doctor's `id` — which is not a secret; it's the same id
used in public doctor-profile URLs across the site — could hit this endpoint with an
arbitrary `uniqueString` and get that doctor auto-verified within the 6-hour window,
without ever receiving or clicking the real email link.

Fixed by adding the missing check: `bcrypt.compare(uniqueString, storedHash)` before
proceeding, with an early redirect to the expired-link page if it fails.

---

## 2. Bug fix: password-reset "clear previous request" logic never ran

`resetPassword` was supposed to delete any existing `ForgotPassword` row for the user
before creating a new one. It looked the old row up by `findUnique({ where: { id:
isUserExist.id } })` — but `ForgotPassword` rows get their own auto-generated `id`, never
the user's `Auth.id`. That lookup essentially never matched anything (astronomically
unlikely UUID collision aside), so the cleanup silently never ran: every reset request
just piled up a new row, leaving every previously-requested reset link valid until it
naturally expired on its own. Not a security hole by itself (each link is still an
unguessable token), but not the intended behavior either, and it meant stale rows
accumulated indefinitely.

Fixed: now correctly looks up (and clears all of, defensively) existing requests by the
actual `userId` column via `deleteMany`.

---

## 3. Duplicate-account handling: email casing

Neither `Patient` nor `Doctor` registration normalized email casing before the
duplicate-email check or the `create()` call. Postgres unique constraints are
case-sensitive by default, so `Patient@x.com` and `patient@x.com` could become two
distinct accounts — and depending on which case a user typed at login vs. registration,
they could effectively lock themselves out of their own account. Login itself had the
same issue: an exact-case match against `Auth.email`.

Fixed by lowercasing (and trimming) the email at every entry point: doctor registration,
patient registration, login, and password reset. `VerificationUser` (see §8 — dead code,
not wired to any route) was normalized too, for consistency, in case it's ever wired up
later.

---

## 4. Brute-force protection (previously: none at all)

Nothing rate-limited login attempts, and nothing tracked repeated failures against a
specific account. Two independent layers added, covering two different attack shapes:

- **IP-based rate limiting** (`api/src/app/middlewares/rateLimiter.ts`, using
  `express-rate-limit`, in-process, no external service): applied to `/login` (10
  requests / 15 min), `/reset-password` and `/reset-password/confirm` (10 / 15 min), and
  the email-verification link itself (20 / 15 min — also directly relevant to closing §1,
  since it slows down any attempt to brute-force the token). Catches a single
  attacker/script hammering many accounts from one source.
- **Per-account lockout** (`auth.service.ts`, `loginUser`): two new fields on `Auth` —
  `failedLoginAttempts` and `lockedUntil`. After 5 consecutive failed attempts, the
  account locks for 15 minutes regardless of source IP; a successful login resets the
  counter. Catches a slow, distributed, or targeted attempt against one specific account
  that IP-based limiting alone wouldn't.

---

## 5. Two previously-missing endpoints

### 5.1 `POST /api/v1/auth/logout`

Did not exist at all. Clears the `accessToken` cookie. **Important, stated plainly in the
code comment and here too:** this API issues stateless JWTs — the server has no way to
force-invalidate a bearer token a client already holds. This endpoint cleans up the
(currently redundant — see §8) cookie and gives the frontend a real logout call to make,
but a token captured before logout remains valid until it naturally expires. Real
server-side token invalidation needs a stateful store (Redis, or a DB-backed session/
denylist table), which is an infrastructure decision this pass does not make
unilaterally — flagged for a future pass if it's needed.

### 5.2 `POST /api/v1/auth/change-password` (authenticated)

Did not exist at all — only the unauthenticated forgot-password flow existed. Added,
protected by the existing `auth()` middleware (any logged-in role), requiring the
caller's *current* password before accepting a new one — distinct from the reset flow,
which exists specifically for when the user can't provide their current password.

---

## 6. Found while working in this module: `moment` was an undeclared dependency

Not something introduced by this pass, but found while reading `auth.service.ts`,
`auth.controller.ts`, and `doctor.service.ts` closely: all three `import moment from
'moment'` directly, but `moment` was **not listed in `package.json`'s dependencies at
all**. It only worked because `winston-daily-rotate-file` pulls it in transitively (via
`file-stream-rotator`), and npm happens to hoist it to the top-level `node_modules`. That
is fragile in a way that's directly relevant here: if that transitive chain ever changes
on a routine `npm install`/`npm update`, the entire authentication module (session
expiry checks, lockout timing, token expiry, password-reset expiry — all of it) would
fail to build with a "Cannot find module 'moment'" error, for a reason completely
unrelated to anything anyone touched. Declared it as a direct dependency at its
currently-resolved version (`^2.30.1`, ships its own TypeScript types, no
`@types/moment` needed).

---

## 7. What you need to run before this is live

```bash
cd api
npm install                # picks up express-rate-limit (package.json already updated;
                            # lockfiles were deliberately left untouched — see limitation
                            # notice at the top of this doc)
npx prisma format
npx prisma validate
npx prisma migrate dev --name pass3-authentication
```

Also add `CLIENT_URL` (production) and `CLIENT__LOCAL_URL` (development) to your `api/.env`
— see §6. Without them, password-reset emails contain a broken `undefined/reset-password/
...` link. This bug predates this pass but was only found while reading the reset-password
flow closely; documented in `api/.env.example` and `software_requirements.md` now.

---

## 8. What this pass found but deliberately did *not* fix

- **The `accessToken` cookie is set on login but never read.** The auth middleware
  (`app/middlewares/auth.ts`) only checks `req.headers.authorization` — never
  `req.cookies.accessToken`, even though `cookie-parser` is already installed and would
  populate it. The cookie is `httpOnly` (can't be read by frontend JS, which is normally
  the point — XSS protection), but since the frontend must *also* have the raw token
  client-side to set the `Authorization` header (it's returned in the JSON response body
  on login), the token ends up stored somewhere JS-accessible anyway (almost certainly
  `localStorage`, based on the header-based auth pattern) — which defeats the purpose of
  making the cookie `httpOnly` in the first place. Not changed here: making the cookie
  the *actual* auth mechanism (middleware reads `req.cookies.accessToken` as a fallback,
  frontend stops sending the header) is a real behavior change across both API and
  frontend that needs coordinated testing this sandbox can't do. Flagged for Pass 19
  (Security Hardening) or a dedicated follow-up.
- **CORS is fully open** (`app.use(cors())` with no options, in `src/app.ts`) — any origin
  can call the API. `config.clientUrl` exists and could restrict this, but per §6 it
  wasn't even reliably configured before this pass, so locking CORS to it now — untestable
  in this sandbox — risks silently breaking the app in a deployment where it's misconfigured.
  Deferred to Pass 19, once `CLIENT_URL` is confirmed to be reliably set.
- **`VerificationUser` in `auth.service.ts` is dead code** — exported, but no route or
  controller calls it. It's a near-duplicate of `loginUser` minus the doctor-verified
  check. Left in place (not this pass's job to remove unrelated dead code) but normalized
  for email casing anyway (§3) in case it's wired up later.
- **True token invalidation / refresh-token rotation** — see §5.1. Needs a stateful store;
  deliberately not decided unilaterally in this pass.
- **The password-reset token mechanism is unconventional** (`bcrypt.hashSync` is used to
  produce a URL-embedded token, then matched by plain string equality rather than
  `bcrypt.compare` — unlike email verification, where the same pattern is used
  correctly). It isn't insecure the way §1 was — the full hashed string is both what's
  emailed and what's checked, so nothing is silently skipped — just an unconventional and
  computationally wasteful way to generate an opaque token. Not changed: rewriting it
  changes the reset-link URL format, which is a bigger, harder-to-test change for a
  cosmetic/performance concern rather than a security one.
