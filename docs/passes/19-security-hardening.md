# Pass 19 — Security Hardening

Status: **Complete**

Scope: `api/src/app.ts`, `api/src/server.ts`, `api/src/app/middlewares/rateLimiter.ts`,
`api/src/app/modules/appointment/appointment.route.ts`,
`api/src/app/modules/auth/auth.controller.ts`, `api/src/helpers/jwtHelper.ts`. New
dependency: `helmet` (installed, package.json/lockfile updated). No schema change.

---

## 1. No security headers at all

`helmet` was not installed. Added and wired in globally (`app.use(helmet())`) —
sets `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`,
`Strict-Transport-Security`, removes `X-Powered-By`, and more, all previously entirely
absent from every response this API ever sent. Left Content-Security-Policy at
helmet's conservative default rather than hand-tuning it: this is a JSON API, not a
page-rendering server (the frontend is a separate deployment), so a strict hand-built
CSP would mostly be maintenance burden without a real page-injection surface to defend
here — revisit if this server ever starts rendering HTML views itself.

## 2. `cors()` with no options — wildcard origin

`app.use(cors())` with zero configuration resolves to `Access-Control-Allow-Origin: *`
— any website on the internet could make a cross-origin request to this API and read
the JSON response. The practical severity was limited by a different design choice
(this app's real auth token lives in the frontend's `localStorage` and is attached
manually via an `Authorization` header — see `helpers/axios/axiosInstance.js` — which a
malicious third-party page has no way to read or forge; it isn't a cookie a browser
attaches automatically), but "limited severity because of an unrelated design choice"
isn't a reason to leave an actual misconfiguration in place. Restricted to
`config.clientUrl` (falls back to permissive if that env var is unset, matching
today's actual behavior, rather than breaking a misconfigured deployment); enabled
`credentials: true` to match the httpOnly cookie `auth.controller.ts` sets on login.

## 3. `trust proxy` was never set

Any real deployment of this app sits behind a reverse proproxy/load balancer. Without
`app.set('trust proxy', 1)`, Express sees every request as originating from the
proxy's own IP — silently breaking two things that already existed in this codebase:
the IP-based rate limiters (Pass 3/7) would rate-limit every user behind the proxy
together as one "client," and `req.ip` would be useless for the audit-log/abuse-
investigation purposes those passes built it for. Set to `1` (trust exactly the first
hop) rather than a bare `true`, which would trust the entire `X-Forwarded-For` chain —
spoofable by the client itself if there's no proxy actually rewriting it.

## 4. Two intentionally-public, high-value endpoints had zero rate limiting

Pass 15 made both `POST /appointment/create` (+ its guest variant) and
`POST /appointment/tracking` genuinely, deliberately public — booking without an
account is a real product decision, and a random unguessable `trackingId` is a correct
design for self-service tracking. Neither had ever had a rate limiter, though — the
existing limiters (Pass 3/7) only covered login, password reset, email verification,
and payment webhooks. Added `appointmentCreateRateLimiter` (20/15min — loose enough for
a patient legitimately booking for multiple family members) and
`trackAppointmentRateLimiter` (20/15min, same tier as the email-verification-link
limiter — "slow down brute-forcing an opaque token," not "protect a login form").
"Unguessable" and "unlimited attempts allowed" are different guarantees; a negligible
per-attempt chance still isn't zero at unlimited volume.

## 5. JWT verification didn't pin an algorithm

`jwt.verify(token, secret)` with no `algorithms` option trusts whatever algorithm the
token's own header claims. This app only ever signs with a symmetric secret (HS256),
so the classic "RS256-to-HS256 confusion" attack (using a known public key as an HMAC
secret) was never directly reachable here — no public key is ever exposed. Pinned
`algorithms: ['HS256']` on both sign and verify anyway, as the correct defense-in-depth
baseline (OWASP's JWT guidance) rather than relying on there being no other exploitable
path today.

## 6. No startup validation of the JWT secret

A missing or empty `JWT_SCRET` would only surface the first time someone tried to log
in (`jwt.sign` throws immediately on an undefined secret) — a deployment could sit "up"
and pass basic health checks while every single auth-dependent request 500s,
potentially for a while before anyone notices depending on what's actually being
monitored. Added a startup check (`assertSecureConfig` in `server.ts`, before
`app.listen`) that refuses to start if the secret is missing or under 16 characters —
not a real strength audit, but it catches the most likely accidents: an unset env var,
or an obviously-placeholder value left over from local development.

## 7. Cookie hardening

The httpOnly `accessToken` cookie `auth.controller.ts` sets on login (and clears on
logout) had no `sameSite` attribute — relying on the browser's own default (moderns
default to `Lax`) rather than an explicit decision made by this code. Added
`sameSite: 'lax'` to both the `Login` and `Logout` cookie options (they must match, or
`clearCookie` silently fails to actually remove a cookie set with different
attributes). Confirmed this cookie is not actually read anywhere for authentication —
`middlewares/auth.ts` only checks the `Authorization` header — so there's no live CSRF
path today, but hardening a real `Set-Cookie` carrying a raw JWT costs nothing and
removes a footgun for whenever this cookie's actual purpose gets revisited.

## 8. What was checked and found already correct

- **SQL/NoSQL injection** — not a concern; this app uses Prisma's query builder
  throughout, no raw SQL string concatenation found anywhere in the codebase.
- **Password hashing** — `bcrypt` with a reasonable cost factor, already in place.
- **Payment webhook signature verification** — Pass 7 already verifies signatures
  before trusting a webhook payload; no gap found.
- **`express.json()` body size limit** — defaults to 100kb, a reasonable existing
  default; not changed.

## 9. What this pass deliberately did not do

- **No dependency vulnerability remediation.** `npm audit` (run incidentally while
  installing `helmet`) reports pre-existing vulnerabilities across the dependency
  tree, unrelated to anything this pass touched. `npm audit fix --force` can introduce
  breaking major-version bumps with no way to test the result in this environment —
  flagging this for manual review rather than blindly forcing updates.
- **No hand-tuned Content-Security-Policy** — see §1.
- **No CSRF token / double-submit-cookie scheme** — not needed given the current
  Authorization-header-only auth model (§7); would become necessary if the httpOnly
  cookie is ever wired up as a real authentication path.
- **No refresh-token flow** — `config.jwt.refresh_secret` exists in config but is
  unused anywhere in the codebase; inventing a refresh-token flow was not this pass's
  charter.
