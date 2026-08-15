# Careva — Software Requirements

This document lists everything needed to **run, build, and deploy** Careva (frontend + API) on a local machine or a server. It does not cover *how* to deploy — see `DEPLOYMENT.md` for step-by-step instructions on Windows and Linux.

Careva no longer targets Vercel or Docker. Deployment is native Node.js on the host machine — any machine or VM that can run Node.js and PostgreSQL works (bare metal, a VPS, or a plain server).

---

## 1. Architecture overview

| Part | What it is | Location |
|------|-----------|----------|
| **Frontend** | React 18 single-page app (Create React App) | repo root |
| **Backend / API** | Node.js + Express + TypeScript REST API | `api/` |
| **Database** | PostgreSQL, accessed via Prisma ORM | external (self-hosted or managed) |
| **File storage** | Cloudinary (profile photos, uploaded content) | external service |
| **Email** | Gmail SMTP via an App Password (password resets, verification, notifications) | external service |
| **Payments** | Razorpay (India / INR) and Telr (Kuwait / KWD) — selected per-doctor via `Doctor.currency` | external services |

---

## 2. Required software (both frontend and backend)

| Software | Minimum version | Notes |
|----------|-----------------|-------|
| **Node.js** | 20.x LTS or newer | Required by `api/package.json` engines field. Includes `npm`. |
| **npm** | 10.x+ (bundled with Node 20) | Used for the frontend. The API can use either `npm` or `yarn` (a `yarn.lock` is present). |
| **Yarn** (optional) | 1.22.x (Classic) | Only needed if you prefer Yarn over npm; both lockfiles exist. |
| **Git** | 2.x+ | To clone and manage the repository. |
| **PostgreSQL** | 14+ (Prisma supports 13–17) | Can be local, a VM-hosted instance, or a managed provider (Railway, Neon, RDS, self-hosted, etc.) |
| **Prisma CLI** | Installed automatically via `npx prisma` — no separate global install required | Used for schema push/migrations and client generation. |

---

## 3. External accounts / services required

These are **not software installs**, but the app will not function fully without them:

| Service | Purpose | Required for |
|---------|---------|--------------|
| **PostgreSQL database** | Primary data store | Both frontend (indirectly) and API (directly) |
| **Cloudinary account** | Image upload/hosting (doctor photos, profile pictures, blog images) | API |
| **Gmail account + App Password** | Sends transactional emails (verification, password reset, appointment notifications) | API |
| **Razorpay account** (test or live) | Payment processing for India-based doctors (INR) | API |
| **Telr merchant account** (test or live) | Payment processing for Kuwait-based doctors (KWD) | API |

If you skip Cloudinary/Gmail setup, the app will still run, but image uploads and email flows will fail at runtime. If you skip the payment gateway setup, bookings will still be created, but will sit in a `PENDING` payment state with no way to actually collect payment through the current UI — see `docs/passes/07-payment-system.md` §7 for what's still needed to wire up a real checkout flow.

---

## 4. Ports used (defaults)

| Service | Default port | Configurable via |
|---------|--------------|-------------------|
| Frontend (dev server) | `3000` | CRA default; not typically changed |
| API | `5050` | `PORT` in `api/.env` |
| PostgreSQL | `5432` | Set by your database provider/install |

---

## 5. Environment variables

### Frontend — root `.env`

| Variable | Description |
|----------|-------------|
| `REACT_APP_API_BASE_URL_LOCAL` | API URL used in local development, e.g. `http://localhost:5050/api/v1` |
| `REACT_APP_API_BASE_URL_LIVE` | API URL used in production builds |

### Backend — `api/.env` (copy from `api/.env.example`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Port the API listens on (default `5050`) |
| `NODE_ENV` | `development` or `production` |
| `SHOW_ERROR_DETAILS` | `true`/`false` — show full error traces in responses |
| `JWT_SCRET` | Secret used to sign access tokens |
| `JWT_EXPIRED_IN` | Access token expiry, e.g. `30d` |
| `JWT_REFRESH_SECRET` | Secret used to sign refresh tokens |
| `JWT_SCRET_SALT_ROUND` | bcrypt salt rounds |
| `DOCTOR_PASS` / `PATIENT_PASS` | Default seed passwords used by some flows |
| `CLOUND_NAME`, `API_KEY`, `API_SECRET` | Cloudinary credentials |
| `EMAIL_PASS` | Gmail App Password |
| `BACKEND_ORIGIN`, `BACKEND_ORIGIN_LOCAL` | Backend origin only (no path) — builds payment gateway return/webhook URLs |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay (India) credentials |
| `TELR_STORE_ID`, `TELR_AUTH_KEY`, `TELR_TEST_MODE` | Telr (Kuwait) credentials |
| `ADMIN_EMAIL`, `GMAIL_APP_EMAIL` | Sender/admin addresses used for outgoing mail |
| `BACKEND_LOCAL_URL` | Local API base + `/api/v1/auth/` (used in email links during dev) |
| `BACKEND_LIVE_URL` | Production API base + `/api/v1/auth/` (used in email links in production) |
| `CLIENT_URL` | Production frontend base URL — used to build password-reset links. **Found undocumented prior to Pass 3**; without it, reset-password emails contain a broken `undefined/reset-password/...` link. |
| `CLIENT__LOCAL_URL` | Local frontend base URL (double underscore is intentional — matches the actual env var name read in `config/index.ts`), used the same way in development |

---

## 6. Browser support (frontend)

Standard Create React App defaults — evergreen Chrome, Firefox, Edge, Safari. No IE11 support.

---

## 7. Summary checklist

Before deploying, make sure you have:

- [ ] Node.js 20+ installed
- [ ] A PostgreSQL database (connection string ready)
- [ ] A Cloudinary account and API credentials
- [ ] A Gmail account with an App Password generated
- [ ] A Razorpay account (India/INR bookings)
- [ ] A Telr merchant account (Kuwait/KWD bookings)
- [ ] Git installed and the repository cloned

See `DEPLOYMENT.md` for the exact commands on Windows and Linux.
