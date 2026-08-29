import httpStatus from 'http-status';
import ApiError from '../../../errors/apiError';
import prisma from '../../../shared/prisma';
import { EmailtTransporter } from '../../../helpers/emailTransporter';
import { Notification } from '@prisma/client';

export interface DispatchNotificationInput {
    recipientId?: string | null;
    recipientRole: 'patient' | 'doctor' | 'admin' | 'guest';
    recipientEmail: string;
    event: string;
    subject: string;
    pathName: string;
    replacementObj: any;
    relatedEntityType?: string;
    relatedEntityId?: string;
}

/**
 * Pass 16. THE replacement for every bare `EmailtTransporter(...)` call in this app.
 * Two guarantees the old ad hoc call sites didn't consistently have:
 *
 *  1. Never throws, never returns a rejected promise — regardless of whether the
 *     caller awaits it. Three of the six pre-Pass-16 call sites (doctor.service.ts's
 *     verification email, auth.service.ts's reset-password email — both `await`ed
 *     inside a try/catch that re-threw; the reset-password one was even inside its own
 *     `$transaction`, so a flaky mail server could roll back token creation) would
 *     fail the caller's entire request over a transient email problem. The other three
 *     (appointment.service.ts's booking/cancellation/reschedule emails) were already
 *     `.catch()`-guarded (Pass 6/9) but left no record that anything was ever attempted.
 *     This function is safe to call fire-and-forget OR awaited; either way the caller's
 *     own success/failure is never coupled to whether the email actually sent.
 *  2. Persists what happened. Every call creates a `Notification` row up front
 *     (PENDING), then updates it to SENT or FAILED with the actual provider error —
 *     turning "did this person get notified" from an unanswerable question (nothing
 *     but a server log line, if that) into a queryable fact.
 */
const dispatchNotification = async (input: DispatchNotificationInput): Promise<Notification | null> => {
    // Pass 16: the whole point of this function is that NOTHING it does can propagate
    // an exception to the caller — that's the guarantee documented above, and every
    // fix in this pass (doctor.service.ts's verification email, auth.service.ts's
    // reset-password email) depends on it actually holding, including at call sites
    // that `await` this without their own `.catch()`. The initial persistence write
    // itself needs the same guard as the send attempt — a DB hiccup creating the
    // tracking row is still not something a caller's unrelated business logic should
    // fail over. Returns null (rather than throwing) if even the tracking row couldn't
    // be created — the notification attempt is lost in that case, same as it would
    // have been before this pass existed, just no longer able to crash the caller.
    try {
        const notification = await prisma.notification.create({
            data: {
                recipientId: input.recipientId ?? null,
                recipientRole: input.recipientRole,
                recipientEmail: input.recipientEmail,
                channel: 'EMAIL',
                event: input.event,
                subject: input.subject,
                templatePath: input.pathName,
                templateData: input.replacementObj,
                status: 'PENDING',
                relatedEntityType: input.relatedEntityType,
                relatedEntityId: input.relatedEntityId,
            }
        });
        await attemptSend(notification.id, input.pathName, input.replacementObj, input.recipientEmail, input.subject);
        // Re-read rather than trust the in-memory object: attemptSend just updated it.
        return await prisma.notification.findUnique({ where: { id: notification.id } });
    } catch (err) {
        console.error(`Failed to create/send notification (event: ${input.event}):`, err);
        return null;
    }
}

const attemptSend = async (notificationId: string, pathName: string, replacementObj: any, toMail: string, subject: string): Promise<void> => {
    try {
        await EmailtTransporter({ pathName, replacementObj, toMail, subject });
        await prisma.notification.update({
            where: { id: notificationId },
            data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null }
        });
    } catch (err: any) {
        console.error(`Notification ${notificationId} (${subject}) failed to send:`, err);
        await prisma.notification.update({
            where: { id: notificationId },
            data: { status: 'FAILED', attempts: { increment: 1 }, lastError: String(err?.message ?? err) }
        });
    }
}

/**
 * Pass 16 — manual retry only. Re-sending automatically on a schedule (a real
 * background-job retrier for FAILED notifications) is Pass 23's job (Background Jobs);
 * this is the admin-triggered "try this one again right now" action the data model
 * needs to already support so that future automated retry has something to call.
 */
const retryNotification = async (reqUser: any, id: string): Promise<Notification> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can retry a notification !!');
    }
    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Notification is not found !!');
    }
    if (notification.status === 'SENT') {
        throw new ApiError(httpStatus.CONFLICT, 'This notification was already sent !!');
    }
    await attemptSend(id, notification.templatePath, notification.templateData, notification.recipientEmail, notification.subject);
    return prisma.notification.findUniqueOrThrow({ where: { id } });
}

// Pass 23 — Background Jobs. The automated counterpart to retryNotification above,
// called from jobs/retryFailedNotifications.job.ts on a schedule rather than an admin
// click. Caps retries at MAX_AUTO_RETRY_ATTEMPTS — a permanently-broken recipient
// address (typo'd email, a mailbox that will never accept mail) must not be retried
// forever; once a notification has failed that many times, it stays FAILED for an
// admin to look at manually rather than the job silently hammering the same dead
// address on every run indefinitely.
const MAX_AUTO_RETRY_ATTEMPTS = 5;

const retryFailedNotificationsBatch = async (): Promise<{ retried: number; nowSent: number }> => {
    const candidates = await prisma.notification.findMany({
        where: { status: 'FAILED', attempts: { lt: MAX_AUTO_RETRY_ATTEMPTS } },
        take: 200,
    });
    let nowSent = 0;
    for (const notification of candidates) {
        await attemptSend(notification.id, notification.templatePath, notification.templateData, notification.recipientEmail, notification.subject);
        const updated = await prisma.notification.findUnique({ where: { id: notification.id } });
        if (updated?.status === 'SENT') {
            nowSent++;
        }
    }
    return { retried: candidates.length, nowSent };
}

const getNotifications = async (reqUser: any, filters: { status?: string, recipientId?: string }): Promise<Notification[]> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can view notifications !!');
    }
    return prisma.notification.findMany({
        where: {
            ...(filters.status ? { status: filters.status as any } : {}),
            ...(filters.recipientId ? { recipientId: filters.recipientId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
    });
}

const getNotificationById = async (reqUser: any, id: string): Promise<Notification> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can view notifications !!');
    }
    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Notification is not found !!');
    }
    return notification;
}

export const NotificationService = {
    dispatchNotification,
    retryNotification,
    retryFailedNotificationsBatch,
    getNotifications,
    getNotificationById,
}
