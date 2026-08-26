/**
 * Pass 17 — API Contract.
 *
 * Auth endpoints previously relied entirely on ad hoc `if (!x) throw ApiError(...)`
 * checks scattered inside each service function (changePassword still has one — see
 * its own comment) — functional, but inconsistent in what got checked where, and every
 * endpoint had to hand-roll its own. These schemas make "what does this endpoint
 * require" a single readable declaration instead of buried service-function logic, and
 * bad input a uniform 400 via handleZodError instead of whatever ad hoc message the
 * service happened to have written.
 */
import { z } from 'zod';

const LoginValidation = z.object({
    body: z.object({
        email: z.string().trim().email('A valid email is required'),
        password: z.string().min(1, 'Password is required'),
    }),
});

const ResetPasswordValidation = z.object({
    body: z.object({
        email: z.string().trim().email('A valid email is required'),
    }),
});

const ResetPasswordConfirmValidation = z.object({
    body: z.object({
        userId: z.string().min(1, 'userId is required'),
        uniqueString: z.string().min(1, 'uniqueString is required'),
        password: z.string().min(8, 'Password must be at least 8 characters'),
    }),
});

const ChangePasswordValidation = z.object({
    body: z.object({
        currentPassword: z.string().min(1, 'currentPassword is required'),
        newPassword: z.string().min(8, 'newPassword must be at least 8 characters'),
    }),
});

export const AuthValidation = {
    LoginValidation,
    ResetPasswordValidation,
    ResetPasswordConfirmValidation,
    ChangePasswordValidation,
};
