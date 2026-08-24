/**
 * Pass 13 — Prescription & Treatment.
 *
 * The target model from docs/passes/01-domain-state-model.md §4.4:
 *
 *   ISSUED → FULFILLED
 *      ↓        ↓
 *   CORRECTED (creates a new linked version; original row stays intact for audit)
 *
 *   ISSUED / FULFILLED → ARCHIVED   (visibility only — does not erase history)
 *
 * Same two-part enforcement as appointment-state-machine.ts and doctor-lifecycle.ts:
 * (1) is the move itself legal (TRANSITIONS), and (2) is the actor allowed to make that
 * specific move (TRANSITION_ACTORS).
 *
 * CORRECTED and ARCHIVED are both deliberately terminal here. CORRECTED is terminal
 * because the row it's applied to is no longer "the current record" once superseded —
 * any further change belongs on the new version, not this one. ARCHIVED is terminal
 * because no caller anywhere asked for an "unarchive" action; adding a reverse edge
 * nobody can trigger would just be speculative surface. Both are one-way by design, not
 * by oversight — revisit if a real need for either surfaces.
 */
import { PrescriptionStatus } from '@prisma/client';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';

export type PrescriptionActorRole = 'admin' | 'doctor' | 'patient';

export const TRANSITIONS: Record<PrescriptionStatus, PrescriptionStatus[]> = {
    ISSUED: ['FULFILLED', 'CORRECTED', 'ARCHIVED'],
    FULFILLED: ['CORRECTED', 'ARCHIVED'],
    CORRECTED: [],
    ARCHIVED: [],
};

/**
 * Who may perform each transition. Keyed by "FROM->TO". Admin is allowed on every real
 * edge, same convention as the other two state machines in this app.
 *
 * ISSUED->FULFILLED includes 'patient': only the patient reliably knows whether they
 * actually obtained the medication — a doctor or admin can also record it (e.g. the
 * patient reports it at a follow-up visit), but the primary actor is the patient
 * themselves, unlike every other edge here which is clinical/administrative.
 */
const TRANSITION_ACTORS: Record<string, PrescriptionActorRole[]> = {
    'ISSUED->FULFILLED': ['patient', 'doctor', 'admin'],
    'ISSUED->CORRECTED': ['doctor', 'admin'],
    'ISSUED->ARCHIVED': ['doctor', 'admin'],
    'FULFILLED->CORRECTED': ['doctor', 'admin'],
    'FULFILLED->ARCHIVED': ['doctor', 'admin'],
};

export interface PrescriptionTransitionCheckResult {
    from: PrescriptionStatus;
    to: PrescriptionStatus;
}

/**
 * Throws if the transition is illegal (wrong shape) or unauthorized (wrong actor).
 * Callers pass the CURRENT status read fresh from the database, never a client-supplied
 * "from" value.
 */
export const assertValidPrescriptionTransition = (
    currentStatus: PrescriptionStatus,
    requestedStatus: PrescriptionStatus,
    actorRole: PrescriptionActorRole
): PrescriptionTransitionCheckResult => {
    const legalNextStates = TRANSITIONS[currentStatus] ?? [];
    if (!legalNextStates.includes(requestedStatus)) {
        throw new ApiError(
            httpStatus.CONFLICT,
            `Cannot move a prescription from ${currentStatus} to ${requestedStatus}. Valid next states: ${legalNextStates.join(', ') || '(none — this is a terminal state)'}.`
        );
    }
    const key = `${currentStatus}->${requestedStatus}`;
    const allowedActors = TRANSITION_ACTORS[key];
    if (!allowedActors || !allowedActors.includes(actorRole)) {
        throw new ApiError(httpStatus.FORBIDDEN, `A ${actorRole} is not allowed to move a prescription from ${currentStatus} to ${requestedStatus}.`);
    }
    return { from: currentStatus, to: requestedStatus };
}
