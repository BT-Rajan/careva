import { Appointments, Patient, Payment, paymentStatus, Prisma, PaymentStatus, AppointmentStatus } from "@prisma/client";
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import moment from 'moment';
import { EmailtTransporter } from "../../../helpers/emailTransporter";
import * as path from 'path';
import config from "../../../config";
import { toMinorUnits } from "../../../shared/money";
import { getProviderForCurrency } from "../payment/providers";
import { PaymentService } from "../payment/payment.service";
import { assertValidAppointmentTransition } from "./appointment-state-machine";
import { InvoiceService } from "../invoice/invoice.service";
import { generateTrackingId } from "../../../shared/trackingId";

// Pass 5 — Appointment & Slot Engine.
//
// Before this pass, NOTHING in the database or application code checked whether a slot
// had capacity before creating an appointment (Gap G9, docs/passes/01-domain-state-model.md
// §4.7/§5). `createAppointment` and `createAppointmentByUnAuthenticateUser` just inserted
// a row with whatever `scheduleDate`/`scheduleTime` strings the client sent — no validation
// that the time was even part of the doctor's configured hours, and no cap on how many
// appointments could pile up on the exact same doctor+date+time. This function is the
// fix, called from inside the SAME transaction as the appointment insert, under
// Serializable isolation (see the two callers below) so that two concurrent booking
// requests for the last remaining seat in a slot cannot both succeed — Postgres will
// abort one of them with a serialization failure, which the caller retries/reports.
//
// Capacity comes from `DoctorTimeSlot.maximumPatient`, set per weekday
// (docs/passes/01-domain-state-model.md §4.7 flagged this as the central gap this pass
// exists to close). Cancelled appointments ('cancel' — see Pass 1 §3.2 on the current
// literal status strings; this intentionally does not touch that representation, which is
// Pass 8's job) don't count against capacity, since cancelling frees the seat.
const assertSlotAvailable = async (
    tx: Prisma.TransactionClient,
    doctorId: string,
    scheduleDate: string | undefined,
    scheduleTime: string | undefined
): Promise<void> => {
    if (!scheduleDate || !scheduleTime) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'scheduleDate and scheduleTime are required !!');
    }

    // Pass 11 — Doctor Schedule Engine: blocked dates (holidays, leave). Checked here too,
    // not just in the display endpoint (doctorTimeSlot.service.ts) — display can be
    // stale or bypassed entirely (e.g. a client retrying an old request), so booking
    // enforcement can't rely on the frontend having already filtered this out.
    // Normalized to YYYY-MM-DD before lookup — scheduleDate can carry a time-of-day
    // component ("2026-08-20 00:00:00"), but a blocked date means the whole calendar
    // day, and DoctorBlockedDate.date is always stored normalized (see
    // doctorTimeSlot.service.ts's createBlockedDate) — exact-string matching the raw
    // scheduleDate against it would silently never match.
    const normalizedDate = moment(scheduleDate).format('YYYY-MM-DD');
    const blockedDate = await tx.doctorBlockedDate.findUnique({
        where: { doctorId_date: { doctorId, date: normalizedDate } }
    });
    if (blockedDate) {
        throw new ApiError(httpStatus.CONFLICT, "The doctor is unavailable on the selected date !!");
    }

    const weekday = moment(scheduleDate).format('dddd').toLowerCase();
    const doctorTimeSlot = await tx.doctorTimeSlot.findFirst({
        where: { doctorId, day: weekday as any },
        include: { timeSlot: true }
    });
    if (!doctorTimeSlot) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Doctor is not available on the selected day !!");
    }

    // Defense in depth: previously nothing checked that scheduleTime actually fell within
    // one of the doctor's configured ranges — a client could submit any arbitrary time
    // string. Uses the same 30-minute grid getAppointmentTimeOfEachDoctor generates for
    // display, so a time is valid if it falls inside any configured [startTime, endTime).
    const requested = moment(scheduleTime, ['hh:mm a', 'HH:mm']);
    const isWithinConfiguredRange = doctorTimeSlot.timeSlot.some((range) => {
        const start = moment(range.startTime, ['hh:mm a', 'HH:mm']);
        const end = moment(range.endTime, ['hh:mm a', 'HH:mm']);
        return requested.isSameOrAfter(start) && requested.isBefore(end);
    });
    if (!isWithinConfiguredRange) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Selected time is outside the doctor's available hours !!");
    }

    const maximumPatient = doctorTimeSlot.maximumPatient ?? 1;
    const existingCount = await tx.appointments.count({
        where: {
            doctorId,
            scheduleDate,
            scheduleTime,
            // Pass 8: was `status: { not: 'cancel' }` — the old single lowercase string.
            // Now excludes every cancel/decline-shaped terminal state, since any of them
            // frees the seat back up.
            status: { notIn: ['DECLINED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN', 'EXPIRED'] }
        }
    });
    if (existingCount >= maximumPatient) {
        throw new ApiError(httpStatus.CONFLICT, 'This time slot is fully booked. Please choose another time !!');
    }
}

