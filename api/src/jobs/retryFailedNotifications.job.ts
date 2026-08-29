/**
 * Pass 23 — Background Jobs.
 *
 * Closes the gap Pass 16 explicitly flagged: "No automated retry / scheduled re-send
 * of FAILED notifications. That's Pass 23's job." A thin wrapper around
 * notification.service.ts's retryFailedNotificationsBatch (which owns the actual retry
 * cap/policy) — this file is just the schedule trigger and logging.
 */
import { logger, errorlogger } from '../shared/logger';
import { NotificationService } from '../app/modules/notification/notification.service';

export const retryFailedNotifications = async (): Promise<void> => {
    try {
        const { retried, nowSent } = await NotificationService.retryFailedNotificationsBatch();
        if (retried > 0) {
            logger.info(`[retryFailedNotifications] Retried ${retried} failed notification(s); ${nowSent} now sent.`);
        }
    } catch (err) {
        errorlogger.error(`[retryFailedNotifications] Batch retry failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
}
