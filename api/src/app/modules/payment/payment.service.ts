/**
 * Pass 7 — Payment System.
 *
 * Design note on why gateway calls happen OUTSIDE the booking transaction: calling an
 * external HTTP API (the payment gateway) from inside a SERIALIZABLE database
 * transaction is a well-known anti-pattern — it holds locks open for the duration of a
 * network call, and if the transaction later has to roll back for an unrelated reason,
 * you're left with a real-world gateway order that has no matching local record. Instead:
 * the booking transaction (appointment.service.ts, Pass 5/6) creates the Appointment and
 * a Payment row in PENDING status with no provider order yet; createProviderOrderForPayment
 * below is a separate, idempotent step (safe to call again — see its own comment) that
 * creates the actual gateway order afterward. If that step fails or is interrupted
 * (network blip, server restart), the booking itself is NOT lost — it's retried via the
 * same idempotent function, not by re-running the whole booking.
 */
import { Currency, Payment, PaymentStatus, Prisma } from '@prisma/client';
import prisma from '../../../shared/prisma';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';
import { getProviderForCurrency, getProviderByName } from './providers';
import { toMinorUnits } from '../../../shared/money';
import { InvoiceService } from '../invoice/invoice.service';

/**
 * Idempotent: if this Payment already has a providerOrderId, returns the existing order
 * info instead of calling the gateway again. Safe to call repeatedly (double-click on
 * "pay now," a retry after a timeout, or as a deliberate "resume payment" action).
 */
const createProviderOrderForPayment = async (paymentId: string): Promise<{ providerOrderId: string; redirectUrl: string | null; provider: string }> => {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { appointment: { include: { doctor: true } } }
    });
    if (!payment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Payment record is not found !!');
    }

    if (payment.providerOrderId) {
        // Already created — return what exists rather than creating a duplicate gateway
        // order. Telr's redirectUrl isn't stored (only the ref is durable/reusable data;
        // the URL itself is reconstructable), so for a Telr repeat-call we rebuild it the
        // same way Telr's own docs describe (process.html?o=<ref>); for Razorpay there is
        // no redirect URL at all (checkout widget uses the order id directly).
        const provider = getProviderByName(payment.provider);
        const redirectUrl = provider.name === 'telr' ? `https://secure.telr.com/gateway/process.html?o=${payment.providerOrderId}` : null;
        return { providerOrderId: payment.providerOrderId, redirectUrl, provider: payment.provider };
    }

    if (payment.status !== PaymentStatus.PENDING) {
        throw new ApiError(httpStatus.CONFLICT, `Cannot create a payment order for a payment in ${payment.status} status !!`);
    }

    const provider = getProviderForCurrency(payment.currency);
    const appointment = payment.appointment;
    const doctorName = `${appointment.doctor.firstName} ${appointment.doctor.lastName}`;

    const order = await provider.createOrder({
        paymentId: payment.id,
        amountMinor: payment.totalAmount,
        currency: payment.currency,
        description: `Appointment with Dr ${doctorName}`,
        customerName: appointment.firstName && appointment.lastName ? `${appointment.firstName} ${appointment.lastName}` : undefined,
        customerEmail: appointment.email ?? undefined,
        customerPhone: appointment.phone ?? undefined,
    });

    await prisma.payment.update({
        where: { id: payment.id },
        data: {
            providerOrderId: order.providerOrderId,
            status: PaymentStatus.PROCESSING,
        }
    });

    return { providerOrderId: order.providerOrderId, redirectUrl: order.redirectUrl, provider: payment.provider };
}

/**
 * Server-side verification of a payment — called either from a browser-return handler
 * (Telr) or from a frontend-submitted checkout callback (Razorpay). "Never trust the
 * browser as proof of payment": this always re-verifies against the gateway (signature
 * check for Razorpay, a direct status query for Telr) rather than trusting whatever the
 * request claims.
 */
