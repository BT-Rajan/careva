/**
 * Pass 7 — Payment System. Telr adapter — handles Kuwait (KWD).
 *
 * Built against Telr's documented Hosted Payment Page conventions: a single endpoint
 * (POST https://secure.telr.com/gateway/order.json), ivp_-prefixed form fields, and a
 * `check` method for server-side status verification — see
 * docs/passes/07-payment-system.md for sources. NOT executed against a live Telr account
 * in this sandbox (no network access to Telr's API here).
 *
 * IMPORTANT — flagged prominently, not just in the docs: unlike Razorpay, no confirmed,
 * documented webhook *signature* scheme for Telr's Hosted Payment Page flow was found
 * while building this (their model appears to center on redirect + server-side `check`
 * verification rather than a signed push webhook the way Razorpay does it). Rather than
 * invent a plausible-sounding but unverified signature algorithm, verifyWebhookSignature
 * below is intentionally NOT a real signature check — see its own comment. The safe,
 * confirmed path this adapter actually relies on is verifyPayment, which calls Telr's
 * `check` API directly rather than trusting anything the browser or an inbound request
 * claims. Confirm Telr's current webhook/IPN signature spec (if they have one) against
 * your own merchant dashboard docs before enabling push-webhook trust for Telr.
 */
import crypto from 'crypto';
import config from '../../../../config';
import { formatMinorUnitsAsDecimalString, toMinorUnits } from '../../../../shared/money';
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

const TELR_ENDPOINT = 'https://secure.telr.com/gateway/order.json';

const requireCreds = () => {
    if (!config.telr.storeId || !config.telr.authKey) {
        throw new Error('TELR_STORE_ID / TELR_AUTH_KEY are not configured.');
    }
    return { storeId: config.telr.storeId, authKey: config.telr.authKey };
};

const telrRequest = async (fields: Record<string, string | number>): Promise<any> => {
    const body = new URLSearchParams(fields as Record<string, string>).toString();
    const response = await fetch(TELR_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    return response.json();
};

// Telr's documented order-status codes (from the `check` method response,
// order.status.code) — 1 Pending, 2 Authorised/Cancelled-varies-by-source, 3 Paid,
// 4 Declined/Expired-varies-by-source. Only "3 = Paid" was consistently confirmed across
// sources while building this adapter; the others are mapped conservatively (treated as
// not-yet-succeeded) rather than guessed precisely — reconciliation in payment.service.ts
// falls back to UNKNOWN_RECONCILING for anything that doesn't clearly match, rather than
// silently assuming success or failure. Confirm the full code table against Telr's
// current docs before relying on anything other than the confirmed "3 = Paid".
const TELR_STATUS_PAID = 3;

export class TelrProviderAdapter implements PaymentProviderAdapter {
    readonly name = 'telr' as const;

    async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
        const { storeId, authKey } = requireCreds();
        const amountStr = formatMinorUnitsAsDecimalString(params.amountMinor, params.currency);
        const origin = config.backendOrigin;
        if (!origin) {
            throw new Error('BACKEND_ORIGIN / BACKEND_ORIGIN_LOCAL is not configured — required to build Telr return URLs.');
        }
        const result = await telrRequest({
            ivp_method: 'create',
            ivp_store: storeId,
            ivp_authkey: authKey,
            ivp_amount: amountStr,
            ivp_currency: params.currency,
            ivp_test: config.telr.testMode ? 1 : 0,
            // Telr requires a unique cart id per order; Payment.id already is unique.
            ivp_cart: params.paymentId,
            ivp_desc: params.description,
            return_auth: `${origin}/api/v1/payment/telr/return/success?paymentId=${params.paymentId}`,
            return_decl: `${origin}/api/v1/payment/telr/return/declined?paymentId=${params.paymentId}`,
            return_can: `${origin}/api/v1/payment/telr/return/cancelled?paymentId=${params.paymentId}`,
            ...(params.customerEmail ? { bill_email: params.customerEmail } : {}),
            ...(params.customerName ? { bill_fname: params.customerName } : {}),
        });

        if (result?.error) {
            throw new Error(`Telr order creation failed: ${result.error.message ?? 'unknown error'} — ${result.error.note ?? ''}`);
        }
        return {
            providerOrderId: result.order.ref,
            redirectUrl: result.order.url,
        };
    }

    async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
        const { storeId, authKey } = requireCreds();
        const orderRef = params.payload.order_ref ?? params.payload.orderRef;
        if (!orderRef) {
            return { success: false, failureReason: 'Missing order_ref for Telr status check', raw: params.payload };
        }
        // This is the authoritative check — never trust the return_auth/return_decl
        // redirect alone (the browser could be redirected to return_auth by anything,
        // not necessarily a real successful payment). Always re-query Telr directly.
        const result = await telrRequest({
            ivp_method: 'check',
            ivp_store: storeId,
            ivp_authkey: authKey,
            order_ref: orderRef,
        });

        if (result?.error) {
            return { success: false, failureReason: result.error.message ?? 'Telr check failed', raw: result };
        }

        const statusCode = result?.order?.status?.code;
        const success = statusCode === TELR_STATUS_PAID;
        const currency = result?.order?.currency as 'INR' | 'KWD' | undefined;
        const amountMinor = success && currency && result?.order?.amount
            ? toMinorUnits(result.order.amount, currency)
            : undefined;

        return {
            success,
            providerPaymentId: result?.order?.ref,
            amountMinor,
            failureReason: success ? undefined : (result?.order?.status?.text ?? 'Payment not confirmed'),
            raw: result,
        };
    }

    verifyWebhookSignature(rawBody: string, _headers: Record<string, string | string[] | undefined>): WebhookVerificationResult {
        // See the file-level comment: no confirmed Telr webhook signature scheme was
        // available to build against. Deliberately NOT computing a fake signature check
        // that would give false confidence — this returns `valid: false` unconditionally
        // so nothing accidentally trusts an unverified Telr webhook body. Telr payment
        // confirmation in this pass goes through verifyPayment's server-side `check` call
        // instead, triggered from the return_auth/return_decl/return_can routes.
        void rawBody;
        return { valid: false };
    }

    async refund(params: RefundParams): Promise<RefundResult> {
        const { storeId, authKey } = requireCreds();
        const amountStr = formatMinorUnitsAsDecimalString(params.amountMinor, params.currency);
        // UNVERIFIED: no confirmed source for Telr's exact refund field names was found
        // while building this (unlike order creation and status-check, which are
        // directly confirmed from Telr's public docs). Written as a best-effort call
        // following the same ivp_method single-endpoint convention as the rest of their
        // API. Confirm against Telr's actual merchant/API docs (or support) before
        // relying on this in production — do not assume it works untested.
        const result = await telrRequest({
            ivp_method: 'refund',
            ivp_store: storeId,
            ivp_authkey: authKey,
            order_ref: params.providerPaymentId,
            amount: amountStr,
        });
        if (result?.error) {
            return { success: false, failureReason: result.error.message ?? 'Telr refund failed', raw: result };
        }
        return { success: true, providerRefundId: result?.refund?.ref ?? result?.order?.ref, raw: result };
    }
}
