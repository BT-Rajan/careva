/**
 * Pass 8 — Appointment State Machine.
 *
 * The target model from docs/passes/01-domain-state-model.md §4.2:
 *
 *   PENDING → SCHEDULED → COMPLETED
 *      ↓          ↓  ↓
 *   DECLINED   CANCELLED_BY_PATIENT / CANCELLED_BY_DOCTOR / CANCELLED_BY_ADMIN
 *      ↓          ↓
 *   EXPIRED    NO_SHOW
 *
 * Two things are enforced together, for every transition: (1) is the move itself legal
 * (defined in TRANSITIONS below), and (2) is the actor allowed to make that specific move
 * (defined in TRANSITION_ACTORS below) — "no arbitrary status updates" means both the
 * shape of the graph and who's allowed to walk which edge.
 */
import { AppointmentStatus } from '@prisma/client';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';

export type AppointmentActorRole = 'admin' | 'doctor' | 'patient';

/**
 * Legal next-states from each status. EXPIRED is reachable in the graph (a PENDING
 * request that nobody actioned in time) but deliberately has NO entry in
 * TRANSITION_ACTORS below — nothing here lets a human being trigger it directly. It's
 * reserved for a future scheduled job (Pass 23 — Background Jobs) that sweeps stale
 * PENDING appointments. Modeling it in the graph now means that job, when built, is
 * implementing an already-specified transition rather than inventing one.
 */
export const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
    PENDING: ['SCHEDULED', 'DECLINED', 'EXPIRED'],
    SCHEDULED: ['COMPLETED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN', 'NO_SHOW'],
    DECLINED: [],
    EXPIRED: [],
    COMPLETED: [],
    CANCELLED_BY_PATIENT: [],
    CANCELLED_BY_DOCTOR: [],
    CANCELLED_BY_ADMIN: [],
    NO_SHOW: [],
};

/**
 * Who may perform each transition. Keyed by "FROM->TO". Admin is deliberately allowed on
 * every real (human-triggerable) edge — an admin can always intervene — layered on top of
 * the specific role the edge is naturally about.
 */
const TRANSITION_ACTORS: Record<string, AppointmentActorRole[]> = {
    'PENDING->SCHEDULED': ['doctor', 'admin'],
    'PENDING->DECLINED': ['doctor', 'admin'],
    'SCHEDULED->COMPLETED': ['doctor', 'admin'],
    'SCHEDULED->NO_SHOW': ['doctor', 'admin'],
    'SCHEDULED->CANCELLED_BY_PATIENT': ['patient', 'admin'],
    'SCHEDULED->CANCELLED_BY_DOCTOR': ['doctor', 'admin'],
    'SCHEDULED->CANCELLED_BY_ADMIN': ['admin'],
};

export interface TransitionCheckResult {
    from: AppointmentStatus;
    to: AppointmentStatus;
}

/**
 * Throws if the transition is illegal (wrong shape) or unauthorized (wrong actor).
 * Callers pass the CURRENT status read fresh from the database, never a client-supplied
 * "from" value — the current status is authoritative, not something the caller asserts.
 */
export const assertValidAppointmentTransition = (
    currentStatus: AppointmentStatus,
    requestedStatus: AppointmentStatus,
    actorRole: AppointmentActorRole
): TransitionCheckResult => {
    const legalNextStates = TRANSITIONS[currentStatus] ?? [];
    if (!legalNextStates.includes(requestedStatus)) {
        throw new ApiError(
            httpStatus.CONFLICT,
            `Cannot move an appointment from ${currentStatus} to ${requestedStatus}. Valid next states: ${legalNextStates.join(', ') || '(none — this is a terminal state)'}.`
        );
    }
    const key = `${currentStatus}->${requestedStatus}`;
    const allowedActors = TRANSITION_ACTORS[key];
    if (!allowedActors) {
        // Shape says legal (e.g. PENDING->EXPIRED) but no human actor is wired up for it
        // — see the EXPIRED note above. Distinct error from "wrong actor for a real edge"
        // so this doesn't get confused with an authorization bug.
        throw new ApiError(httpStatus.CONFLICT, `${currentStatus} to ${requestedStatus} is not a transition any user can trigger directly.`);
    }
    if (!allowedActors.includes(actorRole)) {
        throw new ApiError(httpStatus.FORBIDDEN, `A ${actorRole} is not allowed to move an appointment from ${currentStatus} to ${requestedStatus}.`);
    }
    return { from: currentStatus, to: requestedStatus };
}
