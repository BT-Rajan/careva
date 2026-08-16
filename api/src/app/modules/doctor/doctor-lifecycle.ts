/**
 * Pass 10 — Doctor Lifecycle.
 *
 * Separates two concepts that were previously conflated into one boolean
 * (`Doctor.verified`): EMAIL verification (unchanged, still gates login) and ADMIN
 * APPROVAL (new — this file). Confirmed while building this that nothing in the app
 * enforced approval as a precondition for anything: an admin-never-reviewed doctor was
 * fully bookable and fully visible in public search before this pass. See
 * docs/passes/10-doctor-lifecycle.md.
 *
 *   PENDING_APPROVAL → APPROVED → SUSPENDED ⇄ APPROVED
 *          ↓              ↓
 *      REJECTED      DEACTIVATED ⇄ APPROVED
 *          ↓
 *   PENDING_APPROVAL (admin re-opens for review)
 *
 * "Profile Complete" (also part of the plan's target lifecycle) already exists as a real,
 * implemented concept — client-side only, in src/utils/doctorProfileCompletion.js, which
 * gates the doctor's own dashboard until required fields are filled. getProfileCompleteness
 * below is a server-side port of the exact same field checks (kept in sync deliberately —
 * see its own comment), used to block PENDING_APPROVAL → APPROVED for an incomplete
 * profile. A client-only gate can't be trusted for something that decides whether an
 * admin's approval action is even allowed to succeed.
 */
import { DoctorApprovalStatus } from '@prisma/client';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';

export type DoctorActorRole = 'admin' | 'doctor';

export const TRANSITIONS: Record<DoctorApprovalStatus, DoctorApprovalStatus[]> = {
    PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
    APPROVED: ['SUSPENDED', 'DEACTIVATED'],
    REJECTED: ['PENDING_APPROVAL'],
    SUSPENDED: ['APPROVED'],
    DEACTIVATED: ['APPROVED'],
};

const TRANSITION_ACTORS: Record<string, DoctorActorRole[]> = {
    'PENDING_APPROVAL->APPROVED': ['admin'],
    'PENDING_APPROVAL->REJECTED': ['admin'],
    'REJECTED->PENDING_APPROVAL': ['admin'],
    'APPROVED->SUSPENDED': ['admin'],
    // A doctor can take themselves offline (going on leave, etc.) without admin
    // involvement; only an admin can lift a suspension or re-approve after rejection.
    'APPROVED->DEACTIVATED': ['admin', 'doctor'],
    'SUSPENDED->APPROVED': ['admin'],
    'DEACTIVATED->APPROVED': ['admin', 'doctor'],
};

export const assertValidDoctorApprovalTransition = (
    currentStatus: DoctorApprovalStatus,
    requestedStatus: DoctorApprovalStatus,
    actorRole: DoctorActorRole
): void => {
    const legalNextStates = TRANSITIONS[currentStatus] ?? [];
    if (!legalNextStates.includes(requestedStatus)) {
        throw new ApiError(
            httpStatus.CONFLICT,
            `Cannot move a doctor account from ${currentStatus} to ${requestedStatus}. Valid next states: ${legalNextStates.join(', ') || '(none)'}.`
        );
    }
    const key = `${currentStatus}->${requestedStatus}`;
    const allowedActors = TRANSITION_ACTORS[key];
    if (!allowedActors || !allowedActors.includes(actorRole)) {
        throw new ApiError(httpStatus.FORBIDDEN, `A ${actorRole} is not allowed to move a doctor account from ${currentStatus} to ${requestedStatus}.`);
    }
}

export interface ProfileCompletenessResult {
    complete: boolean;
    missing: string[];
}

/**
 * Server-side mirror of src/utils/doctorProfileCompletion.js's getDoctorProfileProgress.
 * Deliberately kept as the same six checks, same field names, same 30-character
 * biography threshold — if that file changes, this one needs to change with it (there's
 * no shared package between frontend and backend to import from directly). Flagged here
 * and in the frontend file's own comment so the duplication is visible, not silent.
 */
export const getProfileCompleteness = (doctor: any): ProfileCompletenessResult => {
    const checks: [boolean, string][] = [
        [!!(doctor?.phone && String(doctor.phone).trim()), 'Phone number'],
        [!!(doctor?.specialization && String(doctor.specialization).trim()), 'Specialization'],
        [!!(doctor?.designation && String(doctor.designation).trim()), 'Designation'],
        [!!(doctor?.clinicName?.trim() || doctor?.clinicAddress?.trim()), 'Clinic name or address'],
        [!!(doctor?.biography && String(doctor.biography).trim().length >= 30), 'Biography (at least 30 characters)'],
        [!!(doctor?.price != null && String(doctor.price).trim()), 'Consultation fee'],
    ];
    const missing = checks.filter(([ok]) => !ok).map(([, label]) => label);
    return { complete: missing.length === 0, missing };
}
