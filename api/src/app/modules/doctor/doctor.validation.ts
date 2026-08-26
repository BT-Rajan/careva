/**
 * Pass 17 — API Contract.
 *
 * Only the account-creation core is required here (firstName/lastName/email/password) —
 * matching the schema, where every other Doctor field is optional and filled in over
 * time as the profile is built out (see Pass 10's profile-completeness scoring, which
 * exists precisely because a doctor's profile is expected to start sparse). Requiring
 * more than the schema itself requires would just recreate a stricter contract than the
 * data model actually has.
 */
import { z } from 'zod';

const CreateDoctorValidation = z.object({
    body: z.object({
        firstName: z.string().trim().min(1, 'First name is required'),
        lastName: z.string().trim().min(1, 'Last name is required'),
        email: z.string().trim().email('A valid email is required'),
        password: z.string().min(8, 'Password must be at least 8 characters'),
    }).passthrough(),
});

export const DoctorValidation = {
    CreateDoctorValidation,
};
