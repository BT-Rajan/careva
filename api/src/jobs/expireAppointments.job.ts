/**
 * Pass 23 — Background Jobs.
 *
 * Implements the EXPIRED transition Pass 8 specified in the graph but deliberately
 * left untriggered: "reserved for a future scheduled job that sweeps stale PENDING
 * appointments... modeling it in the graph now means that job, when built, implements
 * an already-agreed transition instead of inventing one under time pressure later."
 *
 * Criterion: a PENDING appointment whose scheduled date/time has already passed. This
 * is deliberately an objective fact, not an invented policy number (e.g. "expire after
 * 48 hours of no response") — nobody can attend an appointment slot that's already in
 * the past, so a PENDING request past its own scheduled time is unambiguously stale
 * regardless of how quickly or slowly the doctor would otherwise have responded.
 */
import moment from 'moment';
import prisma from '../shared/prisma';
import { errorlogger, logger } from '../shared/logger';
import { assertValidAppointmentTransitionShape } from '../app/modules/appointment/appointment-state-machine';
import { InvoiceService } from '../app/modules/invoice/invoice.service';

// Mirrors the exact scheduleDate/scheduleTime combination convention already
// established in appointment.service.ts's assertSlotAvailable (scheduleTime is a
// time-only string in one of two formats, with no date attached).
const combineScheduleDateTime = (scheduleDate: string, scheduleTime: string): moment.Moment => {
    const date = moment(scheduleDate).startOf('day');
    const time = moment(scheduleTime, ['hh:mm a', 'HH:mm']);
    return date.clone().set({ hour: time.hour(), minute: time.minute(), second: 0, millisecond: 0 });
}

export const expireStalePendingAppointments = async (): Promise<void> => {
    try {
        // Pass 21's Notification model and this job's own writes both go through Prisma
        // normally — no special transaction needed for the read here, only for each
        // individual expiry below.
        const candidates = await prisma.appointments.findMany({
            where: { status: 'PENDING' },
            select: { id: true, scheduleDate: true, scheduleTime: true }
        });

        const now = moment();
        const stale = candidates.filter((a) => {
            if (!a.scheduleDate || !a.scheduleTime) return false;
            return combineScheduleDateTime(a.scheduleDate, a.scheduleTime).isBefore(now);
        });

        if (stale.length === 0) {
            return;
        }

        let expiredCount = 0;
        for (const appointment of stale) {
            try {
                await prisma.$transaction(async (tx) => {
                    const fresh = await tx.appointments.findUnique({ where: { id: appointment.id } });
                    // Re-check inside the transaction: something else (a doctor confirming
                    // or declining, a patient withdrawing) may have moved this appointment
                    // out of PENDING between the read above and this write.
                    if (!fresh || fresh.status !== 'PENDING') {
                        return;
                    }
                    assertValidAppointmentTransitionShape('PENDING', 'EXPIRED');
                    await tx.appointments.update({
                        where: { id: appointment.id },
                        data: { status: 'EXPIRED', statusChangedAt: new Date(), statusChangeReason: 'Automatically expired — no response before the scheduled time.' }
                    });
                    await tx.auditLog.create({
                        data: {
                            actorId: null,
                            actorRole: 'system',
                            action: 'appointment.status_changed',
                            entityType: 'Appointments',
                            entityId: appointment.id,
                            metadata: { from: 'PENDING', to: 'EXPIRED', reason: 'background_job' },
                        }
                    });
                    // An EXPIRED appointment never reached SCHEDULED, so per
                    // invoice.service.ts's generateInvoiceForAppointment it never had an
                    // invoice to void — this call is a defensive no-op in the overwhelming
                    // majority of cases, not something expected to find anything.
                    await InvoiceService.voidInvoiceForAppointment(tx, appointment.id, 'Appointment expired without a response', undefined, 'system');
                });
                expiredCount++;
            } catch (err) {
                errorlogger.error(`[expireStalePendingAppointments] Failed to expire appointment ${appointment.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            }
        }

        if (expiredCount > 0) {
            logger.info(`[expireStalePendingAppointments] Expired ${expiredCount} stale PENDING appointment(s).`);
        }
    } catch (err) {
        // Pass 23: this outer guard is what actually keeps a scheduled sweep from ever
        // throwing uncaught into node-cron — a failure reading the candidate list
        // itself (e.g. a transient DB blip) must not risk tripping server.ts's
        // uncaughtException handler and taking the whole process down over a
        // background job, not a real request.
        errorlogger.error(`[expireStalePendingAppointments] Job run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
}