// Postgres error code 40001 ("serialization_failure") surfaces through Prisma as P2034.
// This is the EXPECTED, correct outcome of two concurrent requests racing for the same
// slot under Serializable isolation — not a bug. One retry is standard practice for
// serializable transactions (most conflicts are transient); if it still fails on retry,
// that's reported as a real "slot no longer available" rather than a generic 500.
const runBookingTransaction = async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
    const attempt = () => prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 15000 });
    try {
        return await attempt();
    } catch (error: any) {
        if (error?.code === 'P2034') {
            try {
                return await attempt();
            } catch (retryError: any) {
                if (retryError?.code === 'P2034') {
                    throw new ApiError(httpStatus.CONFLICT, 'This time slot was just booked by someone else. Please choose another time !!');
                }
                throw retryError;
            }
        }
        throw error;
    }
}

// Pass 6 — Booking Transaction: "use idempotency where appropriate" (the original
// engineering-passes plan calls this out specifically for the booking transaction; Pass 2
// laid the IdempotencyKey table down for exactly this, and Pass 20 later stress-tests and
// extends the same pattern to other endpoints — webhooks, refunds, cancellations).
//
// The problem this closes: a double-click on "Confirm booking," or a client retrying
// after a network timeout without knowing whether the first request actually landed,
// previously had no protection at all — each identical submission created a brand new
// appointment (and a brand new payment record). Pass 5's SERIALIZABLE isolation makes
// concurrent *different* bookings safe against each other, but does nothing to stop the
// *same* logical booking attempt from succeeding twice.
//
// Design: the client sends a stable `Idempotency-Key` header (a UUID generated once per
// booking attempt, reused across retries of that same attempt — see
// src/components/Appointment/AppointmentPage.jsx). Both the lookup and the eventual
// record-keeping happen INSIDE the same booking transaction as the appointment/payment
// insert, so there's no separate "claim" step and no window for an orphaned in-progress
// marker: either the whole transaction (idempotency row + appointment + payment) commits
// together, or none of it does. Two genuinely concurrent submissions with the same key
// race on inserting the same IdempotencyKey row; SERIALIZABLE catches that exactly like
// any other conflict, and runBookingTransaction's existing retry then finds the winner's
// committed row and replays its response instead of creating a second appointment.
const getIdempotentReplay = async (tx: Prisma.TransactionClient, idempotencyKey: string | undefined): Promise<any | null> => {
    if (!idempotencyKey) return null;
    const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
    if (existing && existing.response) {
        return existing.response;
    }
    return null;
}

const recordIdempotentResponse = async (tx: Prisma.TransactionClient, idempotencyKey: string | undefined, response: any): Promise<void> => {
    if (!idempotencyKey) return;
    // Prisma's Json column needs plain JSON values — round-tripping through
    // JSON.stringify/parse converts Date objects (createdAt/updatedAt/dateOfBirth on the
    // included doctor/patient records) to ISO strings instead of passing raw Date
    // instances, which Prisma would otherwise reject as invalid Json input.
    const safeResponse = JSON.parse(JSON.stringify(response));
    await tx.idempotencyKey.create({
        data: {
            key: idempotencyKey,
            response: safeResponse,
            statusCode: 200
        }
    });
}

