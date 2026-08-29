/**
 * Pass 23 — Background Jobs.
 *
 * This app is a single Express process with no separate worker/queue infrastructure
 * (no Redis, no BullMQ) — `node-cron` (a new, minimal dependency added by this pass)
 * runs scheduled sweeps in-process, matching the app's actual deployment model rather
 * than introducing infrastructure it doesn't otherwise need. Started once from
 * server.ts's bootstrap(), after the HTTP server is listening.
 *
 * Every job function is individually try/caught internally (see each job file) — a
 * failure in one scheduled run is logged via the real logger (Pass 22) and must never
 * throw uncaught into node-cron's scheduler, which would otherwise trip the
 * uncaughtException handler server.ts installs and take the whole process down over a
 * background sweep, not a real request.
 */
import cron from 'node-cron';
import { expireStalePendingAppointments } from './expireAppointments.job';
import { expireStalePayments } from './expirePayments.job';
import { retryFailedNotifications } from './retryFailedNotifications.job';
import { logger } from '../shared/logger';

export const startBackgroundJobs = (): void => {
    // Every 15 minutes — frequent enough that a stale PENDING appointment or an
    // abandoned checkout doesn't sit around for hours before being cleaned up, without
    // running so often it adds meaningful load to the database.
    cron.schedule('*/15 * * * *', expireStalePendingAppointments);
    cron.schedule('*/15 * * * *', expireStalePayments);
    // Every 10 minutes — a shorter interval than the expiry sweeps above, since a
    // notification retry succeeding sooner (e.g. a transient mail-provider blip
    // clearing up) directly benefits whoever was waiting on that email.
    cron.schedule('*/10 * * * *', retryFailedNotifications);

    logger.info('[jobs] Background jobs scheduled: expireStalePendingAppointments, expireStalePayments, retryFailedNotifications.');
}
