/**
 * Pass 7 — Payment System. Razorpay adapter — handles India (INR).
 *
 * Built against Razorpay's documented conventions (Orders API, HMAC-SHA256 signature
 * verification, X-Razorpay-Signature webhook header, x-razorpay-event-id for dedup) —
 * see docs/passes/07-payment-system.md for sources. NOT executed against a live Razorpay
 * account in this sandbox (no network access to Razorpay's API here) — needs a real
 * sandbox/test-mode credential to exercise end-to-end before going live.
 */
import Razorpay from 'razorpay';
import crypto from 'crypto';
import config from '../../../../config';
import {
    CreateOrderParams,
    CreateOrderResult,
    PaymentProviderAdapter,
    RefundParams,
    RefundResult,
    VerifyPaymentParams,
    VerifyPaymentResult,
    WebhookVerificationResult,
} from './payment-provider.interface';

const getClient = (): Razorpay => {
    if (!config.razorpay.keyId || !config.razorpay.keySecret) {
        throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.');
    }
    return new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
};

export class RazorpayProviderAdapter implements PaymentProviderAdapter {
    readonly name = 'razorpay' as const;

    async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
        const client = getClient();
        // Razorpay's Orders API natively wants amount in the smallest currency unit
        // (paise for INR) — matches our internal minor-unit representation directly, no
        // conversion needed here (unlike Telr, see telr.provider.ts).
        const order = await client.orders.create({
            amount: params.amountMinor,
            currency: params.currency,
            receipt: params.paymentId,
            notes: { paymentId: params.paymentId, description: params.description },
        });
        return {
            providerOrderId: order.id,
            // Razorpay's standard integration opens an in-page checkout widget using the
            // order id directly — there's no separate hosted redirect URL the way Telr
            // has. The frontend needs the Razorpay Checkout.js widget for this; see the
            // "what this pass did not build" note in docs/passes/07-payment-system.md.
            redirectUrl: null,
        };
    }

    async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = params.payload;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return { success: false, failureReason: 'Missing razorpay_order_id/payment_id/signature in callback payload', raw: params.payload };
        }
        if (!config.razorpay.keySecret) {
            throw new Error('RAZORPAY_KEY_SECRET is not configured.');
        }
        // Documented Razorpay scheme: HMAC-SHA256 of "order_id|payment_id", keyed with
        // the API key secret (NOT the separate webhook secret — different key on purpose).
        const expectedSignature = crypto
            .createHmac('sha256', config.razorpay.keySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        const providedBuf = Buffer.from(razorpay_signature, 'hex');
        const expectedBuf = Buffer.from(expectedSignature, 'hex');
        const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

        if (!valid) {
            return { success: false, providerPaymentId: razorpay_payment_id, failureReason: 'Signature mismatch', raw: params.payload };
        }

        // Signature match proves authenticity, not necessarily the amount — per the
        // interface contract, the caller (payment.service.ts) still compares the
        // gateway-confirmed amount against what was expected before trusting this.
        // Razorpay's signature scheme doesn't embed amount, so an explicit follow-up
        // fetch of the payment (client.payments.fetch) is needed to get the confirmed
        // amount — done in payment.service.ts's reconciliation step, not duplicated here.
        return { success: true, providerPaymentId: razorpay_payment_id, providerSignature: razorpay_signature, raw: params.payload };
    }

    verifyWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookVerificationResult {
        if (!config.razorpay.webhookSecret) {
            throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured.');
        }
        const signatureHeader = headers['x-razorpay-signature'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (!signature) {
            return { valid: false };
        }
        // MUST be computed over the raw body bytes, not a re-serialized parsed object —
        // see the route wiring in payment.route.ts, which uses express.raw() for this
        // endpoint specifically instead of the app-wide JSON body parser.
        const expected = crypto
            .createHmac('sha256', config.razorpay.webhookSecret)
            .update(rawBody)
            .digest('hex');

        const providedBuf = Buffer.from(signature, 'hex');
        const expectedBuf = Buffer.from(expected, 'hex');
        const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
            return { valid: false };
        }
        let parsed: any;
        try {
            parsed = JSON.parse(rawBody);
        } catch {
            return { valid: false };
        }
        const eventIdHeader = headers['x-razorpay-event-id'];
        const providerEventId = Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader;
        return { valid: true, providerEventId, eventType: parsed?.event };
    }

    async refund(params: RefundParams): Promise<RefundResult> {
        const client = getClient();
        try {
            const refund = await client.payments.refund(params.providerPaymentId, {
                amount: params.amountMinor,
                notes: params.reason ? { reason: params.reason } : undefined,
            });
            return { success: true, providerRefundId: refund.id, raw: refund as any };
        } catch (error: any) {
            return { success: false, failureReason: error?.message ?? 'Refund request failed', raw: error?.error ?? {} };
        }
    }
}
