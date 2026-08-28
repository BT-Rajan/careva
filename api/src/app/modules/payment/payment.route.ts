import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { PaymentController } from './payment.controller';
import { paymentWebhookRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post('/:paymentId/checkout', auth(AuthUser.PATIENT, AuthUser.DOCTOR, AuthUser.ADMIN), PaymentController.getCheckout);
router.post('/:paymentId/verify', auth(AuthUser.PATIENT, AuthUser.DOCTOR, AuthUser.ADMIN), PaymentController.verifyPayment);
router.post('/:paymentId/refund', auth(AuthUser.ADMIN), PaymentController.refund);

// Pass 21 — Admin & Operational Controls. Registered before /:paymentId/... routes
// isn't actually necessary here (different literal path), but grouped together for
// readability — these are the two reconciliation-queue endpoints Pass 20 flagged.
router.get('/reconciliation', auth(AuthUser.ADMIN), PaymentController.getReconciliationQueue);
router.patch('/:paymentId/resolve-reconciliation', auth(AuthUser.ADMIN), PaymentController.resolveReconciliation);

// Telr redirects the browser here — no auth possible (see payment.controller.ts).
router.get('/telr/return/success', PaymentController.telrReturn('success'));
router.get('/telr/return/declined', PaymentController.telrReturn('declined'));
router.get('/telr/return/cancelled', PaymentController.telrReturn('cancelled'));

// Webhook endpoints — rate-limited (defense in depth). Raw-body capture for signature
// verification happens globally in app.ts (req.rawBody), not here — see that file for why.
router.post('/webhook/razorpay', paymentWebhookRateLimiter, PaymentController.webhook('razorpay'));
router.post('/webhook/telr', paymentWebhookRateLimiter, PaymentController.webhook('telr'));

export const PaymentRouter = router;
