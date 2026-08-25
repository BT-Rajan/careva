import httpStatus from "http-status";
import moment from "moment";
import ApiError from "../../../errors/apiError";
import prisma from "../../../shared/prisma";
import { Invoice, PaymentStatus, Prisma } from "@prisma/client";
import { assertValidInvoiceTransition, assertValidInvoiceTransitionShape } from "./invoice-lifecycle";

type Tx = Prisma.TransactionClient;

// Same generation convention as Appointments.trackingId (appointment.service.ts) — a
// prefix, a date, and a zero-padded counter derived from the previous row — kept
// consistent with the rest of the app rather than inventing a different scheme just for
// this model.
const nextInvoiceNumber = async (tx: Tx): Promise<string> => {
    const previous = await tx.invoice.findFirst({ orderBy: { createdAt: 'desc' }, take: 1 });
    const previousSuffix = (previous?.invoiceNumber ?? '').slice(-4);
    const nextSuffix = (Number(previousSuffix) + 1 || 1).toString().padStart(4, '0');
    const year = moment().year();
    const month = (moment().month() + 1).toString().padStart(2, '0');
    return `INV${year}${month}${nextSuffix}`;
}

/**
 * Pass 14. Called from appointment.service.ts inside the SAME transaction as a
 * PENDING→SCHEDULED transition — an invoice is generated the moment a booking is
 * confirmed, never before (see the model comment in schema.prisma for why SCHEDULED,
 * not PENDING or COMPLETED).
 *
 * Idempotent by construction, not by a defensive check: the appointment state machine
 * only ever reaches SCHEDULED via PENDING→SCHEDULED, and that edge is only reachable
 * once per appointment (SCHEDULED's only ways back to PENDING — a patient reschedule —
 * go through voidInvoiceForAppointment first, see below) — so this never runs twice for
 * the same appointment. Still guards on an existing live invoice defensively, since
 * "trust the caller" is exactly the kind of assumption Pass 5/6/8 spent whole passes
 * removing elsewhere in this app.
 *
 * Reads the linked Payment's CURRENT status rather than assuming ISSUED — if payment
 * had already succeeded by the time the appointment reaches SCHEDULED (possible in
 * principle: nothing stops a gateway confirmation from landing while an appointment is
 * still PENDING), the invoice is generated already-PAID instead of lying that it's
 * still owed.
 */
const generateInvoiceForAppointment = async (tx: Tx, appointmentId: string, actorId?: string): Promise<Invoice | null> => {
    const existingLive = await tx.invoice.findFirst({
        where: { appointmentId, status: { not: 'VOID' } }
    });
    if (existingLive) {
        return existingLive;
    }
    const payment = await tx.payment.findFirst({
        where: { appointmentId },
        orderBy: { createdAt: 'desc' }
    });
    if (!payment) {
        // No Payment row at all means nothing was ever charged for this appointment
        // (e.g. a legacy/guest booking predating Pass 7) — nothing to invoice.
        return null;
    }
    const invoiceNumber = await nextInvoiceNumber(tx);
    const invoice = await tx.invoice.create({
        data: {
            appointmentId,
            paymentId: payment.id,
            invoiceNumber,
            status: payment.status === PaymentStatus.SUCCEEDED ? 'PAID' : 'ISSUED',
            currency: payment.currency,
            doctorFee: payment.DoctorFee,
            bookingFee: payment.bookingFee,
            vat: payment.vat,
            totalAmount: payment.totalAmount,
        }
    });
    await tx.auditLog.create({
        data: {
            actorId: actorId ?? null,
            actorRole: actorId ? 'doctor' : 'system',
            action: 'invoice.issued',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: { appointmentId, paymentId: payment.id, status: invoice.status },
        }
    });
    return invoice;
}

/**
 * Pass 14. Called from payment.service.ts inside the same transaction as a Payment
 * being marked SUCCEEDED (verifyAndFinalizePayment, and the Razorpay webhook success
 * branch). No-ops silently if no invoice exists yet for this payment (appointment not
 * yet SCHEDULED — see generateInvoiceForAppointment's own PAID-at-creation handling for
 * the other ordering) or if the invoice is already PAID/VOID.
 */