const createAppointment = async (payload: any, idempotencyKey?: string): Promise<Appointments | null | any> => {

    const { patientInfo, payment } = payload;
    if(patientInfo.patientId){
        const isUserExist = await prisma.patient.findUnique({
            where: {
                id: patientInfo.patientId
            }
        })
        if (!isUserExist) {
            patientInfo['patientId'] = null
        }
    }

    const isDoctorExist = await prisma.doctor.findUnique({
        where: {
            id: patientInfo.doctorId
        }
    });

    if (!isDoctorExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    // Pass 10 — Doctor Lifecycle: previously NOTHING checked approval status before
    // allowing a booking — an admin-never-reviewed, or explicitly rejected/suspended,
    // doctor was fully bookable. This is Pass 1's invariant #6 ("a doctor must be
    // Approved/Active to be bookable"), finally enforced.
    if (isDoctorExist.approvalStatus !== 'APPROVED') {
        throw new ApiError(httpStatus.CONFLICT, 'This doctor is not currently accepting bookings !!');
    }
    // Pass 7 — Payment System: previously set to 'paid' unconditionally right here, before
    // any gateway was ever involved (Gap G6, docs/passes/01-domain-state-model.md). Now
    // left at its schema default ('unpaid') and only flipped to 'paid' by
    // payment.service.ts's verifyAndFinalizePayment, once a real gateway has confirmed
    // the payment — see PaymentService.createProviderOrderForPayment below.
  
    const result = await runBookingTransaction(async (tx) => {
        // Pass 6: if this exact booking attempt already succeeded (same Idempotency-Key),
        // replay the original result instead of creating a second appointment.
        const replay = await getIdempotentReplay(tx, idempotencyKey);
        if (replay) return replay;

        // Pass 5: the single most important check in the whole booking flow — must run
        // first, inside the same transaction as the insert. See assertSlotAvailable above.
        await assertSlotAvailable(tx, patientInfo.doctorId, patientInfo.scheduleDate, patientInfo.scheduleTime);

        // Pass 15 — Tracking & Public Access. Was a name-prefix + date + 3-digit-counter
        // format, guessable/enumerable rather than a real credential — see
        // shared/trackingId.ts for why that mattered (this value is the sole credential
        // for a public, unauthenticated lookup that returns real PII/PHI). No longer
        // needs to look at the previous row at all — a random token doesn't need a
        // sequential counter to avoid collisions within the same day.
        patientInfo['trackingId'] = generateTrackingId();

        const appointment = await tx.appointments.create({
            data: patientInfo,
            include: {
                doctor: true,
                patient: true
            }
        });
        const { paymentMethod, paymentType } = payment;
        const currency = isDoctorExist.currency;
        // Pass 7: amounts are now stored in minor units (paise/fils) — see
        // api/src/shared/money.ts. Doctor.price is still a human decimal string
        // ("60.50"), converted here at the point of charge.
        const docFeeMinor = toMinorUnits(isDoctorExist.price ?? '0', currency);
        const bookingFeeMinor = toMinorUnits(10, currency);
        const vatMinor = Math.round(0.15 * (docFeeMinor + bookingFeeMinor));
        // BUG FIX (Pass 7): totalAmount previously omitted bookingFee entirely
        // (`vat + docFee`, no bookingFee) — a patient was charged less than the sum of
        // the line items shown. Now the true sum of all three.
        const totalAmountMinor = docFeeMinor + bookingFeeMinor + vatMinor;
        let createdPayment: Payment | null = null;
        if (appointment.id) {
            createdPayment = await tx.payment.create({
                data: {
                    appointmentId: appointment.id,
                    bookingFee: bookingFeeMinor,
                    paymentMethod: paymentMethod,
                    paymentType: paymentType,
                    vat: vatMinor,
                    DoctorFee: docFeeMinor,
                    totalAmount: totalAmountMinor,
                    status: PaymentStatus.PENDING,
                    provider: getProviderForCurrency(currency).name,
                    currency: currency,
                }
            })
        }
        const pathName = path.join(__dirname, '../../../../template/appointment.html')
        const appointmentObj = {
            created: moment(appointment.createdAt).format('LL'),
            trackingId: appointment.trackingId,
            patientType: appointment.patientType,
            status: appointment.status,
            paymentStatus: appointment.paymentStatus,
            prescriptionStatus: appointment.prescriptionStatus,
            scheduleDate:moment(appointment.scheduleDate).format('LL'),
            scheduleTime:appointment.scheduleTime,
            doctorImg: appointment?.doctor?.img,
            doctorFirstName: appointment?.doctor?.firstName,
            doctorLastName: appointment?.doctor?.lastName,
            specialization:appointment?.doctor?.specialization,
            designation:appointment?.doctor?.designation,
            college:appointment?.doctor?.college,
            patientImg:appointment?.patient?.img,
            patientfirstName:appointment?.patient?.firstName,
            patientLastName:appointment?.patient?.lastName,
            dateOfBirth: moment().diff(moment(appointment?.patient?.dateOfBirth), 'years'),
            bloodGroup:appointment?.patient?.bloodGroup,
            city:appointment?.patient?.city,
            state:appointment?.patient?.state,
            country:appointment?.patient?.country
        }
        const replacementObj = appointmentObj;
        const subject = `Appointment Confirm With Dr ${appointment?.doctor?.firstName + ' ' + appointment?.doctor?.lastName} at ${appointment.scheduleDate} + ' ' + ${appointment.scheduleTime}`
        const toMail = `${appointment.email + ',' + appointment.doctor?.email}`;
        // Pass 6: EmailtTransporter is async and deliberately NOT awaited here — a slow or
        // failing email provider must never block or fail a successful booking. But an
        // un-awaited async call that throws becomes an unhandled promise rejection, and
        // Node 20+ terminates the process on those by default — meaning a single failed
        // confirmation email could previously have crashed the entire API for every other
        // in-flight request. The .catch here makes "email is best-effort" an explicit,
        // safe design decision instead of an accidental process-crash risk. Real
        // retry/delivery-tracking is Pass 16's job (Notifications) — this only stops it
        // from being able to take the server down.
        EmailtTransporter({ pathName, replacementObj, toMail, subject }).catch((err) => console.error('Failed to send appointment confirmation email:', err));
        // Pass 7: payment is nested onto the same object rather than restructuring the
        // response envelope — the existing frontend reads appointment fields (id,
        // trackingId, etc.) directly off the top level of this response, and the spread
        // here keeps that working unchanged while adding payment/checkout info alongside.
        const appointmentWithPayment = { ...appointment, payment: createdPayment };
        await recordIdempotentResponse(tx, idempotencyKey, appointmentWithPayment);
        return appointmentWithPayment;
    });
    // Pass 7: gateway order creation happens AFTER the transaction commits, not inside
    // it — see the design note at the top of payment.service.ts for why. Idempotent
    // either way (fresh booking or an idempotency-key replay both land here with a real
    // payment.id), so calling it unconditionally is safe and self-healing if a previous
    // attempt got this far but didn't finish (e.g. process restart between transaction
    // commit and gateway call).
    if (result?.payment?.id) {
        try {
            const checkout = await PaymentService.createProviderOrderForPayment(result.payment.id);
            result.checkout = checkout;
        } catch (error) {
            // Booking itself is NOT lost — the appointment and a PENDING payment record
            // exist regardless. The frontend/patient can retry via
            // POST /payment/:paymentId/checkout (see payment.route.ts) once whatever
            // caused this (bad gateway credentials, network blip) is resolved.
            console.error('Failed to create payment gateway order for appointment', result.id, error);
        }
    }
    return result;
}

const createAppointmentByUnAuthenticateUser = async (payload: any, idempotencyKey?: string): Promise<any> => {
    const { patientInfo, payment } = payload;
    if(patientInfo.patientId){
        const isUserExist = await prisma.patient.findUnique({
            where: {
                id: patientInfo.patientId
            }
        })
        if (!isUserExist) {
            patientInfo['patientId'] = null
        }
    }

    const result = await runBookingTransaction(async (tx) => {
        // Pass 6: same replay-on-duplicate-submit protection as the authenticated path.
        const replay = await getIdempotentReplay(tx, idempotencyKey);
        if (replay) return replay;

        // Pass 15 — Tracking & Public Access. See the matching comment in
        // createAppointment above — same fix, same reason.
        patientInfo['trackingId'] = generateTrackingId();
        const doctorIdForUnauth = patientInfo.doctorId || config.defaultAdminDoctor;
        patientInfo['doctorId'] = doctorIdForUnauth;

        const doctorForFee = await tx.doctor.findUnique({ where: { id: doctorIdForUnauth } });
        if (!doctorForFee) {
            throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
        }
        // Pass 10: same approval check as the authenticated booking path above.
        if (doctorForFee.approvalStatus !== 'APPROVED') {
            throw new ApiError(httpStatus.CONFLICT, 'This doctor is not currently accepting bookings !!');
        }
        const currency = doctorForFee.currency;
        // Pass 7: minor units — see api/src/shared/money.ts. Preserves the existing
        // "60" fallback for a doctor with no price set, now run through the same
        // currency-aware conversion as everywhere else instead of being a bare number.
        const docFeeMinor = toMinorUnits(doctorForFee.price ?? '60', currency);

        // Pass 5: same check as the authenticated path — must run before the insert,
        // inside this transaction. See assertSlotAvailable above.
        await assertSlotAvailable(tx, doctorIdForUnauth, patientInfo.scheduleDate, patientInfo.scheduleTime);

        const appointment = await tx.appointments.create({
            data: patientInfo,
        });
        const { paymentMethod, paymentType } = payment;
        const bookingFeeMinor = toMinorUnits(10, currency);
        const vatMinor = Math.round(0.15 * (docFeeMinor + bookingFeeMinor));
        // BUG FIX (Pass 7): same totalAmount fix as the authenticated path — previously
        // omitted bookingFee.
        const totalAmountMinor = docFeeMinor + bookingFeeMinor + vatMinor;
        let createdPayment: Payment | null = null;
        if (appointment.id) {
            createdPayment = await tx.payment.create({
                data: {
                    appointmentId: appointment.id,
                    bookingFee: bookingFeeMinor,
                    paymentMethod: paymentMethod,
                    paymentType: paymentType,
                    vat: vatMinor,
                    DoctorFee: docFeeMinor,
                    totalAmount: totalAmountMinor,
                    status: PaymentStatus.PENDING,
                    provider: getProviderForCurrency(currency).name,
                    currency: currency,
                }
            })
        }

        const appointmentObj = {
            created: moment(appointment.createdAt).format('LL'),
            trackingId: appointment.trackingId,
            patientType: appointment.patientType,
            status: appointment.status,
            paymentStatus: appointment.paymentStatus,
            prescriptionStatus: appointment.prescriptionStatus,
            scheduleDate:moment(appointment.scheduleDate).format('LL'),
            scheduleTime:appointment.scheduleTime,
        }
        const pathName = path.join(__dirname, '../../../../template/meeting.html')
        const replacementObj = appointmentObj;
        const subject = `Appointment Confirm at ${appointment.scheduleDate} ${appointment.scheduleTime}`

        const toMail = `${appointment.email}`;
        // Pass 6: same reasoning as the authenticated path above — email failure must
        // never crash the process or block the booking.
        EmailtTransporter({ pathName, replacementObj, toMail, subject }).catch((err) => console.error('Failed to send guest appointment confirmation email:', err));
        const appointmentWithPayment = { ...appointment, payment: createdPayment };
        await recordIdempotentResponse(tx, idempotencyKey, appointmentWithPayment);
        return appointmentWithPayment;
    })

    // Pass 7: see the identical comment in createAppointment above — gateway order
    // creation happens after commit, is idempotent, and a failure here doesn't lose the
    // underlying booking.
    if (result?.payment?.id) {
        try {
            const checkout = await PaymentService.createProviderOrderForPayment(result.payment.id);
            result.checkout = checkout;
        } catch (error) {
            console.error('Failed to create payment gateway order for guest appointment', result.id, error);
        }
    }
    return result;
}

const getAllAppointments = async (): Promise<Appointments[] | null> => {
    const result = await prisma.appointments.findMany();
    return result;
}

// Pass 15 — Tracking & Public Access. Was completely unauthenticated (Pass 4 flagged
// and deferred this exact gap — see the routing comment in appointment.route.ts) and
// returned the FULL raw appointment row, including `doctor: true, patient: true` (every
// column on both — address, phone, DOB, everything) to anyone who supplied any
// appointment id, guessable or not. Genuinely used by two authenticated doctor-dashboard
// pages (ViewAppointment.jsx, Treatment.jsx) that have a real logged-in user and just
// need their own appointment's detail — now requires auth + ownership like every other
// per-record endpoint in this app. The one legitimate unauthenticated use this endpoint
// used to also serve — BookingSuccess.jsx's guest post-booking confirmation — is moved
// to the trackingId-keyed lookup below, which is what it should have been all along (see
// shared/trackingId.ts).
const getAppointment = async (reqUser: any, id: string): Promise<Appointments | null> => {
    const result = await prisma.appointments.findUnique({
        where: {
            id: id
        },
        include: {
            doctor: true,
            patient: true
        }
    });
    if (!result) {
        return null;
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = result.patientId === reqUser?.userId || result.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this appointment !!');
    }
    return result;
}

// Pass 15 — Tracking & Public Access. This IS the intentional public, unauthenticated
// lookup — trackingId is now a real random token (shared/trackingId.ts), not a
// name+date+counter format that was guessable/enumerable, so this being reachable
// without login is the correct, secure design, not a gap. Explicit top-level `select`
// added (previously bare `findUnique` with no select — every scalar column on
// Appointments, including internal-only fields like statusChangedBy, was implicitly
// public and would silently stay that way for any future column added to the table).
// This list is the deliberately-chosen public surface for "check my appointment status"
// — nothing more.
const getAppointmentByTrackingId = async (data: any): Promise<Appointments | null> => {
    const { id } = data;

    const result = await prisma.appointments.findUnique({
        where: {
            trackingId: id
        },
        select: {
            id: true,
            trackingId: true,
            status: true,
            paymentStatus: true,
            prescriptionStatus: true,
            scheduleDate: true,
            scheduleTime: true,
            reasonForVisit: true,
            description: true,
            email: true,
            phone: true,
            createdAt: true,
            doctor: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true,
                    college: true,
                    degree: true,
                    img: true,
                    specialization: true,
                    clinicName: true,
                    clinicAddress: true,
                    city: true,
                    country: true,
                },
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true,
                    img: true
                }
            }
        }
    }) as any;
    return result;
}

