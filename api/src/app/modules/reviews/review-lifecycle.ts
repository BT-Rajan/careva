/**
 * Pass 21 — Admin & Operational Controls.
 *
 * Target model from docs/passes/01-domain-state-model.md §4.6: "SUBMITTED →
 * PUBLISHED, with FLAGGED and REMOVED as admin-moderation states."
 *
 * Every transition here is admin-only — unlike appointment/prescription/invoice,
 * there is no patient- or doctor-triggered edge in this graph. A patient can create a
 * review (which starts SUBMITTED — see reviews.service.ts) but has no action that
 * moves it between states afterward; nothing in this app has a "report this review"
 * feature for other users to trigger FLAGGED themselves, so that edge doesn't exist
 * either. If a public reporting feature is ever built, it would most likely land here
 * as its own transition with its own actor, not retrofitted onto this one.
 */
import { ReviewStatus } from '@prisma/client';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';

export type ReviewActorRole = 'admin';

export const TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
    SUBMITTED: ['PUBLISHED', 'REMOVED'],
    PUBLISHED: ['FLAGGED', 'REMOVED'],
    FLAGGED: ['PUBLISHED', 'REMOVED'],
    // REMOVED is not fully terminal — see the schema comment on ReviewStatus for why an
    // admin restoring a mistakenly-removed review is a real, supported action here in a
    // way it isn't for e.g. a voided Invoice.
    REMOVED: ['PUBLISHED'],
};

const TRANSITION_ACTORS: Record<string, ReviewActorRole[]> = {
    'SUBMITTED->PUBLISHED': ['admin'],
    'SUBMITTED->REMOVED': ['admin'],
    'PUBLISHED->FLAGGED': ['admin'],
    'PUBLISHED->REMOVED': ['admin'],
    'FLAGGED->PUBLISHED': ['admin'],
    'FLAGGED->REMOVED': ['admin'],
    'REMOVED->PUBLISHED': ['admin'],
};

export interface ReviewTransitionCheckResult {
    from: ReviewStatus;
    to: ReviewStatus;
}

export const assertValidReviewTransition = (
    currentStatus: ReviewStatus,
    requestedStatus: ReviewStatus,
    actorRole: ReviewActorRole
): ReviewTransitionCheckResult => {
    const legalNextStates = TRANSITIONS[currentStatus] ?? [];
    if (!legalNextStates.includes(requestedStatus)) {
        throw new ApiError(
            httpStatus.CONFLICT,
            `Cannot move a review from ${currentStatus} to ${requestedStatus}. Valid next states: ${legalNextStates.join(', ') || '(none — this is a terminal state)'}.`
        );
    }
    const key = `${currentStatus}->${requestedStatus}`;
    const allowedActors = TRANSITION_ACTORS[key];
    if (!allowedActors || !allowedActors.includes(actorRole)) {
        throw new ApiError(httpStatus.FORBIDDEN, `A ${actorRole} is not allowed to move a review from ${currentStatus} to ${requestedStatus}.`);
    }
    return { from: currentStatus, to: requestedStatus };
}