const markInvoicePaidForPayment = async (tx: Tx, paymentId: string): Promise<void> => {
    // Pass 14 fix: paymentId is not DB-unique (see the schema comment on
    // Invoice.paymentId) — a payment can have a VOID original plus a live corrected
    // invoice, both sharing this paymentId. findFirst + the not-VOID filter finds the
    // one that's actually current.
    const invoice = await tx.invoice.findFirst({ where: { paymentId, status: { not: 'VOID' } } });
    if (!invoice || invoice.status !== 'ISSUED') {
        return;
    }
    assertValidInvoiceTransitionShape(invoice.status, 'PAID');
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'PAID' } });
    await tx.auditLog.create({
        data: {
            actorId: null,
            actorRole: 'system',
            action: 'invoice.status_changed',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: { from: 'ISSUED', to: 'PAID', reason: 'payment_confirmed' },
        }
    });
}

/**
 * Pass 14. Called from appointment.service.ts's cancelAppointment (any cancel/decline
 * outcome) and rescheduleAppointment (when a patient reschedule resets SCHEDULED back
 * to PENDING — the doctor agreed to the original slot, not automatically to whatever
 * comes next, so the invoice for that original commitment no longer holds), and from
 * payment.service.ts's processRefund once a payment reaches full REFUNDED. No-ops
 * silently if the appointment/payment has no live invoice — most cancellations happen
 * from PENDING, before any invoice was ever generated.
 */
const voidInvoiceForAppointment = async (tx: Tx, appointmentId: string, reason: string, actorId?: string, actorRole?: string): Promise<void> => {
    const invoice = await tx.invoice.findFirst({ where: { appointmentId, status: { not: 'VOID' } } });
    if (!invoice) {
        return;
    }
    assertValidInvoiceTransitionShape(invoice.status, 'VOID');
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'VOID', voidedAt: new Date(), voidedReason: reason } });
    await tx.auditLog.create({
        data: {
            actorId: actorId ?? null,
            actorRole: actorRole ?? 'system',
            action: 'invoice.status_changed',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: { from: invoice.status, to: 'VOID', reason },
        }
    });
}

const voidInvoiceForPayment = async (tx: Tx, paymentId: string, reason: string): Promise<void> => {
    // Pass 14 fix: see the matching comment in markInvoicePaidForPayment above.
    const invoice = await tx.invoice.findFirst({ where: { paymentId, status: { not: 'VOID' } } });
    if (!invoice) {
        return;
    }
    assertValidInvoiceTransitionShape(invoice.status, 'VOID');
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'VOID', voidedAt: new Date(), voidedReason: reason } });
    await tx.auditLog.create({
        data: {
            actorId: null,
            actorRole: 'system',
            action: 'invoice.status_changed',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: { from: invoice.status, to: 'VOID', reason },
        }
    });
}

const INVOICE_INCLUDE = {
    appointment: {
        select: {
            trackingId: true, scheduleDate: true, scheduleTime: true,
            patient: { select: { firstName: true, lastName: true, address: true, city: true, country: true } },
            doctor: { select: { firstName: true, lastName: true, address: true, city: true, country: true } },
        }
    },
    payment: { select: { paymentMethod: true, paymentType: true, provider: true } },
    supersedes: { select: { id: true, invoiceNumber: true, status: true, createdAt: true } },
    supersededBy: { select: { id: true, invoiceNumber: true, status: true, createdAt: true } },
} as const;

const getInvoiceById = async (reqUser: any, id: string): Promise<Invoice | null> => {
    const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
            payment: { select: { paymentMethod: true, paymentType: true, provider: true } },
            supersedes: { select: { id: true, invoiceNumber: true, status: true, createdAt: true } },
            supersededBy: { select: { id: true, invoiceNumber: true, status: true, createdAt: true } },
            appointment: {
                select: {
                    trackingId: true, scheduleDate: true, scheduleTime: true, patientId: true, doctorId: true,
                    patient: { select: { firstName: true, lastName: true, address: true, city: true, country: true } },
                    doctor: { select: { firstName: true, lastName: true, address: true, city: true, country: true } },
                }
            },
        }
    });
    if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const appt = invoice.appointment as any;
    const isOwner = appt?.patientId === reqUser?.userId || appt?.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this invoice !!');
    }
    return invoice;
}