const verifyAndFinalizePayment = async (paymentId: string, payload: Record<string, any>): Promise<Payment> => {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Payment record is not found !!');
    }
    // Terminal states don't get re-verified into a different outcome — a second
    // verification call on an already-SUCCEEDED payment is a no-op, not a re-trigger.
    if (payment.status === PaymentStatus.SUCCEEDED || payment.status === PaymentStatus.REFUNDED) {
        return payment;
    }

    const provider = getProviderByName(payment.provider);
    const result = await provider.verifyPayment({ payload });

    if (!result.success) {
        const updated = await prisma.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.FAILED, failureReason: result.failureReason ?? 'Verification failed' }
        });
        return updated;
    }

    // Amount check: signature/status being valid proves the callback is authentic, not
    // that the amount matches what was expected. A gateway confirming a DIFFERENT amount
    // than what was requested is treated as unresolved, not silently accepted.
    if (result.amountMinor !== undefined && result.amountMinor !== payment.totalAmount) {
        const updated = await prisma.payment.update({
            where: { id: payment.id },
            data: {
                status: PaymentStatus.UNKNOWN_RECONCILING,
                providerPaymentId: result.providerPaymentId,
                providerSignature: result.providerSignature,
                failureReason: `Amount mismatch: expected ${payment.totalAmount}, gateway confirmed ${result.amountMinor}`
            }
        });
        return updated;
    }

    const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.payment.update({
            where: { id: payment.id },
            data: {
                status: PaymentStatus.SUCCEEDED,
                providerPaymentId: result.providerPaymentId,
                providerSignature: result.providerSignature,
            }
        });
        // This is what Appointments.paymentStatus 'paid' should have meant all along
        // (Gap G6, docs/passes/01-domain-state-model.md) — set only once a gateway has
        // actually confirmed the payment, not unconditionally at booking time.
        await tx.appointments.update({
            where: { id: payment.appointmentId },
            data: { paymentStatus: 'paid' }
        });
        // Pass 14: if an invoice already exists for this payment (appointment was
        // already SCHEDULED before the gateway confirmed), it moves ISSUED→PAID here.
        // If not, generateInvoiceForAppointment (called from the SCHEDULED transition)
        // reads this same up-to-date payment status and creates the invoice already-PAID
        // — either ordering ends up consistent.
        await InvoiceService.markInvoicePaidForPayment(tx, payment.id);
        return p;
    });
    return updated;
}

/**
 * Inbound webhook handler. rawBody must be the raw request body string (see
 * payment.route.ts's use of express.raw() for these two routes specifically). Idempotent
 * via the PaymentWebhookEvent unique constraint on (provider, providerEventId) — a
 * gateway retrying the same notification hits that constraint and is safely ignored.
 */