const getPatientAppointmentById = async (user: any): Promise<Appointments[] | null> => {
    const { userId } = user;
    const isPatient = await prisma.patient.findUnique({
        where: {
            id: userId
        }
    })
    if (!isPatient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!')
    }
    const result = await prisma.appointments.findMany({
        where: {
            patientId: userId
        },
        include: {
            doctor: true
        }
    })
    return result;
}

// Pass 14: getPaymentInfoViaAppintmentId / getPatientPaymentInfo / getDoctorInvoices
// removed from here — see the removal note on the routes in appointment.route.ts.
// Superseded by api/src/app/modules/invoice/invoice.service.ts's
// getInvoiceByAppointmentId / getPatientInvoices / getDoctorInvoices.

const deleteAppointment = async (id: string): Promise<any> => {
    const result = await prisma.appointments.delete({
        where: {
            id: id
        }
    });
    return result;
}

// Pass 9: shared with cancelAppointment/rescheduleAppointment below — same template and
// replacementObj shape used since Pass 6/7's booking-confirmation email (the template
// already renders {{status}} dynamically, so it doubles as a generic "here's your
// appointment's current state" notice without needing a second HTML file). Best-effort,
// non-blocking — see the Pass 6 .catch() reasoning at every call site.
const sendAppointmentStatusEmail = (appointment: any, subject: string, logLabel: string) => {
    const pathName = path.join(__dirname, '../../../../template/appointment.html');
    const replacementObj = {
        created: moment(appointment.createdAt).format('LL'),
        trackingId: appointment.trackingId,
        patientType: appointment.patientType,
        status: appointment.status,
        paymentStatus: appointment.paymentStatus,
        prescriptionStatus: appointment.prescriptionStatus,
        scheduleDate: moment(appointment.scheduleDate).format('LL'),
        scheduleTime: appointment.scheduleTime,
        doctorImg: appointment?.doctor?.img,
        doctorFirstName: appointment?.doctor?.firstName,
        doctorLastName: appointment?.doctor?.lastName,
        specialization: appointment?.doctor?.specialization,
        designation: appointment?.doctor?.designation,
        college: appointment?.doctor?.college,
        patientImg: appointment?.patient?.img,
        patientfirstName: appointment?.patient?.firstName,
        patientLastName: appointment?.patient?.lastName,
        dateOfBirth: appointment?.patient?.dateOfBirth ? moment().diff(moment(appointment.patient.dateOfBirth), 'years') : undefined,
        bloodGroup: appointment?.patient?.bloodGroup,
        city: appointment?.patient?.city,
        state: appointment?.patient?.state,
        country: appointment?.patient?.country
    };
    const toMail = [appointment.email, appointment?.doctor?.email].filter(Boolean).join(',');
    if (!toMail) return;
    EmailtTransporter({ pathName, replacementObj, toMail, subject }).catch((err) => console.error(`Failed to send ${logLabel} email:`, err));
}

