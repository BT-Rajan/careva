# Pass 27 — Multi-Tenant Clinics

Status: **Schema complete. Query-scoping (Pass 28) and onboarding/credentials
(Pass 29+) not started.**

Scope of this pass: `schema.prisma` only, plus the manual migration SQL and this doc.
No service, controller, or frontend code has been touched yet — those are later passes,
listed below.

---

## Why this pass exists

Careva was a single-tenant, multi-doctor marketplace: one admin, one Razorpay/Telr
account, one Gmail sender, one Cloudinary account, for the whole deployment. Selling it
to multiple independent clinics on the same deployment meant Clinic A's admin could
search, list, and view Clinic B's doctors and patients through every existing endpoint —
not a bug in any one route, a structural absence of a tenant concept anywhere in the
schema.

The chosen design (see product decision, not an engineering default): doctors get
individual public pages under the same domain rather than per-clinic subdomains, and
each clinic brings its own Gmail and image-hosting credentials rather than sharing the
platform's. That second point is *why* `Clinic` carries its own credential fields
instead of assuming one platform-wide sender/uploader.

## The one design choice everything else follows from

**A doctor is not owned by a clinic — a doctor can be affiliated with several.** This
is what `DoctorClinic` (new join table) exists for, and it's the reason approval status
moved off `Doctor` and onto `DoctorClinic`: a doctor can be `APPROVED` at Clinic A and
still `PENDING_APPROVAL` (or `REJECTED`) at Clinic B. Their login, profile, and
`verified` (email-verified) flag stay global on `Doctor` — those are properties of the
person, not the affiliation.

Patients did **not** get this treatment — a patient belongs to exactly one clinic
(`Patient.clinicId`, required, not a join table). Nothing in the requirements asked for
a patient visiting two different clinics to be the same account, so this pass didn't
build that; if that ever becomes a real requirement, `Patient` would need the same
join-table treatment `Doctor` just got here.

**`Appointments.clinicId` cannot be inferred from `doctorId`** once a doctor can belong
to more than one clinic — the same `doctorId` can now legitimately have appointments
under two different `clinicId`s. This is the field that actually implements the
isolation rule: a query scoped to `clinicId = A` returns doctor X's appointments at
Clinic A and nothing about doctor X at Clinic B, nor any other doctor or patient at
Clinic B, without needing any doctor-specific logic at all.

The same reasoning applies to `DoctorTimeSlot` — a doctor's Monday hours at Clinic A
are independent of their Monday hours at Clinic B, so that table needed `clinicId` too,
not just `Appointments`.

## JWT / auth model this schema is built for (not yet implemented — Pass 28)

| Role | `clinicId` on token | Scoping |
|---|---|---|
| `super_admin` | none | Deliberately unscoped — platform ops/support only |
| `admin` | required, one clinic | Every query WHERE `clinicId = token.clinicId` |
| `doctor` | none | Global by design — a doctor's own "my appointments" view is legitimately cross-clinic (it's their whole practice). The boundary is enforced on the *admin* side: an admin can never query a resource whose `clinicId` isn't theirs, regardless of which doctor it belongs to. |
| `patient` | required, one clinic | Same as admin — patients don't cross clinics |

## What's deliberately NOT in this pass

- **Reviews, Blogs, Prescription, Invoice** don't have `clinicId` yet. Same fix, same
  pattern, deferred to Pass 28 alongside the query-scoping work rather than sprawling
  this schema pass across every table at once.
- **No service/controller changes.** `getAllDoctors`, appointment listing, admin
  dashboards, etc. still query without a `clinicId` filter — the schema now supports
  scoping, but nothing enforces it yet. **Do not treat this pass as closing the
  Clinic-A-sees-Clinic-B leak** — it only makes closing it possible.
- **No credential encryption implementation.** `Clinic.gmailAppPassEnc` /
  `imageApiSecretEnc` are named and shaped for encrypted storage but nothing encrypts,
  decrypts, or reads them yet — that's the per-clinic email/image work (Pass 29+).
- **No self-serve clinic signup flow.** The `Clinic` table exists; nothing creates a
  row in it yet outside the migration's one legacy-clinic backfill.
- **No super_admin UI or route protection.** The role exists in the enum; no middleware
  or dashboard uses it yet.

## Migration

Hand-written SQL at `api/prisma/migrations/manual/2026-09-12_pass27_multi_tenant_clinics.sql`
— see that file's header for why it's manual (no existing migration history to diff
against) and the ordering rationale (nullable columns → backfill → NOT NULL
constraints). Run `npx prisma validate` against the updated `schema.prisma` and test the
SQL against a staging copy before production; MariaDB DDL is not fully transactional.

## Next passes

Updated after Pass 28 actually ran (see docs/passes/28-multi-tenant-clinics-query-scoping.md):

- **Pass 28** (done, partial) — scoped auth/doctor/patient/appointment/doctorTimeSlot —
  the core booking flow and the two worst leaks (fully unscoped admin listing +
  deletion in appointments).
- **Pass 29** — the same query-scoping work for Reviews, Blogs, Prescription, Invoice,
  Medicines, Favourites, Notification, plus all frontend wiring (several call sites now
  need `clinicId` added to their requests, and Doctors.jsx's admin table needs updating
  for approvalStatus's new location on the `clinics` relation instead of directly on
  Doctor).
- **Pass 30** — per-clinic Gmail sending (credential encryption + notification.service.ts
  swapped from global `.env` to per-clinic lookup, with the global env as fallback for
  clinics that haven't configured their own).
  Doctor public page slugs/routing.
- **Pass 31** — per-clinic image hosting (same credential pattern, generalized upload
  utility).
- **Pass 32** — self-serve "create your clinic" signup flow.
