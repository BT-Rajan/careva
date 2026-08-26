import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { NotificationController } from './notification.controller';

const router = express.Router();

// Pass 16 — Notifications. Admin-only: this is an operational/support view (delivery
// tracking, manual retry), not something a patient or doctor needs a self-service view
// into for their own notifications in this pass.
router.get('/', auth(AuthUser.ADMIN), NotificationController.getNotifications);
router.get('/:id', auth(AuthUser.ADMIN), NotificationController.getNotificationById);
router.patch('/:id/retry', auth(AuthUser.ADMIN), NotificationController.retryNotification);

export const NotificationRouter = router;