// Pass 9 — Cancellation & Rescheduling.
//
// Which target status a cancel action resolves to, by actor role and the appointment's
// CURRENT status. A patient withdrawing a still-PENDING request is CANCELLED_BY_PATIENT
// (not DECLINED — that specifically means the doctor rejected it); a doctor or admin
// acting on a PENDING request is DECLINED either way, since "the request will not
// proceed" reads the same regardless of which of the two declined it, and the actor is
// still recorded via statusChangedBy/AuditLog. This is what lets the frontend expose a
// single "Cancel" action per role without the caller needing to know the exact target
// enum value — see appointment-state-machine.ts for the transition legality itself.
const CANCEL_TARGET_BY_ROLE: Record<string, Partial<Record<AppointmentStatus, AppointmentStatus>>> = {
    patient: { PENDING: 'CANCELLED_BY_PATIENT', SCHEDULED: 'CANCELLED_BY_PATIENT' },
    doctor: { PENDING: 'DECLINED', SCHEDULED: 'CANCELLED_BY_DOCTOR' },
    admin: { PENDING: 'DECLINED', SCHEDULED: 'CANCELLED_BY_ADMIN' },
};

const cancelAppointment = async (reqUser: any, id: string, reason?: string): Promise<any> => {
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to cancel this appointment !!');
    }

    const roleKey = (reqUser?.role ?? '') as 'patient' | 'doctor' | 'admin';
    const targetStatus = CANCEL_TARGET_BY_ROLE[roleKey]?.[appointment.status as AppointmentStatus];
    if (!targetStatus) {
        throw new ApiError(httpStatus.CONFLICT, `An appointment in ${appointment.status} status cannot be cancelled.`);
    }
    // Belt-and-suspenders — CANCEL_TARGET_BY_ROLE above should already only ever produce
    // legal, authorized targets, but this is the same source-of-truth check every other
    // transition in the app goes through; a duplicated safety net here costs nothing.
    assertValidAppointmentTransition(appointment.status as AppointmentStatus, targetStatus, roleKey);

    // Cancellation cutoff / refund-eligibility policy (config.cancellation — see
    // config/index.ts; these are defaults to confirm with whoever owns pricing policy,
    // not a researched business decision). Only relevant if a payment actually succeeded
    // — a PENDING/FAILED/never-attempted payment has nothing to refund.
    const payment = await prisma.payment.findFirst({ where: { appointmentId: id }, orderBy: { createdAt: 'desc' } });
    let refundPlan: { hoursUntilAppointment: number | null; refundPercent: number; refundAmountMinor: number } | null = null;
    if (payment && payment.status === PaymentStatus.SUCCEEDED) {
        const dateOnly = moment(appointment.scheduleDate);
        const timeOnly = moment(appointment.scheduleTime, ['hh:mm a', 'HH:mm']);
        const scheduledMoment = dateOnly.isValid() && timeOnly.isValid()
            ? dateOnly.clone().set({ hour: timeOnly.hour(), minute: timeOnly.minute() })
            : null;
        const hoursUntilAppointment = scheduledMoment ? scheduledMoment.diff(moment(), 'hours', true) : null;
        // Unparseable date/time is treated as "late" (safer default than assuming
        // on-time and over-refunding on bad data) rather than throwing — a cancellation
        // should never be blocked by a data-quality issue in an unrelated field.
        const isOnTime = hoursUntilAppointment !== null && hoursUntilAppointment >= config.cancellation.cutoffHours;
        const refundPercent = isOnTime ? config.cancellation.onTimeRefundPercent : config.cancellation.lateRefundPercent;
        const refundAmountMinor = Math.round(payment.totalAmount * (refundPercent / 100));
        refundPlan = { hoursUntilAppointment, refundPercent, refundAmountMinor };
    }

    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.appointments.update({
            where: { id },
            data: {
                status: targetStatus,
                statusChangedAt: new Date(),
                statusChangedBy: reqUser?.userId,
                statusChangeReason: reason,
            },
            include: { doctor: true, patient: true }
        });
        // Pass 2's AuditLog, same pattern Pass 8 established — the refund plan (even a
        // 0%-eligible one) is recorded here regardless of whether the actual gateway
        // refund call below succeeds, so there's always a durable record of what SHOULD
        // have happened, not just what did.
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'appointment.cancelled',
                entityType: 'Appointments',
                entityId: id,
                metadata: { from: appointment.status, to: targetStatus, reason: reason ?? null, refundPlan },
            }
        });
        // Pass 14: a cancelled/declined appointment's invoice (if it had one — only
        // ever true if it had reached SCHEDULED) is no longer a valid live document for
        // an appointment that isn't happening. Voiding here does NOT itself refund
        // money — that's the separate gateway refund call below, against the same
        // underlying Payment either way.
        await InvoiceService.voidInvoiceForAppointment(tx, id, `Appointment ${targetStatus}`, reqUser?.userId, reqUser?.role);
        // Slot release: no separate action needed. assertSlotAvailable (Pass 5/8) already
        // excludes every cancel/decline-shaped status when counting a slot's capacity —
        // the moment this transaction commits, the slot is free for a new booking.
        return updated;
    });

    // Pass 7's reasoning applies here too: the actual gateway refund call happens AFTER
    // the transaction commits, not inside it (external HTTP call, same anti-pattern to
    // avoid). The appointment IS cancelled regardless of whether the refund call below
    // succeeds — a failed refund is a billing follow-up, not a reason to fail the
    // cancellation the patient/doctor/admin already validly requested.
    let refundResult: Payment | null = null;
    if (payment && refundPlan && refundPlan.refundAmountMinor > 0) {
        try {
            refundResult = await PaymentService.processRefund(payment.id, refundPlan.refundAmountMinor, reason ?? 'Appointment cancelled');
        } catch (error) {
            console.error('Refund failed during cancellation for appointment', id, error);
        }
    }

    sendAppointmentStatusEmail(
        result,
        `Appointment ${targetStatus === 'DECLINED' ? 'Declined' : 'Cancelled'} — Dr ${result?.doctor?.firstName} ${result?.doctor?.lastName}`,
        'cancellation'
    );

    return { ...result, refund: refundResult ?? refundPlan };
}

