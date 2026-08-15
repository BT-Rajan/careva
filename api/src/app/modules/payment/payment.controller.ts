import { Request, Response } from 'express';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';
import { PaymentService } from './payment.service';
import prisma from '../../../shared/prisma';
import config from '../../../config';

const getCheckout = catchAsync(async (req: Request, res: Response) => {
    // Pass 4-style ownership check, kept here rather than in the service since it's a
    // route-level access-control concern specific to this one endpoint.
    const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId }, include: { appointment: true } });
    if (!payment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Payment record is not found !!');
    }
    const reqUser: any = req.user;
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = payment.appointment.patientId === reqUser?.userId || payment.appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this payment !!');
    }
    const result = await PaymentService.createProviderOrderForPayment(req.params.paymentId);
    sendResponse(res, {
        statusCode: 200,
        message: 'Checkout ready !!',
        success: true,
        data: result,
    })
})

const verifyPayment = catchAsync(async (req: Request, res: Response) => {
    const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId }, include: { appointment: true } });
    if (!payment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Payment record is not found !!');
    }
    const reqUser: any = req.user;
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = payment.appointment.patientId === reqUser?.userId || payment.appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to verify this payment !!');
    }
    const result = await PaymentService.verifyAndFinalizePayment(req.params.paymentId, req.body);
    sendResponse(res, {
        statusCode: 200,
        message: 'Payment verification processed !!',
        success: true,
        data: result,
    })
})

// Telr redirects the BROWSER here after checkout (return_auth/return_decl/return_can) —
// no auth possible/expected on this route (the browser arrives here mid-flow, not
// authenticated), and per "never trust the browser," this does NOT trust the redirect
// itself as proof of anything — it triggers a real server-side status check with Telr
// (see telr.provider.ts verifyPayment) before deciding what happened, then redirects the
// browser onward to the frontend's own success/failure page.
const telrReturn = (outcome: 'success' | 'declined' | 'cancelled') => catchAsync(async (req: Request, res: Response) => {
    const paymentId = req.query.paymentId as string;
    if (!paymentId) {
        return res.redirect(`${config.clientUrl}/booking/payment-error`);
    }
    try {
        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (payment && payment.providerOrderId) {
            await PaymentService.verifyAndFinalizePayment(paymentId, { order_ref: payment.providerOrderId });
        }
    } catch (error) {
        console.error('Telr return-handler verification failed:', error);
    }
    // Frontend redirect target — see docs/passes/07-payment-system.md for what the
    // frontend still needs to build to actually consume this (not built in this pass).
    const destination = outcome === 'success' ? 'payment-processing' : `payment-${outcome}`;
    return res.redirect(`${config.clientUrl}/booking/${destination}?paymentId=${paymentId}`);
})

const webhook = (providerName: 'razorpay' | 'telr') => catchAsync(async (req: Request, res: Response) => {
    // req.rawBody is captured globally in app.ts's express.json() verify callback — see
    // that file for why route-level express.raw() doesn't work here (the global JSON
    // parser already runs first and would have drained the request stream).
    const rawBody = req.rawBody ?? '';
    const result = await PaymentService.handleWebhook(providerName, rawBody, req.headers as Record<string, string | string[] | undefined>);
    // Always 200 on anything we deliberately handled (including "already_processed" and
    // Telr's expected "ignored") so the gateway doesn't keep retrying a webhook we've
    // already dealt with — only genuine errors (thrown ApiErrors, e.g. bad Razorpay
    // signature) should produce a non-2xx that triggers the gateway's own retry.
    res.status(200).json({ success: true, ...result });
})

const refund = catchAsync(async (req: Request, res: Response) => {
    const { amountMinor, reason } = req.body;
    const result = await PaymentService.refundPayment(req.user, req.params.paymentId, amountMinor, reason);
    sendResponse(res, {
        statusCode: 200,
        message: 'Refund processed !!',
        success: true,
        data: result,
    })
})

export const PaymentController = {
    getCheckout,
    verifyPayment,
    telrReturn,
    webhook,
    refund,
}