const handleWebhook = async (providerName: 'razorpay' | 'telr', rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<{ status: string }> => {
    const provider = getProviderByName(providerName);
    const verification = provider.verifyWebhookSignature(rawBody, headers);
    if (!verification.valid) {
        // For Telr specifically, this is EXPECTED to always be the outcome today — see
        // telr.provider.ts's comment. This isn't treated as an error for Telr; Telr
        // confirmation goes through the return_auth/return_decl/return_can routes calling
        // verifyAndFinalizePayment instead. For Razorpay, an invalid signature is a real
        // rejection (someone forging a webhook, or a misconfigured secret).
        if (providerName === 'razorpay') {
            throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid webhook signature !!');
        }
        return { status: 'ignored' };
    }

    const providerEventId = verification.providerEventId ?? `${providerName}-${Date.now()}-${Math.random()}`;

    // The actual idempotency enforcement — see the model comment in schema.prisma.
    const existing = await prisma.paymentWebhookEvent.findUnique({
        where: { provider_providerEventId: { provider: providerName, providerEventId } }
    });
    if (existing) {
        return { status: 'already_processed' };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid webhook body !!');
    }

    // Pass 20 — Concurrency & Idempotency BUG FIX: the `findUnique` check above and this
    // `create` were two separate, non-atomic calls — a classic time-of-check-to-time-of-
    // use race. Gateways commonly deliver the same webhook twice in close succession
    // (that's the entire reason PaymentWebhookEvent's unique constraint exists), and two
    // near-simultaneous deliveries could both pass the `findUnique` check before either
    // had inserted its row. The loser then hit the unique constraint on `create` itself —
    // which, before this pass, propagated as an uncaught error instead of the graceful
    // "already processed" this function is supposed to return for exactly this
    // situation. A gateway receiving a non-2xx for what should be a successful duplicate
    // acknowledgment would likely just retry again, indefinitely.
    try {
        await prisma.paymentWebhookEvent.create({
            data: {
                provider: providerName,
                providerEventId,
                eventType: verification.eventType ?? 'unknown',
                payload: parsed,
            }
        });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return { status: 'already_processed' };
        }
        throw err;
    }

    // Razorpay's payload nests entity data under payload.payment.entity — see
    // payload.contains for which entities are present per event type. The webhook
    // signature check above already authenticates this payload — unlike
    // verifyAndFinalizePayment (used for the browser-return/checkout-callback path),
    // there's no separate razorpay_signature to re-check here, so this updates Payment
    // and Appointments directly rather than routing through that function (which expects
    // and requires a checkout-style signature that webhook payloads don't carry).
    if (providerName === 'razorpay') {
        const paymentEntity = parsed?.payload?.payment?.entity;
        const paymentIdFromNotes = paymentEntity?.notes?.paymentId;
        if (paymentIdFromNotes && parsed.event === 'payment.captured') {
            const payment = await prisma.payment.findUnique({ where: { id: paymentIdFromNotes } });
            if (payment && payment.status !== PaymentStatus.SUCCEEDED && payment.status !== PaymentStatus.REFUNDED) {
                if (paymentEntity.amount !== payment.totalAmount) {
                    await prisma.payment.update({
                        where: { id: paymentIdFromNotes },
                        data: {
                            status: PaymentStatus.UNKNOWN_RECONCILING,
                            providerPaymentId: paymentEntity.id,
                            failureReason: `Webhook amount mismatch: expected ${payment.totalAmount}, got ${paymentEntity.amount}`
                        }
                    });
                } else {
                    await prisma.$transaction(async (tx) => {
                        await tx.payment.update({
                            where: { id: paymentIdFromNotes },
                            data: { status: PaymentStatus.SUCCEEDED, providerPaymentId: paymentEntity.id }
                        });
                        await tx.appointments.update({
                            where: { id: payment.appointmentId },
                            data: { paymentStatus: 'paid' }
                        });
                        // Pass 14: same hook as verifyAndFinalizePayment's success path.
                        await InvoiceService.markInvoicePaidForPayment(tx, paymentIdFromNotes);
                    });
                }
            }
        }
    }

    await prisma.paymentWebhookEvent.update({
        where: { provider_providerEventId: { provider: providerName, providerEventId } },
        data: { processedAt: new Date() }
    });

    return { status: 'processed' };
}

// Pass 9 — Cancellation & Rescheduling: extracted from refundPayment so cancellation
// flows (appointment.service.ts) can trigger a policy-computed refund without going
// through the admin-only gate below — eligibility there was already decided by the
// cancellation cutoff policy, not by an arbitrary admin request. refundPayment (the
// admin API endpoint) wraps this with its own role/eligibility checks for manual
// refunds; this function does the actual gateway call + bookkeeping either way.
// Pass 20 — Concurrency & Idempotency. Reuses the exact IdempotencyKey table Pass 2
// laid down for this and Pass 6 first wired up for booking — same "claim, then fill in
// the response" idea, adapted for a flow that (unlike booking) makes a slow external
// call in the middle, so the claim and the gateway call can't share one DB transaction
// the way booking's insert-and-record can.
//
// The claim step (bare `create`, not check-then-create) is what actually closes the
// race: two requests with the SAME key racing to create the same row can only have one
// winner — the database's own unique constraint decides that, not application logic that
// could have its own gap. The loser either replays a completed sibling's response, or
// — if it got there before the winner finished — is told plainly that a duplicate
// request is already in flight, rather than being allowed to also call the gateway.
const claimIdempotencyKey = async (key: string | undefined): Promise<{ replay: any } | null> => {
    if (!key) return null;
    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (existing) {
        if (existing.response !== null && existing.response !== undefined) {
            return { replay: existing.response };
        }
        throw new ApiError(httpStatus.CONFLICT, 'A request with this idempotency key is already being processed.');
    }
    try {
        await prisma.idempotencyKey.create({ data: { key } });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new ApiError(httpStatus.CONFLICT, 'A request with this idempotency key is already being processed.');
        }
        throw err;
    }
    return null;
}