const rescheduleAppointment = async (reqUser: any, id: string, newScheduleDate: string, newScheduleTime: string, reason?: string): Promise<any> => {
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to reschedule this appointment !!');
    }
    if (!newScheduleDate || !newScheduleTime) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'newScheduleDate and newScheduleTime are required !!');
    }
    if (appointment.status !== 'PENDING' && appointment.status !== 'SCHEDULED') {
        throw new ApiError(httpStatus.CONFLICT, `An appointment in ${appointment.status} status cannot be rescheduled.`);
    }
    if (!appointment.doctorId) {
        throw new ApiError(httpStatus.CONFLICT, 'This appointment has no assigned doctor to check availability against !!');
    }

    // Pass 9 policy decision, documented in docs/passes/09-cancellation-rescheduling.md:
    // a PATIENT rescheduling an already-SCHEDULED appointment resets it to PENDING,
    // requiring the doctor to re-confirm the new time — the doctor agreed to the
    // *original* slot, not automatically to whatever the patient picks next. A doctor or
    // admin rescheduling keeps the current status, since their own action already implies
    // consent.
    const resultingStatus: AppointmentStatus = (reqUser?.role === 'patient' && appointment.status === 'SCHEDULED')
        ? 'PENDING'
        : (appointment.status as AppointmentStatus);

    const result = await runBookingTransaction(async (tx) => {
        // Reuses Pass 5's exact capacity/validity check and Serializable-isolation
        // protection against a race for the NEW slot — "rescheduling conflicts" is the
        // same problem booking-time slot conflicts are, just against a different current
        // row instead of a fresh insert.
        await assertSlotAvailable(tx, appointment.doctorId as string, newScheduleDate, newScheduleTime);

        const updated = await tx.appointments.update({
            where: { id },
            data: {
                scheduleDate: newScheduleDate,
                scheduleTime: newScheduleTime,
                status: resultingStatus,
                statusChangedAt: new Date(),
                statusChangedBy: reqUser?.userId,
                statusChangeReason: reason,
            },
            include: { doctor: true, patient: true }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'appointment.rescheduled',
                entityType: 'Appointments',
                entityId: id,
                metadata: {
                    oldDate: appointment.scheduleDate, oldTime: appointment.scheduleTime,
                    newDate: newScheduleDate, newTime: newScheduleTime,
                    statusBefore: appointment.status, statusAfter: resultingStatus,
                    reason: reason ?? null,
                },
            }
        });
        // Pass 14: a patient reschedule that resets SCHEDULED back to PENDING means the
        // doctor's original acceptance (and the invoice generated for it) no longer
        // holds — the doctor has to re-confirm the new time before a new invoice is
        // generated (see generateInvoiceForAppointment, triggered the next time this
        // appointment reaches SCHEDULED again). A doctor/admin reschedule keeps the
        // current status (their own action already implies consent), so there's nothing
        // to void in that case.
        if (resultingStatus === 'PENDING' && appointment.status === 'SCHEDULED') {
            await InvoiceService.voidInvoiceForAppointment(tx, id, 'Appointment rescheduled to a new time pending doctor confirmation', reqUser?.userId, reqUser?.role);
        }
        return updated;
    });

    sendAppointmentStatusEmail(
        result,
        `Appointment Rescheduled — Dr ${result?.doctor?.firstName} ${result?.doctor?.lastName}`,
        'reschedule'
    );

    return result;
}

