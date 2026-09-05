/**
 * Pass 17 — API Contract.
 *
 * Replaces handleValidationError.ts and handleCastError.ts, which were dead on
 * arrival: both were entirely commented-out and written against `mongoose.Error.*`
 * types — this app has never used Mongoose (it's Prisma/SQL throughout, see
 * shared/prisma.ts). They were boilerplate carried over from whatever starter template
 * this project began from and could never have applied to this codebase's actual
 * stack. Deleted rather than "fixed" — there was no working version of them to restore.
 *
 * This is the real equivalent for the ORM this app actually uses: Prisma throws
 * `PrismaClientKnownRequestError` with a stable `code` for the common client-input
 * problems (duplicate unique field, missing related record, foreign-key violation).
 * Before this pass, any of these that escaped a service function (and plenty could —
 * e.g. two simultaneous requests racing past an application-level uniqueness check)
 * fell into app.ts's generic fallback branch: either a raw Prisma error message leaked
 * to the client (if `config.showErrorDetails` is on) or an opaque 500 "Something Went
 * Wrong" (if off) — never a well-formed 4xx response telling the client what was
 * actually wrong with their request.
 */
import { Prisma } from '@prisma/client';
import { IGenericErrorResponse } from '../interfaces/common';
import { IGenericErrorMessage } from '../interfaces/error';

const handlePrismaError = (error: Prisma.PrismaClientKnownRequestError): IGenericErrorResponse => {
    switch (error.code) {
        case 'P2002': {
            const target = (error.meta?.target as string[] | undefined) ?? [];
            const field = target.join(', ') || 'field';
            const errors: IGenericErrorMessage[] = [{ path: field, message: `A record with this ${field} already exists.` }];
            return { statusCode: 409, message: 'Duplicate Entry', errorMessages: errors };
        }
        case 'P2025': {
            const cause = typeof error.meta?.cause === 'string' ? error.meta.cause : 'The requested record was not found.';
            const errors: IGenericErrorMessage[] = [{ path: '', message: cause }];
            return { statusCode: 404, message: 'Not Found', errorMessages: errors };
        }
        case 'P2003': {
            const field = (error.meta?.field_name as string | undefined) ?? 'reference';
            const errors: IGenericErrorMessage[] = [{ path: field, message: `The referenced ${field} does not exist.` }];
            return { statusCode: 400, message: 'Invalid Reference', errorMessages: errors };
        }
        default: {
            // Anything else (P2000 value-too-long, P2011 null constraint, etc.) still
            // gets a well-formed 400 with Prisma's own message rather than falling
            // through to a raw 500 — better than the pre-Pass-17 fallback, even without
            // a dedicated branch for every one of Prisma's ~40 error codes.
            const errors: IGenericErrorMessage[] = [{ path: '', message: error.message }];
            return { statusCode: 400, message: 'Database Error', errorMessages: errors };
        }
    }
};

export default handlePrismaError;