const getInvoiceByAppointmentId = async (reqUser: any, appointmentId: string): Promise<Invoice | null> => {
    const appointment = await prisma.appointments.findUnique({ where: { id: appointmentId } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this invoice !!');
    }
    // Most-recent-first: if this appointment's invoice was ever corrected, the newest
    // (current) version is what a plain "show me the invoice for this appointment" link
    // should resolve to.
    const invoice = await prisma.invoice.findFirst({
        where: { appointmentId },
        include: {
            payment: { select: { paymentMethod: true, paymentType: true, provider: true } },
            supersedes: { select: { id: true, invoiceNumber: true, status: true, createdAt: true } },
            supersededBy: { select: { id: true, invoiceNumber: true, status: true, createdAt: true } },
            appointment: {
                select: {
                    trackingId: true, scheduleDate: true, scheduleTime: true,
                    patient: { select: { firstName: true, lastName: true, address: true, city: true, country: true } },
                    doctor: { select: { firstName: true, lastName: true, address: true, city: true, country: true } },
                }
            },
        },
        orderBy: { createdAt: 'desc' }
    });
    return invoice;
}

const getDoctorInvoices = async (reqUser: any): Promise<Invoice[]> => {
    const isDoctor = await prisma.doctor.findUnique({ where: { id: reqUser?.userId } });
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
    }
    return prisma.invoice.findMany({
        where: { appointment: { doctorId: isDoctor.id } },
        include: INVOICE_INCLUDE,
        orderBy: { createdAt: 'desc' }
    });
}

const getPatientInvoices = async (reqUser: any): Promise<Invoice[]> => {
    const isPatient = await prisma.patient.findUnique({ where: { id: reqUser?.userId } });
    if (!isPatient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!');
    }
    return prisma.invoice.findMany({
        where: { appointment: { patientId: isPatient.id } },
        include: INVOICE_INCLUDE,
        orderBy: { createdAt: 'desc' }
    });
}

// Pass 14 — admin manual void. Distinct from the automatic voids above (cancellation,
// reschedule, refund): this is for correcting a mistake in an otherwise-live invoice
// with no other event to hang the void off of.
const voidInvoice = async (reqUser: any, id: string, reason?: string): Promise<Invoice> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can void an invoice !!');
    }
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice is not found !!');
    }
    assertValidInvoiceTransition(invoice.status, 'VOID', 'admin');
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.invoice.update({
            where: { id },
            data: { status: 'VOID', voidedAt: new Date(), voidedReason: reason ?? 'Voided by admin' }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: 'admin',
                action: 'invoice.status_changed',
                entityType: 'Invoice',
                entityId: id,
                metadata: { from: invoice.status, to: 'VOID', reason: reason ?? 'Voided by admin' },
            }
        });
        return updated;
    });
    return result;
}

// Pass 14 — correction. "Corrections create a new invoice; existing ones are never
// edited in place" (docs/passes/01-domain-state-model.md §4.5). Unlike Prescription's
// CORRECTED status, Invoice's target enum has no separate correction state — VOID
// already means "no longer the current document for this charge," so a correction is
// simply: void the original (recording why), then issue a fresh one with the corrected
// figures, linked back via supersedesId.
const correctInvoice = async (reqUser: any, id: string, payload: { doctorFee?: number, bookingFee?: number, vat?: number, totalAmount?: number, reason?: string }): Promise<Invoice> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can correct an invoice !!');
    }
    const original = await prisma.invoice.findUnique({ where: { id } });
    if (!original) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice is not found !!');
    }
    assertValidInvoiceTransition(original.status, 'VOID', 'admin');
    const result = await prisma.$transaction(async (tx) => {
        await tx.invoice.update({
            where: { id },
            data: { status: 'VOID', voidedAt: new Date(), voidedReason: payload.reason ?? 'Superseded by correction' }
        });
        const invoiceNumber = await nextInvoiceNumber(tx);
        const corrected = await tx.invoice.create({
            data: {
                appointmentId: original.appointmentId,
                paymentId: original.paymentId,
                invoiceNumber,
                status: 'ISSUED',
                currency: original.currency,
                doctorFee: payload.doctorFee ?? original.doctorFee,
                bookingFee: payload.bookingFee ?? original.bookingFee,
                vat: payload.vat ?? original.vat,
                totalAmount: payload.totalAmount ?? original.totalAmount,
                supersedesId: original.id,
            }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: 'admin',
                action: 'invoice.corrected',
                entityType: 'Invoice',
                entityId: original.id,
                metadata: { supersededBy: corrected.id, reason: payload.reason ?? null },
            }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: 'admin',
                action: 'invoice.issued',
                entityType: 'Invoice',
                entityId: corrected.id,
                metadata: { reason: 'correction', supersedes: original.id },
            }
        });
        return corrected;
    });
    return result;
}

export const InvoiceService = {
    generateInvoiceForAppointment,
    markInvoicePaidForPayment,
    voidInvoiceForAppointment,
    voidInvoiceForPayment,
    getInvoiceById,
    getInvoiceByAppointmentId,
    getDoctorInvoices,
    getPatientInvoices,
    voidInvoice,
    correctInvoice,
}