const updateAppointment = async (reqUser: any, id: string, payload: Partial<Appointments> & { reason?: string }): Promise<Appointments> => {
    // Pass 4: previously no ownership check, and the full request body was passed
    // straight to Prisma (mass-assignment) — any authenticated patient/doctor could PATCH
    // ANY appointment with arbitrary fields (paymentStatus, doctorId, etc.), not just
    // their own. Confirmed via the frontend that every real caller (doctor Accept/Cancel
    // buttons, admin panel) only ever sends `{ status }`, so restricting to that field
    // doesn't break anything live.
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this appointment !!');
    }
    if (!payload.status) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'status is required !!');
    }
    // Pass 9: cancel-type transitions must go through cancelAppointment, not this generic
    // endpoint — cancellation always needs cutoff/refund-eligibility logic computed
    // (see appointment-state-machine.ts and cancelAppointment below), and routing every
    // cancel-shaped status through one function is what guarantees that logic can never
    // be silently bypassed by a frontend call site that forgot to use the dedicated
    // endpoint. This endpoint still handles SCHEDULED/COMPLETED/NO_SHOW, which have no
    // refund implications.
    const CANCEL_TYPE_STATUSES: AppointmentStatus[] = ['DECLINED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN'];
    if (CANCEL_TYPE_STATUSES.includes(payload.status as AppointmentStatus)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Use POST /appointment/:id/cancel to cancel or decline an appointment !!');
    }
    // Pass 8: the actual transition-legality + authorization check — who can move this
    // appointment from its CURRENT status (read fresh above, not client-supplied) to the
    // requested one. See appointment-state-machine.ts.
    assertValidAppointmentTransition(appointment.status as AppointmentStatus, payload.status as AppointmentStatus, reqUser?.role);

    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.appointments.update({
            data: {
                status: payload.status,
                statusChangedAt: new Date(),
                statusChangedBy: reqUser?.userId,
                statusChangeReason: payload.reason,
            },
            where: {
                id: id
            }
        });
        // Pass 2 built this table; Pass 8 is its first real writer — appointment status
        // transitions are exactly the kind of business event Pass 1's invariant #3
        // ("status changes only happen through defined transitions") calls for a durable
        // record of, beyond the fast "latest transition" snapshot fields above.
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'appointment.status_changed',
                entityType: 'Appointments',
                entityId: id,
                metadata: { from: appointment.status, to: payload.status, reason: payload.reason ?? null },
            }
        });
        // Pass 14 — Invoice & Financial Records: an invoice is generated the moment a
        // booking is confirmed (PENDING→SCHEDULED is the only edge that reaches
        // SCHEDULED — see appointment-state-machine.ts), inside this same transaction so
        // it can never commit the status change without the invoice or vice versa.
        if (payload.status === 'SCHEDULED') {
            await InvoiceService.generateInvoiceForAppointment(tx, id, reqUser?.userId);
        }
        return updated;
    });
    return result;
}

