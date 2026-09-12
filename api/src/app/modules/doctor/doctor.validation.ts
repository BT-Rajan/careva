/**
 * Pass 17 — API Contract.
 *
 * Only the account-creation core is required here (firstName/lastName/email/password) —
 * matching the schema, where every other Doctor field is optional and filled in over
 * time as the profile is built out (see Pass 10's profile-completeness scoring, which
 * exists precisely because a doctor's profile is expected to start sparse). Requiring
 * more than the schema itself requires would just recreate a stricter contract than the
 * data model actually has.
 *
 * Pass 28 — Multi-Tenant Clinics (query scoping). clinicId is now required at signup —
 * without it, a newly created doctor would have zero DoctorClinic affiliations and be
 * invisible to every listing (public or admin) and unbookable everywhere, which isn't a
 * safe default to silently allow. This is "which clinic are you applying to join,"
 * distinct from approval — the doctor still starts PENDING_APPROVAL at that clinic (see
 * doctor.service.ts's create).
 */
import { z } from 'zod';

const CreateDoctorValidation = z.object({
    body: z.object({
        firstName: z.string().trim().min(1, 'First name is required'),
        lastName: z.string().trim().min(1, 'Last name is required'),
        email: z.string().trim().email('A valid email is required'),
        password: z.string().min(8, 'Password must be at least 8 characters'),
        clinicId: z.string().trim().min(1, 'clinicId is required'),
    }).passthrough(),
});

export const DoctorValidation = {
    CreateDoctorValidation,
};