const finalizeIdempotencyKey = async (key: string | undefined, response: any): Promise<void> => {
    if (!key) return;
    const safeResponse = JSON.parse(JSON.stringify(response));
    await prisma.idempotencyKey.update({ where: { key }, data: { response: safeResponse, statusCode: 200 } });
}

// A failed attempt didn't actually charge/refund anything real — the claim row must not
// permanently block a retry with the same key, or a single transient gateway failure
// would leave that idempotency key unusable forever.
const releaseIdempotencyKeyOnFailure = async (key: string | undefined): Promise<void> => {
    if (!key) return;
    await prisma.idempotencyKey.delete({ where: { key } }).catch(() => {});
}

const processRefund = async (paymentId: string, amountMinor: number, reason?: string): Promise<Payment> => {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Payment record is not found !!');
    }
    if (payment.status !== PaymentStatus.SUCCEEDED && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
        throw new ApiError(httpStatus.CONFLICT, `Cannot refund a payment in ${payment.status} status !!`);
    }
    if (!payment.providerPaymentId) {
        throw new ApiError(httpStatus.CONFLICT, 'Payment has no gateway reference to refund against !!');
    }
    const alreadyRefunded = payment.refundedAmount ?? 0;
    if (alreadyRefunded + amountMinor > payment.totalAmount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount exceeds remaining refundable balance !!');
    }
    if (amountMinor <= 0) {
        // Not an error — a 0-eligibility late cancellation legitimately results in "no
        // refund to process." Callers (e.g. cancelAppointment) should check for this and
        // skip calling processRefund entirely rather than calling it with 0.
        throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount must be greater than zero !!');
    }

    const provider = getProviderByName(payment.provider);
    const result = await provider.refund({
        providerPaymentId: payment.providerPaymentId,
        amountMinor,
        currency: payment.currency,
        reason,
    });

    if (!result.success) {
        throw new ApiError(httpStatus.BAD_GATEWAY, `Refund failed: ${result.failureReason ?? 'unknown gateway error'}`);
    }

    const newRefundedTotal = alreadyRefunded + amountMinor;
    const isFullRefund = newRefundedTotal >= payment.totalAmount;
    // Pass 20 — Concurrency & Idempotency BUG FIX: this used to be an unconditional
    // `update` based on `alreadyRefunded`/`payment.status` read at the TOP of this
    // function — but the gateway call above is slow, and nothing stopped a second,
    // DIFFERENTLY-idempotency-keyed refund request (a genuinely separate admin action,
    // not a retry of this one — the claim above only protects against duplicates of
    // THIS SAME request) from reading the same stale `payment` row and racing to update
    // it too. `updateMany` with `refundedAmount`/`status` in the WHERE clause is an
    // optimistic-concurrency check: it only succeeds if the row still looks exactly like
    // what this function read before calling the gateway. If 0 rows match, someone else's
    // refund committed in between.
    //
    // Critically, by this point the gateway call already succeeded — the money has
    // genuinely moved. Silently retrying or discarding that fact would be worse than the
    // race itself. UNKNOWN_RECONCILING (added in Pass 7 for exactly this "gateway
    // succeeded but our own bookkeeping is now uncertain" situation) records that a real
    // refund happened and flags it for manual reconciliation, rather than guessing.
    const updateResult = await prisma.payment.updateMany({
        where: { id: payment.id, refundedAmount: payment.refundedAmount, status: payment.status },
        data: {
            refundedAmount: newRefundedTotal,
            status: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
        }
    });
    if (updateResult.count === 0) {
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                status: PaymentStatus.UNKNOWN_RECONCILING,
                failureReason: `Refund of ${amountMinor} succeeded at the gateway, but local bookkeeping could not be applied cleanly (concurrent update detected). Needs manual reconciliation.`,
            }
        });
        throw new ApiError(httpStatus.CONFLICT, 'This refund was processed at the payment gateway, but a concurrent update prevented recording it cleanly. This has been flagged for manual reconciliation — do not retry.');
    }
    const updated = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    // Pass 14: a fully-refunded payment's invoice is voided — the money has been
    // returned, so the document is no longer a valid record of an amount owed/paid.
    // A partial refund deliberately does NOT void the invoice: this app has no
    // credit-note concept, and the invoice was genuinely paid in full at some point —
    // voiding it would lose that fact. Flagged as a known simplification, not silently
    // decided.
    if (isFullRefund) {
        await prisma.$transaction(async (tx) => {
            await InvoiceService.voidInvoiceForPayment(tx, payment.id, reason ?? 'Payment fully refunded');
        });
    }
    return updated;
}