//doctor Side
const getDoctorAppointmentsById = async (user: any, filter: any): Promise<Appointments[] | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) { throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!') }

    let andCondition: any = { doctorId: userId };

    if (filter.sortBy == 'today') {
        const today = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const tomorrow = moment(today).add(1, 'days').format('YYYY-MM-DD HH:mm:ss');

        andCondition.scheduleDate = {
            gte: today,
            lt: tomorrow
        }
    }
    if (filter.sortBy == 'upcoming') {
        const upcomingDate = moment().startOf('day').add(1, 'days').format('YYYY-MM-DD HH:mm:ss')
        andCondition.scheduleDate = {
            gte: upcomingDate
        }
    }
    const whereConditions = andCondition ? andCondition : {}

    const result = await prisma.appointments.findMany({
        where: whereConditions,
        include: {
            patient: true,
            prescription: {
                select: {
                    id: true
                }
            }
        }
    });
    return result;
}

const getDoctorPatients = async (user: any): Promise<Patient[]> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }

    const patients = await prisma.appointments.findMany({
        where: {
            doctorId: userId
        },
        distinct: ['patientId']
    });

    //extract patients from the appointments table
    const patientIds = patients.map(appointment => appointment.patientId);
    const patientList = await prisma.patient.findMany({
        where: {
            id: {
                // @ts-ignore
                in: patientIds
            }
        }
    })
    return patientList;
}

const updateAppointmentByDoctor = async (user: any, payload: Partial<Appointments> & { id?: string }): Promise<Appointments | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    if (!payload.id) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Appointment id is required !!')
    }
    // Pass 4: previously verified the caller was *a* doctor but never that the target
    // appointment belonged to *that* doctor — any doctor could update any other doctor's
    // appointments. Also restricted the update to a safe field set instead of accepting
    // the full Partial<Appointments> body (mass-assignment).
    const appointment = await prisma.appointments.findUnique({ where: { id: payload.id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    if (appointment.doctorId !== userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this appointment !!');
    }
    const { status, prescriptionStatus, description, reasonForVisit } = payload;
    if (status) {
        // Pass 9: same cancel-must-use-dedicated-endpoint rule as updateAppointment.
        const CANCEL_TYPE_STATUSES: AppointmentStatus[] = ['DECLINED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN'];
        if (CANCEL_TYPE_STATUSES.includes(status as AppointmentStatus)) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Use POST /appointment/:id/cancel to cancel or decline an appointment !!');
        }
        // Pass 8: same transition validation as the generic updateAppointment path —
        // this endpoint is confirmed unused by the frontend today (Pass 4), but it's
        // still a live route, and "no arbitrary status updates" applies regardless of
        // which endpoint is used to attempt one.
        assertValidAppointmentTransition(appointment.status as AppointmentStatus, status as AppointmentStatus, 'doctor');
    }
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.appointments.update({
            where: {
                id: payload.id
            },
            data: {
                status,
                prescriptionStatus,
                description,
                reasonForVisit,
                ...(status ? { statusChangedAt: new Date(), statusChangedBy: userId } : {})
            }
        });
        if (status) {
            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    actorRole: 'doctor',
                    action: 'appointment.status_changed',
                    entityType: 'Appointments',
                    entityId: payload.id as string,
                    metadata: { from: appointment.status, to: status },
                }
            });
            // Pass 14: same invoice-generation hook as the generic updateAppointment
            // path above — this endpoint can legally reach SCHEDULED too, and the
            // invariant ("every appointment that becomes SCHEDULED gets an invoice")
            // has to hold regardless of which endpoint performed the transition.
            if (status === 'SCHEDULED') {
                await InvoiceService.generateInvoiceForAppointment(tx, payload.id as string, userId);
            }
        }
        return updated;
    });
    return result;
}

export const AppointmentService = {
    createAppointment,
    getAllAppointments,
    getAppointment,
    deleteAppointment,
    updateAppointment,
    cancelAppointment,
    rescheduleAppointment,
    getPatientAppointmentById,
    getDoctorAppointmentsById,
    updateAppointmentByDoctor,
    getDoctorPatients,
    createAppointmentByUnAuthenticateUser,
    getAppointmentByTrackingId
}