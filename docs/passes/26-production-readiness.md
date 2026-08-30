# Pass 26 — Production Readiness

Status: **Complete** — includes a security finding flagged prominently below, not just
buried in the changelog.

Scope: `.gitignore` (root), `api/.env.example`, new `.env.example` (root),
`DEPLOYMENT.md`, plus removing 69 stale/misplaced tracked files (`.env` at the repo
root, 68 compiled `api/dist/*.js` files) from git tracking. No schema change, no
production source code change.

---

## 1. Security finding: a real-looking secret sitting in `api/.env.example`

While auditing environment configuration for completeness, `api/.env.example`
contained:

```
JWT_SCRET=f9Hr6v38sK2nA5xGt4wDcR7uJ1mZlP0b
JWT_REFRESH_SECRET=f9Hr6v38sK2nA5xGt4wDcR7uJ1mZlP0b
```

Every other value in that file is an obviously-fake placeholder
(`YOUR_RAZORPAY_KEY_ID`, `YOUR_CLOUD_NAME`, etc.). This one is different: a specific
32-character random-looking string, used identically for both the JWT signing secret
and its refresh-token counterpart. That specificity is exactly what a real, actually-
used secret looks like — not a deliberate placeholder someone typed by hand. `git log`
confirms it has been present since this repository's very first commit.

**This has been replaced with obvious placeholders** in this pass. But replacing the
file going forward does not undo any exposure that may already exist:

- **If this exact value has ever been used as the live `JWT_SCRET` in any real
  deployment of this application**, that deployment's token-signing secret has been
  sitting in version control the entire time this project has existed, and anyone
  with access to this repository (or who has ever cloned it) could forge a valid,
  signed authentication token for **any user, including an admin**, against that
  deployment.
- **If you recognize this value** as something that has ever actually been deployed:
  **rotate it now.** Generate a fresh, random `JWT_SCRET` and `JWT_REFRESH_SECRET`,
  update every environment that uses them, and redeploy. This invalidates every
  currently-issued token (everyone will need to log in again), which is the correct
  and necessary cost of closing this gap.
- If it was never actually deployed anywhere, there's nothing further to do beyond
  what this pass already fixed.
- This pass did **not** attempt to rewrite git history to scrub the value from past
  commits. History-rewriting (`git filter-repo`/BFG) is a disruptive operation for any
  shared repository with existing clones, forks, or open pull requests, and isn't
  something to do unilaterally without knowing who else has a copy of this history.
  If the value did see real use, rotating the secret itself matters far more than
  scrubbing history — a rotated secret makes the old, exposed value useless regardless
  of whether it's still visible in old commits.

## 2. `.gitignore` had two real, separate bugs

- **`/dist` and `/build` were root-anchored** (leading `/`), so they only ever matched
  a `dist`/`build` folder at the repository root — never `api/dist`, the actual path
  this project's own build script (`npm run build` → `tsc && copyfiles ...`) produces.
  As a direct result, **68 stale, compiled `.js` files were checked into git** under
  `api/dist/`. Compiled output has no business being version-controlled: it goes stale
  immediately, bloats the repository, and — worse — could sit there looking like a
  legitimate source of truth to someone debugging a production issue when it's
  actually an old build that no longer matches the real `src/`. Fixed to an unanchored
  `dist/`/`build/` (matches at any depth) and removed all 68 files from tracking
  (`git rm -r --cached`, not a hard delete — nothing was removed from disk, only from
  version control).
- **The frontend's root `.env` was committed outright** — not merely un-ignored by a
  narrow pattern, but an actual tracked file, containing (harmlessly, in this case)
  two `REACT_APP_*` base-URL values. `DEPLOYMENT.md` has always instructed
  `copy .env.example .env` for this exact file, with a fallback comment for "if no
  `.env.example` exists at root, create `.env` manually" — but a root `.env.example`
  never actually existed; a live `.env` was committed in its place instead, and the
  fallback comment silently covered for that gap ever since. Added the missing root
  `.env.example` (§3) and untracked the real `.env`, so `DEPLOYMENT.md`'s own
  documented step now works exactly as written instead of relying on a pre-existing
  file that happened to already be there.

## 3. Filled in the missing root `.env.example`

`DEPLOYMENT.md` referenced a root-level `.env.example` that never existed (see §2).
Added it, containing the same two `REACT_APP_*` variables the previously-committed
`.env` had (localhost default + a generic live-URL placeholder) — and updated
`DEPLOYMENT.md`'s Linux instructions to actually run `cp .env.example .env` before
editing it (the Windows instructions already did this; the Linux section had skipped
straight to `nano .env`, silently relying on the file already existing from the
now-removed tracked copy).

## 4. `.env.example` cleanup — three genuinely unused variables removed

While replacing the leaked-looking secret, found three variables in
`api/.env.example` that `grep` across the entire `api/src` confirms are never read by
any code, anywhere: a bare `JWT=...` (not `JWT_SCRET`, not anything `config/index.ts`
or any service file reads — looked like an unrelated pasted value, possibly itself a
stray credential of some kind, though not one that maps to any real secret this app
uses), `JWT_SCRET_SALT_ROUND` (bcrypt's cost factor is a hardcoded literal `12` in
`doctor.service.ts`, never read from an env var), and `PATIENT_PASS` (only
`DOCTOR_PASS` is ever actually read). Removed all three — noise that made it harder
for a new deployer to tell which variables actually matter.

## 5. Extended the deployment checklist for what later passes actually built

`DEPLOYMENT.md`'s post-deployment checklist predates most of this hardening effort.
Added three items reflecting work from passes that came after the checklist was
originally written: verifying `GET /health` (Pass 21) actually reports real database
connectivity, an explicit reminder that `JWT_SCRET`/`JWT_REFRESH_SECRET` must be
freshly generated and never match any placeholder or previously-shared value (directly
motivated by §1's finding), and confirming the background jobs (Pass 23) actually
started by checking the startup logs.

## 6. What was reviewed and found already correct

- **`software_requirements.md`** — scoped to system-level requirements (Node,
  PostgreSQL, external service accounts), not an npm-dependency inventory. Correctly
  does not need to mention `helmet`/`node-cron`/`jest`/etc. — those install
  automatically via `npm install` and were never something a deployer needs to
  separately source.
- **A repo-wide sweep for other leaked-looking secrets** (AWS-style access key
  patterns, live Stripe-style key prefixes, connection strings with real embedded
  credentials) — found nothing beyond the one issue in §1.
- **`config/index.ts`'s fail-fast startup validation** (Pass 19 added this for
  `JWT_SCRET`) — reviewed, still correct; not extended further in this pass since
  every other credential (Cloudinary, email, payment gateways) already degrades
  gracefully rather than needing to block startup (a missing Cloudinary key fails an
  upload attempt with a clear error — Pass 18 — rather than needing to prevent the
  whole server from booting).

## 7. What this pass deliberately did not do

- **No git history rewrite** — see §1's closing paragraph.
- **No CI/CD pipeline** — same reasoning as Pass 25's equivalent note: wiring this
  repository into a specific CI provider is an operational decision for whoever owns
  it, not something to invent unprompted.
- **No Docker/containerization** — `software_requirements.md` and `DEPLOYMENT.md` both
  explicitly state this project targets native Node.js deployment, not
  Vercel/Docker. Respected that existing, explicit decision rather than reversing it.
