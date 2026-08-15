import { Appointments, Patient, Payment, paymentStatus, Prisma, PaymentStatus } from "@prisma/client";
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
            status: { not: 'cancel' }
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

        const previousAppointment = await tx.appointments.findFirst({
            orderBy: { createdAt: 'desc' },
            take: 1
        });
        const appointmentLastNumber = (previousAppointment?.trackingId ?? '').slice(-3);
        const lastDigit = (Number(appointmentLastNumber) + 1 || 0).toString().padStart(3, '0');

        // Trcking Id To be ==> First 3 Letter Of User  + current year + current month + current day + unique number (Matched Previous Appointment).
        const first3DigitName = patientInfo?.firstName?.slice(0, 3).toUpperCase();
        const year = moment().year();
        const month = (moment().month() + 1).toString().padStart(2, '0');
        const day = (moment().dayOfYear()).toString().padStart(2, '0');
        const trackingId = first3DigitName + year + month + day + lastDigit || '001';
        patientInfo['trackingId'] = trackingId;

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

        const previousAppointment = await tx.appointments.findFirst({
            orderBy: { createdAt: 'desc' },
            take: 1
        });

        const appointmentLastNumber = (previousAppointment?.trackingId ?? '').slice(-3);
        const lastDigit = (Number(appointmentLastNumber) + 1).toString().padStart(3, '0')
        // Trcking Id To be ==> UNU - 'Un Authenticate User  + current year + current month + current day + unique number (Matched Previous Appointment).
        const year = moment().year();
        const month = (moment().month() + 1).toString().padStart(2, '0');
        const day = (moment().dayOfYear()).toString().padStart(2, '0');
        const trackingId = 'UNU' + year + month + day + lastDigit || '0001';
        patientInfo['trackingId'] = trackingId;
        const doctorIdForUnauth = patientInfo.doctorId || config.defaultAdminDoctor;
        patientInfo['doctorId'] = doctorIdForUnauth;

        const doctorForFee = await tx.doctor.findUnique({ where: { id: doctorIdForUnauth } });
        if (!doctorForFee) {
            throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
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

const getAppointment = async (id: string): Promise<Appointments | null> => {
    const result = await prisma.appointments.findUnique({
        where: {
            id: id
        },
        include: {
            doctor: true,
            patient: true
        }
    });
    return result;
}

const getAppointmentByTrackingId = async (data: any): Promise<Appointments | null> => {
    const { id } = data;

    const result = await prisma.appointments.findUnique({
        where: {
            trackingId: id
        },
        include: {
            doctor: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true,
                    college: true,
                    degree: true,
                    img: true
                },
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true,
                    address: true,
                    city: true,
                    country: true,
                    state: true,
                    img: true
                }
            }
        }
    });
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

const getPaymentInfoViaAppintmentId = async (reqUser: any, id: string): Promise<any> => {
    // Pass 4: previously no ownership check — any authenticated patient or doctor could
    // view any OTHER appointment's payment/financial info by supplying an arbitrary id.
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this payment info !!');
    }
    const result = await prisma.payment.findFirst({
        where: {
            appointmentId: id
        },
        include: {
            appointment: {
                include: {
                    patient: {
                        select: {
                            firstName: true,
                            lastName: true,
                            address: true,
                            country: true,
                            city: true
                        }
                    },
                    doctor: {
                        select: {
                            firstName: true,
                            lastName: true,
                            address: true,
                            country: true,
                            city: true
                        }
                    }
                }
            }
        }
    });
    return result;
}

const getPatientPaymentInfo = async (user: any): Promise<Payment[]> => {
    const { userId } = user;
    const isUserExist = await prisma.patient.findUnique({
        where: { id: userId }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!')
    }
    const result = await prisma.payment.findMany({
        where: { appointment: { patientId: isUserExist.id } },
        include: {
            appointment: {
                include: {
                    doctor: {
                        select: {
                            firstName: true,
                            lastName: true,
                            designation: true
                        }
                    }
                }
            }
        }
    });
    return result;
}
const getDoctorInvoices = async (user: any): Promise<Payment[] | null> => {
    const { userId } = user;
    const isUserExist = await prisma.doctor.findUnique({
        where: { id: userId }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    const result = await prisma.payment.findMany({
        where: { appointment: { doctorId: isUserExist.id } },
        include: {
            appointment: {
                include: {
                    patient: {
                        select: {
                            firstName: true,
                            lastName: true
                        }
                    }
                }
            }
        }
    });
    return result;
}

const deleteAppointment = async (id: string): Promise<any> => {
    const result = await prisma.appointments.delete({
        where: {
            id: id
        }
    });
    return result;
}

const updateAppointment = async (reqUser: any, id: string, payload: Partial<Appointments>): Promise<Appointments> => {
    // Pass 4: previously no ownership check, and the full request body was passed
    // straight to Prisma (mass-assignment) — any authenticated patient/doctor could PATCH
    // ANY appointment with arbitrary fields (paymentStatus, doctorId, etc.), not just
    // their own. Confirmed via the frontend that every real caller (doctor Accept/Cancel
    // buttons, admin panel) only ever sends `{ status }`, so restricting to that field
    // doesn't break anything live. Full transition-legality rules (which status can
    // follow which) are Pass 8's job — this only controls WHO can act and WHAT field.
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this appointment !!');
    }
    const result = await prisma.appointments.update({
        data: { status: payload.status },
        where: {
            id: id
        }
    })
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
    const result = await prisma.appointments.update({
        where: {
            id: payload.id
        },
        data: { status, prescriptionStatus, description, reasonForVisit }
    })
    return result;
}

export const AppointmentService = {
    createAppointment,
    getAllAppointments,
    getAppointment,
    deleteAppointment,
    updateAppointment,
    getPatientAppointmentById,
    getDoctorAppointmentsById,
    updateAppointmentByDoctor,
    getDoctorPatients,
    getPaymentInfoViaAppintmentId,
    getPatientPaymentInfo,
    getDoctorInvoices,
    createAppointmentByUnAuthenticateUser,
    getAppointmentByTrackingId
}