/**
 * Pass 23 — Background Jobs.
 *
 * Closes the gap Pass 7 explicitly flagged: "If a patient abandons checkout, that
 * Payment row sits in PENDING indefinitely today — no background job marks it
 * EXPIRED." PaymentStatus.EXPIRED has existed in the schema since Pass 7 but, like
 * Appointments.EXPIRED before this pass, was never actually reachable from any code
 * path.
 *
 * 24 hours is this job's abandonment threshold — long enough that no legitimate,
 * still-in-progress checkout (a patient who stepped away and came back within the same
 * day) gets expired out from under them, short enough that a genuinely abandoned
 * session doesn't sit in PENDING/PROCESSING forever. Not derived from any gateway-side
 * session timeout (this app doesn't poll the gateway for that) — it's an independent,
 * conservative local policy for "this checkout is not coming back."
 *
 * Unlike the appointment sweep, this doesn't go through a dedicated lifecycle file —
 * none exists for Payment (see Pass 20's note: payment status transitions are all
 * inline checks in payment.service.ts, not a separate state-machine module). Building
 * one now, for a single background sweep, would be more scaffolding than this job
 * needs; the conditional `updateMany` below is the same optimistic-concurrency pattern
 * Pass 20 already established for payment writes.
 */
import moment from 'moment';
import prisma from '../shared/prisma';
import { logger, errorlogger } from '../shared/logger';

const ABANDONED_CHECKOUT_HOURS = 24;

export const expireStalePayments = async (): Promise<void> => {
    try {
        const cutoff = moment().subtract(ABANDONED_CHECKOUT_HOURS, 'hours').toDate();

        const candidates = await prisma.payment.findMany({
            where: {
                status: { in: ['PENDING', 'PROCESSING'] },
                createdAt: { lt: cutoff },
            },
            select: { id: true, status: true }
        });

        if (candidates.length === 0) {
            return;
        }

        let expiredCount = 0;
        for (const payment of candidates) {
            try {
                // Optimistic conditional update (Pass 20's convention) — only writes if the
                // row is still in the exact status this job read moments ago; a concurrent
                // checkout completion (the patient came back right as this job ran) simply
                // finds 0 rows matched and is silently skipped rather than overwritten.
                const result = await prisma.payment.updateMany({
                    where: { id: payment.id, status: payment.status },
                    data: { status: 'EXPIRED' }
                });
                if (result.count > 0) {
                    await prisma.auditLog.create({
                        data: {
                            actorId: null,
                            actorRole: 'system',
                            action: 'payment.status_changed',
                            entityType: 'Payment',
                            entityId: payment.id,
                            metadata: { from: payment.status, to: 'EXPIRED', reason: 'background_job_abandoned_checkout' },
                        }
                    });
                    expiredCount++;
                }
            } catch (err) {
                errorlogger.error(`[expireStalePayments] Failed to expire payment ${payment.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            }
        }

        if (expiredCount > 0) {
            logger.info(`[expireStalePayments] Expired ${expiredCount} stale PENDING/PROCESSING payment(s).`);
        }
    } catch (err) {
        // Same reasoning as expireAppointments.job.ts's outer guard — a failure
        // reading the candidate list itself must never throw uncaught into node-cron.
        errorlogger.error(`[expireStalePayments] Job run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
}
