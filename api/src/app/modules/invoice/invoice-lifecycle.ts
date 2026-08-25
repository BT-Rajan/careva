/**
 * Pass 14 — Invoice & Financial Records.
 *
 * Target model from docs/passes/01-domain-state-model.md §4.5:
 *
 *   ISSUED → PAID
 *      ↓       ↓
 *          VOID
 *
 * (DRAFT omitted — see the comment on the Invoice model in schema.prisma for why.)
 *
 * Unlike appointment-state-machine.ts / doctor-lifecycle.ts / prescription-lifecycle.ts,
 * this file has TWO kinds of edges, checked differently on purpose:
 *
 *  - ISSUED→PAID is SYSTEM-ONLY. It happens exactly once, the moment payment.service.ts
 *    has an actual gateway confirmation in hand (verifyAndFinalizePayment / handleWebhook)
 *    — never as a direct response to an HTTP request from any human role. There is
 *    deliberately NO entry for it in TRANSITION_ACTORS, the same convention
 *    appointment-state-machine.ts uses to reserve EXPIRED for Pass 23's background job:
 *    the shape-only `assertValidInvoiceTransitionShape` is what internal callers use for
 *    this edge, and it does not accept or check an actor at all. Nothing reachable from a
 *    route can ever request this transition directly.
 *  - ISSUED→VOID and PAID→VOID are reachable two ways: automatically (appointment
 *    cancelled/rescheduled-to-PENDING, or a full refund — see appointment.service.ts /
 *    payment.service.ts, also via the shape-only check, same reasoning as above: these
 *    are consequences of another already-authorized action, not a fresh request needing
 *    its own actor check), or manually by an admin correcting a mistake (the actor-checked
 *    `assertValidInvoiceTransition`, exposed at `POST /invoice/:id/void`).
 */
import { InvoiceStatus } from '@prisma/client';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';

export type InvoiceActorRole = 'admin' | 'doctor' | 'patient';

export const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
    ISSUED: ['PAID', 'VOID'],
    PAID: ['VOID'],
    VOID: [],
};

/** Human-triggerable edges only. ISSUED->PAID has no entry — see file header. */
const TRANSITION_ACTORS: Record<string, InvoiceActorRole[]> = {
    'ISSUED->VOID': ['admin'],
    'PAID->VOID': ['admin'],
};

export interface InvoiceTransitionCheckResult {
    from: InvoiceStatus;
    to: InvoiceStatus;
}

/** Shape-only check: is this move legal at all, regardless of who's asking. Used by
 * internal, system-triggered transitions (payment confirmation, cancellation/refund
 * voids) where the caller itself — not an end-user request — is the trust boundary. */
export const assertValidInvoiceTransitionShape = (
    currentStatus: InvoiceStatus,
    requestedStatus: InvoiceStatus
): InvoiceTransitionCheckResult => {
    const legalNextStates = TRANSITIONS[currentStatus] ?? [];
    if (!legalNextStates.includes(requestedStatus)) {
        throw new ApiError(
            httpStatus.CONFLICT,
            `Cannot move an invoice from ${currentStatus} to ${requestedStatus}. Valid next states: ${legalNextStates.join(', ') || '(none — this is a terminal state)'}.`
        );
    }
    return { from: currentStatus, to: requestedStatus };
}

/** Shape + actor check, for the one human-triggerable edge (admin manual void). */
export const assertValidInvoiceTransition = (
    currentStatus: InvoiceStatus,
    requestedStatus: InvoiceStatus,
    actorRole: InvoiceActorRole
): InvoiceTransitionCheckResult => {
    const result = assertValidInvoiceTransitionShape(currentStatus, requestedStatus);
    const key = `${currentStatus}->${requestedStatus}`;
    const allowedActors = TRANSITION_ACTORS[key];
    if (!allowedActors || !allowedActors.includes(actorRole)) {
        throw new ApiError(httpStatus.FORBIDDEN, `A ${actorRole} is not allowed to move an invoice from ${currentStatus} to ${requestedStatus}.`);
    }
    return result;
}