const refundPayment = async (reqUser: any, paymentId: string, amountMinor: number, reason?: string, idempotencyKey?: string): Promise<Payment> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can issue a refund !!');
    }
    const claim = await claimIdempotencyKey(idempotencyKey);
    if (claim) {
        return claim.replay;
    }
    try {
        const result = await processRefund(paymentId, amountMinor, reason);
        await finalizeIdempotencyKey(idempotencyKey, result);
        return result;
    } catch (err) {
        await releaseIdempotencyKeyOnFailure(idempotencyKey);
        throw err;
    }
}

// Pass 21 — Admin & Operational Controls. Closes the gap Pass 20 explicitly flagged:
// PaymentStatus.UNKNOWN_RECONCILING (added in Pass 7, first actually triggered by Pass
// 20's optimistic-concurrency check) had no admin-facing way to see or resolve payments
// stuck in it. This is deliberately a human-in-the-loop action, not automated
// reconciliation — an admin checks the payment gateway's own dashboard directly to see
// what really happened, then tells this app what the true final state is. Building
// real automated reconciliation (polling the gateway's API to resolve these
// automatically) is a larger feature this pass does not attempt.
const getReconciliationQueue = async (reqUser: any): Promise<Payment[]> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can view the payment reconciliation queue !!');
    }
    return prisma.payment.findMany({
        where: { status: PaymentStatus.UNKNOWN_RECONCILING },
        orderBy: { updatedAt: 'desc' },
        include: {
            appointment: {
                select: { trackingId: true, scheduleDate: true, scheduleTime: true, patientId: true, doctorId: true }
            }
        }
    });
}

const RESOLVABLE_STATUSES = [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] as const;

const resolveReconciliation = async (reqUser: any, paymentId: string, resolvedStatus: PaymentStatus, note: string): Promise<Payment> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can resolve a reconciliation !!');
    }
    if (!RESOLVABLE_STATUSES.includes(resolvedStatus as any)) {
        throw new ApiError(httpStatus.BAD_REQUEST, `resolvedStatus must be one of: ${RESOLVABLE_STATUSES.join(', ')}`);
    }
    if (!note || !note.trim()) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'A note explaining what was found at the gateway is required.');
    }
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Payment record is not found !!');
    }
    if (payment.status !== PaymentStatus.UNKNOWN_RECONCILING) {
        throw new ApiError(httpStatus.CONFLICT, 'This payment is not awaiting reconciliation !!');
    }
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.update({
            where: { id: paymentId },
            data: { status: resolvedStatus, failureReason: note }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: 'admin',
                action: 'payment.reconciliation_resolved',
                entityType: 'Payment',
                entityId: paymentId,
                metadata: { from: 'UNKNOWN_RECONCILING', to: resolvedStatus, note },
            }
        });
        return updated;
    });
    return result;
}

export const PaymentService = {
    createProviderOrderForPayment,
    verifyAndFinalizePayment,
    handleWebhook,
    refundPayment,
    processRefund,
    getReconciliationQueue,
    resolveReconciliation,
}

