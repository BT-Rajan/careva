/**
 * Pass 7 — Payment System.
 *
 * A single contract both gateways implement, so payment.service.ts never needs to know
 * which gateway it's talking to — it picks an implementation via the factory
 * (payment-provider.factory.ts) based on the currency (INR → Razorpay, KWD → Telr) and
 * calls the same four methods either way. Adding a third market/gateway later means
 * writing one more class against this interface, not touching the booking/payment
 * service logic.
 */

export interface CreateOrderParams {
    /** Careva's own Payment.id — becomes the gateway's order/cart reference. */
    paymentId: string;
    /** Integer, smallest currency unit (paise for INR, fils for KWD). Never a float. */
    amountMinor: number;
    currency: 'INR' | 'KWD';
    description: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
}

export interface CreateOrderResult {
    /** Gateway's own order/reference id — stored as Payment.providerOrderId. */
    providerOrderId: string;
    /** Where to send the browser to complete payment (hosted checkout page, or null for
     *  gateways like Razorpay where the frontend opens an in-page checkout widget using
     *  providerOrderId directly instead of a redirect). */
    redirectUrl: string | null;
}

export interface VerifyPaymentParams {
    /** Whatever the gateway returned to the browser on return/callback — shape is
     *  gateway-specific, passed through as-is; each adapter knows its own fields. */
    payload: Record<string, any>;
}

export interface VerifyPaymentResult {
    success: boolean;
    /** Gateway's payment/transaction id, distinct from the order id. */
    providerPaymentId?: string;
    /** The exact string/value verification was computed against — stored for audit. */
    providerSignature?: string;
    /** Only trustworthy when success is true; the raw amount the gateway confirms, in
     *  minor units — callers MUST compare this against the expected amount themselves,
     *  never assume the requested amount is what was actually charged. */
    amountMinor?: number;
    failureReason?: string;
    /** Raw gateway response, kept for audit/debugging. */
    raw: Record<string, any>;
}

export interface WebhookVerificationResult {
    valid: boolean;
    /** Gateway's own event id, used for the PaymentWebhookEvent uniqueness check. */
    providerEventId?: string;
    eventType?: string;
}

export interface RefundParams {
    providerPaymentId: string;
    amountMinor: number;
    currency: 'INR' | 'KWD';
    reason?: string;
}

export interface RefundResult {
    success: boolean;
    providerRefundId?: string;
    failureReason?: string;
    raw: Record<string, any>;
}

export interface PaymentProviderAdapter {
    readonly name: 'razorpay' | 'telr';

    createOrder(params: CreateOrderParams): Promise<CreateOrderResult>;

    /** Server-side verification of a browser return/checkout callback. Never trust the
     *  browser's own claim of success — this re-derives a signature or re-queries the
     *  gateway directly and compares, per adapter. See each adapter for its exact method. */
    verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult>;

    /** Verifies an inbound webhook's authenticity. rawBody MUST be the raw request body
     *  bytes/string, not a re-serialized parsed object — signature schemes are computed
     *  over the exact bytes the gateway sent. */
    verifyWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookVerificationResult;

    refund(params: RefundParams): Promise<RefundResult>;
}
